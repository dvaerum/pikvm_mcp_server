/**
 * Fetch high-quality images from Wikimedia Commons into the
 * scene-background catalog. Free public API, no auth required.
 *
 * Uses category-based pagination via the MediaWiki API. Default sources
 * are Featured Pictures (~12k highest-quality) and Quality Images (~250k
 * well-curated). All Wikimedia Commons content is CC-licensed or PD.
 *
 *   npx tsx scripts/fetch-backgrounds-wikimedia.ts \
 *       [--count 5000] \
 *       [--out data/scene-backgrounds/wikimedia] \
 *       [--width 1640] \
 *       [--concurrency 8] \
 *       [--categories "Featured pictures on Wikimedia Commons,Quality images"]
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

const ARGS = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
}
const COUNT = Number(arg('--count', '5000'));
const OUT_DIR = arg('--out', 'data/scene-backgrounds/wikimedia');
const WIDTH = Number(arg('--width', '1640'));
const CONCURRENCY = Number(arg('--concurrency', '8'));
const CATEGORIES = arg(
  '--categories',
  'Featured pictures on Wikimedia Commons,Quality images',
).split(',').map((s) => s.trim()).filter(Boolean);
const MANIFEST = path.join(path.dirname(OUT_DIR), 'manifest.jsonl');
const API = 'https://commons.wikimedia.org/w/api.php';
const PAGE_DELAY_MS = 1100;  // ~50 req/min, well under Wikimedia's polite cap
const MAX_BYTES = 25_000_000;  // skip absurdly large originals; thumbnail is fine

interface MwImage {
  pageid: number;
  title: string;
  imageinfo: Array<{
    url: string;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    size: number;
    width: number;
    height: number;
    mime: string;
  }>;
}

async function existingMax(): Promise<number> {
  try {
    const entries = await fs.readdir(OUT_DIR);
    let max = 0;
    for (const e of entries) {
      const m = e.match(/^wikimedia-(\d+)\.jpg$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  } catch {
    return 0;
  }
}

interface CategoryCursor { token: string | null; done: boolean }

async function fetchPage(category: string, cont: string | null): Promise<{ images: MwImage[]; next: string | null }> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'categorymembers',
    gcmtitle: `Category:${category}`,
    gcmtype: 'file',
    gcmlimit: '50',
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: String(WIDTH),
    format: 'json',
    formatversion: '2',
  });
  if (cont) params.set('gcmcontinue', cont);
  const r = await fetch(`${API}?${params.toString()}`, {
    headers: { 'User-Agent': 'pikvm-mcp-server scene-catalog (https://github.com/)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`mw query -> ${r.status}`);
  const j = await r.json() as { query?: { pages?: MwImage[] }; continue?: { gcmcontinue?: string } };
  const images = j.query?.pages ?? [];
  const next = j.continue?.gcmcontinue ?? null;
  return { images, next };
}

async function downloadOne(url: string, outPath: string): Promise<{ bytes: number; sha256: string }> {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'pikvm-mcp-server scene-catalog (https://github.com/)' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = outPath + '.tmp';
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, outPath);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const startIdx = (await existingMax()) + 1;
  console.log(`[mw] target=${COUNT} startIdx=${startIdx} width=${WIDTH} categories=[${CATEGORIES.join(', ')}]`);

  let nextIdx = startIdx;
  let saved = 0;
  let skipped = 0;
  const seenIds = new Set<number>();
  const manifestRows: string[] = [];
  const t0 = Date.now();
  const cursors: Record<string, CategoryCursor> = Object.fromEntries(
    CATEGORIES.map((c) => [c, { token: null, done: false }]),
  );

  while (saved < COUNT) {
    // Round-robin one page from each non-exhausted category, then download
    // the resulting batch in parallel before moving on.
    const batch: { item: MwImage; url: string; category: string }[] = [];
    for (const category of CATEGORIES) {
      if (saved >= COUNT) break;
      const cur = cursors[category];
      if (cur.done) continue;
      let res;
      try {
        res = await fetchPage(category, cur.token);
      } catch (e) {
        console.error(`[mw] query "${category}": ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS * 2));
        continue;
      }
      cur.token = res.next;
      if (!res.next) cur.done = true;
      if (res.images.length === 0) {
        cur.done = true;
        continue;
      }
      for (const item of res.images) {
        if (seenIds.has(item.pageid)) { skipped++; continue; }
        const ii = item.imageinfo?.[0];
        if (!ii || !ii.mime?.startsWith('image/')) { skipped++; continue; }
        if (ii.size > MAX_BYTES && !ii.thumburl) { skipped++; continue; }
        const url = ii.thumburl ?? ii.url;
        if (!url) { skipped++; continue; }
        seenIds.add(item.pageid);
        batch.push({ item, url, category });
      }
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
    if (batch.length === 0 && CATEGORIES.every((c) => cursors[c].done)) {
      console.log('[mw] all categories exhausted');
      break;
    }

    // Concurrent downloads — semaphore-limited
    let inflight = 0;
    let cursor = 0;
    await new Promise<void>((resolve) => {
      const launch = () => {
        while (inflight < CONCURRENCY && cursor < batch.length && saved < COUNT) {
          const { item, url, category } = batch[cursor++];
          inflight++;
          const idx = nextIdx++;
          const filename = `wikimedia-${String(idx).padStart(5, '0')}.jpg`;
          const outPath = path.join(OUT_DIR, filename);
          (async () => {
            try {
              const ii = item.imageinfo[0];
              const { bytes, sha256 } = await downloadOne(url, outPath);
              saved++;
              manifestRows.push(JSON.stringify({
                src: 'wikimedia',
                path: `wikimedia/${filename}`,
                url,
                original_url: ii.url,
                wikimedia_page: `https://commons.wikimedia.org/?curid=${item.pageid}`,
                title: item.title,
                sha256,
                bytes,
                width: ii.thumbwidth ?? ii.width,
                height: ii.thumbheight ?? ii.height,
                license: 'CC/PD (per Commons)',
                category,
                fetched_at: new Date().toISOString(),
              }));
              if (saved % 25 === 0) {
                const elapsed = (Date.now() - t0) / 1000;
                console.log(`[mw] ${saved}/${COUNT} (rate=${(saved / elapsed).toFixed(2)}/s)`);
              }
            } catch (e) {
              console.error(`[mw] download ${item.title}: ${(e as Error).message}`);
              skipped++;
            } finally {
              inflight--;
              if (cursor >= batch.length && inflight === 0) resolve();
              else launch();
            }
          })();
        }
        if (cursor >= batch.length && inflight === 0) resolve();
      };
      launch();
    });
  }

  if (manifestRows.length) {
    await fs.appendFile(MANIFEST, manifestRows.join('\n') + '\n');
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`[mw] done ok=${saved}/${COUNT} skipped=${skipped} elapsed=${elapsed.toFixed(1)}s rate=${(saved / elapsed).toFixed(2)}/s`);
  console.log(`[mw] manifest: ${path.resolve(MANIFEST)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
