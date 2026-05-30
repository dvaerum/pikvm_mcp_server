/**
 * Fetch iPad-aspect (portrait) UI/screenshot/mockup imagery from Wikimedia
 * Commons for the scene-background catalog.
 *
 *   npx tsx scripts/fetch-backgrounds-design-ipad.ts \
 *       [--count 1000] \
 *       [--out data/scene-backgrounds/design-ipad] \
 *       [--width 1640] \
 *       [--concurrency 8] \
 *       [--min-width 600]
 *
 * Why Wikimedia (not Dribbble/Behance/GitHub):
 *   - Dribbble's RSS endpoint returns 404 (deprecated). Public shot pages are
 *     JS-rendered.
 *   - Behance is JS-heavy; no auth-free JSON endpoint.
 *   - GitHub code search requires auth (401 without token).
 *   - Wikimedia search API returns thousands of "iPad screenshot/app/UI/home
 *     screen" hits via a single anonymous API with direct CDN URLs and
 *     width/height/mime per item. CC-licensed.
 *
 * Filters (portrait + ≥600px wide), atomic writes, resume-from-max, dedupes
 * pageid + sha256, appends to data/scene-backgrounds/manifest.jsonl.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

interface CliOpts {
  count: number;
  out: string;
  width: number;
  concurrency: number;
  minWidth: number;
}

interface ManifestRow {
  src: 'design-ipad';
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  license: string;
  source: string;
  fetched_at: string;
}

interface MwImageInfo {
  url: string;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  size: number;
  width: number;
  height: number;
  mime: string;
}

interface MwPage {
  pageid: number;
  title: string;
  imageinfo?: MwImageInfo[];
}

interface MwSearchResponse {
  query?: { pages?: Record<string, MwPage> | MwPage[] };
  continue?: { sroffset?: number };
}

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'pikvm-mcp-server scene-catalog design-ipad/1.0 (https://github.com/anthropics/claude-code; claude.ai@varum.dk)';
const PAGE_DELAY_MS = 600;
const DOWNLOAD_DELAY_MS = 250;   // sequential pacing to avoid upload.wikimedia.org 429s
const MAX_DOWNLOAD_RETRIES = 3;
const MAX_BYTES = 25_000_000;

// Diverse query terms to maximize unique iPad-aspect imagery. Ordered most
// targeted first; rotated round-robin to keep the corpus diverse.
// Tight iPad-only terms. Generic "portrait" / "tablet screenshot" pulled in
// personal photographs and Android UIs; dropped. Titles overwhelmingly
// contain "iPad" / "iOS" — confirmed via spot-check.
const QUERIES = [
  'iPad screenshot',
  'iPad home screen',
  'iPad app',
  'iPad UI',
  'iPad interface',
  'iPad mockup',
  'iPadOS',
  'iPad game',
  'iPad website',
  'iOS app iPad',
  'iPad Safari',
];

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    count: 1000,
    out: 'data/scene-backgrounds/design-ipad',
    width: 1640,
    concurrency: 8,
    minWidth: 600,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--count': opts.count = parseInt(next(), 10); break;
      case '--out': opts.out = next(); break;
      case '--width': opts.width = parseInt(next(), 10); break;
      case '--concurrency': opts.concurrency = parseInt(next(), 10); break;
      case '--min-width': opts.minWidth = parseInt(next(), 10); break;
      case '--help':
      case '-h':
        console.log('see file header for usage');
        process.exit(0);
        break;
      default:
        if (a !== undefined) throw new Error(`unknown arg: ${a}`);
    }
  }
  return opts;
}

function pad5(n: number): string {
  return n.toString().padStart(5, '0');
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function findNextIndex(outDir: string, prefix: string): Promise<number> {
  let max = 0;
  try {
    const entries = await readdir(outDir);
    const re = new RegExp(`^${prefix}-(\\d{5})\\.(jpg|png|webp)$`);
    for (const e of entries) {
      const m = e.match(re);
      if (m && m[1] !== undefined) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  } catch { /* dir absent */ }
  return max + 1;
}

async function fetchSearchPage(
  query: string,
  offset: number,
  thumbWidth: number,
): Promise<{ pages: MwPage[]; nextOffset: number | null }> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',        // File namespace
    gsrlimit: '50',
    gsroffset: String(offset),
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: String(thumbWidth),
  });
  const r = await fetch(`${API}?${params.toString()}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`mw search ${query}@${offset} -> ${r.status}`);
  const j = await r.json() as MwSearchResponse;
  const rawPages = j.query?.pages;
  const pages: MwPage[] = Array.isArray(rawPages)
    ? rawPages
    : rawPages ? Object.values(rawPages) : [];
  const nextOffset = j.continue?.sroffset ?? null;
  return { pages, nextOffset };
}

interface QueryCursor {
  query: string;
  offset: number;
  done: boolean;
}

async function downloadWithTimeout(url: string, timeoutMs: number): Promise<Buffer | null> {
  for (let attempt = 0; attempt < MAX_DOWNLOAD_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': UA },
      });
      if (res.status === 429 || res.status === 503) {
        const wait = 2_000 * (attempt + 1);
        console.error(`[design-ipad] HTTP ${res.status}; backoff ${wait}ms then retry (${attempt + 1}/${MAX_DOWNLOAD_RETRIES})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        console.error(`[design-ipad] HTTP ${res.status} for ${url}`);
        return null;
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[design-ipad] fetch error ${url}: ${msg}`);
      if (attempt + 1 < MAX_DOWNLOAD_RETRIES) {
        await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function writeAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function extForMime(mime: string, fallback: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return fallback;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const outAbs = resolve(opts.out);
  const manifestAbs = resolve(dirname(outAbs), 'manifest.jsonl');
  await mkdir(outAbs, { recursive: true });
  await mkdir(dirname(manifestAbs), { recursive: true });

  const startIdx = await findNextIndex(outAbs, 'design-ipad');
  console.log(`[design-ipad] target=${opts.count} startIdx=${startIdx} thumbWidth=${opts.width} minWidth=${opts.minWidth}`);
  console.log(`[design-ipad] queries=[${QUERIES.join(' | ')}]`);

  const cursors: QueryCursor[] = QUERIES.map((q) => ({ query: q, offset: 0, done: false }));
  const seenPageIds = new Set<number>();
  const seenSha = new Set<string>();
  const manifestBuffer: string[] = [];

  let nextIdx = startIdx;
  let saved = 0;
  let skippedTooSmall = 0;
  let skippedNotPortrait = 0;
  let skippedVideo = 0;
  let skippedDupe = 0;
  let skippedDownload = 0;
  const t0 = Date.now();

  while (saved < opts.count) {
    // Collect a batch of unique candidates by round-robining the queries.
    const batch: { page: MwPage; ii: MwImageInfo; url: string; query: string }[] = [];
    let anyAdvanced = false;
    for (const cur of cursors) {
      if (saved + batch.length >= opts.count) break;
      if (cur.done) continue;
      let res;
      try {
        res = await fetchSearchPage(cur.query, cur.offset, opts.width);
      } catch (e) {
        console.error(`[design-ipad] search "${cur.query}"@${cur.offset}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS * 3));
        continue;
      }
      anyAdvanced = true;
      if (res.nextOffset === null) cur.done = true; else cur.offset = res.nextOffset;
      if (res.pages.length === 0) { cur.done = true; continue; }
      for (const page of res.pages) {
        if (seenPageIds.has(page.pageid)) { skippedDupe++; continue; }
        seenPageIds.add(page.pageid);
        const ii = page.imageinfo?.[0];
        if (!ii) { skippedDownload++; continue; }
        if (!ii.mime?.startsWith('image/')) { skippedVideo++; continue; }
        if (ii.mime === 'image/svg+xml') { skippedVideo++; continue; }
        // Use thumb dims if a thumb URL was generated; original dims otherwise.
        const w = ii.thumbwidth ?? ii.width;
        const h = ii.thumbheight ?? ii.height;
        if (!w || !h) { skippedDownload++; continue; }
        if (w >= h) { skippedNotPortrait++; continue; }
        if (w < opts.minWidth) { skippedTooSmall++; continue; }
        if (ii.size > MAX_BYTES && !ii.thumburl) { skippedTooSmall++; continue; }
        const url = ii.thumburl ?? ii.url;
        if (!url) { skippedDownload++; continue; }
        batch.push({ page, ii, url, query: cur.query });
      }
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
    if (!anyAdvanced && cursors.every((c) => c.done)) {
      console.log('[design-ipad] all queries exhausted');
      break;
    }
    if (batch.length === 0) continue;

    // Sequential downloads with pacing. upload.wikimedia.org aggressively
    // 429s on concurrent fetches from one client; one-at-a-time with a small
    // delay keeps us under the radar and lets retries land.
    for (const item of batch) {
      if (saved >= opts.count) break;
      try {
        const buf = await downloadWithTimeout(item.url, 30_000);
        if (!buf) { skippedDownload++; continue; }
        if (buf.length < 1024) {
          console.error(`[design-ipad] suspiciously small ${buf.length}B for ${item.url}; skipping`);
          skippedDownload++;
          continue;
        }
        const sha = sha256Hex(buf);
        if (seenSha.has(sha)) { skippedDupe++; continue; }
        seenSha.add(sha);
        const ext = extForMime(item.ii.mime, 'jpg');
        const idx = nextIdx++;
        const filename = `design-ipad-${pad5(idx)}.${ext}`;
        const targetPath = join(outAbs, filename);
        if (await fileExists(targetPath)) {
          skippedDupe++;
          continue;
        }
        await writeAtomic(targetPath, buf);
        const row: ManifestRow = {
          src: 'design-ipad',
          path: `design-ipad/${filename}`,
          url: item.url,
          sha256: sha,
          bytes: buf.length,
          width: item.ii.thumbwidth ?? item.ii.width,
          height: item.ii.thumbheight ?? item.ii.height,
          license: 'CC/PD (per Commons)',
          source: `wikimedia:${item.query}|page=${item.page.pageid}|${item.page.title}`,
          fetched_at: new Date().toISOString(),
        };
        manifestBuffer.push(JSON.stringify(row));
        saved++;
        if (manifestBuffer.length >= 25) {
          const lines = manifestBuffer.splice(0, manifestBuffer.length).join('\n') + '\n';
          await appendFile(manifestAbs, lines);
        }
        if (saved % 25 === 0) {
          const dt = (Date.now() - t0) / 1000;
          console.log(`[design-ipad] ${saved}/${opts.count} (rate=${(saved / dt).toFixed(2)}/s skipped: portrait=${skippedNotPortrait} small=${skippedTooSmall} dupe=${skippedDupe} video/svg=${skippedVideo} dl=${skippedDownload})`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[design-ipad] download error: ${msg}`);
        skippedDownload++;
      }
      await new Promise((r) => setTimeout(r, DOWNLOAD_DELAY_MS));
    }
  }

  if (manifestBuffer.length) {
    await appendFile(manifestAbs, manifestBuffer.join('\n') + '\n');
  }

  const dt = (Date.now() - t0) / 1000;
  const rate = dt > 0 ? (saved / dt).toFixed(2) : '0.00';
  console.log(`[design-ipad] done ok=${saved}/${opts.count} elapsed=${dt.toFixed(1)}s rate=${rate}/s`);
  console.log(`[design-ipad] skipped: not-portrait=${skippedNotPortrait} too-small=${skippedTooSmall} dupe=${skippedDupe} video/svg=${skippedVideo} download=${skippedDownload}`);
  console.log(`[design-ipad] manifest: ${manifestAbs}`);
}

main().catch((e) => {
  console.error(`[design-ipad] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
