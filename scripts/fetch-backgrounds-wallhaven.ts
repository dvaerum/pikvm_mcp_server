/**
 * Fetch high-quality wallpapers from wallhaven.cc into the
 * scene-background catalog. Public JSON API, no auth required for SFW.
 *
 * Rate-limited by the upstream to 45 req/min (no key) — we pace at ~1
 * req/sec to stay comfortably below. 24 images per page.
 *
 *   npx tsx scripts/fetch-backgrounds-wallhaven.ts \
 *       [--count 5000] \
 *       [--out data/scene-backgrounds/wallhaven] \
 *       [--queries nature,abstract,city,space,architecture,art,minimal,landscape,texture] \
 *       [--concurrency 6]
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
const OUT_DIR = arg('--out', 'data/scene-backgrounds/wallhaven');
const CONCURRENCY = Number(arg('--concurrency', '6'));
const QUERIES = arg(
  '--queries',
  'nature,abstract,city,space,architecture,art,minimal,landscape,texture,sunset,forest,ocean,mountain,interior',
).split(',').map((s) => s.trim()).filter(Boolean);
const PURITY = '100';   // sfw only
const CATEGORIES = '110';  // general + anime (no people)
const MANIFEST = path.join(path.dirname(OUT_DIR), 'manifest.jsonl');
const PAGE_DELAY_MS = 1500;  // 40 req/min, under the 45/min cap

interface WhvnItem {
  id: string;
  path: string;
  url: string;
  purity: string;
  category: string;
  dimension_x: number;
  dimension_y: number;
  file_size: number;
  file_type: string;
}

async function existingMax(): Promise<number> {
  try {
    const entries = await fs.readdir(OUT_DIR);
    let max = 0;
    for (const e of entries) {
      const m = e.match(/^wallhaven-(\d+)\.jpg$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  } catch {
    return 0;
  }
}

async function searchPage(query: string, page: number): Promise<WhvnItem[]> {
  const url = `https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(query)}&page=${page}&purity=${PURITY}&categories=${CATEGORIES}&sorting=random`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`whvn search ${url} -> ${r.status}`);
  const j = await r.json() as { data: WhvnItem[] };
  return j.data ?? [];
}

async function downloadOne(item: WhvnItem, outPath: string): Promise<{ bytes: number; sha256: string }> {
  const r = await fetch(item.path, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${item.path} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = outPath + '.tmp';
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, outPath);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const startIdx = (await existingMax()) + 1;
  const perQuery = Math.ceil(COUNT / QUERIES.length);
  console.log(`[whvn] target=${COUNT} startIdx=${startIdx} perQuery=${perQuery} queries=[${QUERIES.join(', ')}]`);

  let nextIdx = startIdx;
  let saved = 0;
  let skipped = 0;
  const seenIds = new Set<string>();
  const manifestRows: string[] = [];
  const t0 = Date.now();

  // Per-query worker. Sequential within a query (pagination), parallel across queries via Promise.all.
  async function worker(query: string): Promise<void> {
    let page = 1;
    let perQueryCount = 0;
    while (perQueryCount < perQuery && saved < COUNT) {
      let items: WhvnItem[];
      try {
        items = await searchPage(query, page);
      } catch (e) {
        console.error(`[whvn] search "${query}" page ${page}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
        page++;
        if (page > 200) return;
        continue;
      }
      if (items.length === 0) {
        console.log(`[whvn] "${query}" exhausted at page ${page}`);
        return;
      }

      const dlPromises: Promise<void>[] = [];
      for (const item of items) {
        if (seenIds.has(item.id)) { skipped++; continue; }
        seenIds.add(item.id);
        if (perQueryCount >= perQuery || saved >= COUNT) break;
        perQueryCount++;
        const idx = nextIdx++;
        const filename = `wallhaven-${String(idx).padStart(5, '0')}.jpg`;
        const outPath = path.join(OUT_DIR, filename);
        dlPromises.push((async () => {
          try {
            const { bytes, sha256 } = await downloadOne(item, outPath);
            saved++;
            manifestRows.push(JSON.stringify({
              src: 'wallhaven',
              path: `wallhaven/${filename}`,
              url: item.path,
              wallhaven_id: item.id,
              wallhaven_url: item.url,
              sha256,
              bytes,
              width: item.dimension_x,
              height: item.dimension_y,
              license: 'wallhaven',
              query,
              fetched_at: new Date().toISOString(),
            }));
            if (saved % 25 === 0) {
              const elapsed = (Date.now() - t0) / 1000;
              console.log(`[whvn] ${saved}/${COUNT} (rate=${(saved / elapsed).toFixed(2)}/s)`);
            }
          } catch (e) {
            console.error(`[whvn] download ${item.id}: ${(e as Error).message}`);
            skipped++;
          }
        })());

        if (dlPromises.length >= CONCURRENCY) {
          await Promise.race(dlPromises);
          // drop settled
          for (let i = dlPromises.length - 1; i >= 0; i--) {
            const p = dlPromises[i] as Promise<void> & { _settled?: boolean };
            if (await Promise.race([p.then(() => true), Promise.resolve(false)])) {
              dlPromises.splice(i, 1);
            }
          }
        }
      }
      await Promise.all(dlPromises);
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      page++;
    }
  }

  // Run workers in parallel (one per query) but each respects PAGE_DELAY_MS,
  // so total request rate ≈ queries / PAGE_DELAY_MS req/sec.
  await Promise.all(QUERIES.map(worker));

  // Flush manifest rows
  if (manifestRows.length) {
    await fs.appendFile(MANIFEST, manifestRows.join('\n') + '\n');
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`[whvn] done ok=${saved}/${COUNT} skipped=${skipped} elapsed=${elapsed.toFixed(1)}s rate=${(saved / elapsed).toFixed(2)}/s`);
  console.log(`[whvn] manifest: ${path.resolve(MANIFEST)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
