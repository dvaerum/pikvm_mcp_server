/**
 * Fetch iPad portrait UI screenshots from the App Store via Apple's
 * unauthenticated iTunes Search API for the scene-background catalog.
 *
 * Usage:
 *   npx tsx scripts/fetch-backgrounds-appstore-ipad.ts \
 *     [--count N=1500] [--out data/scene-backgrounds/appstore-ipad] \
 *     [--width 1640] [--height 2360] [--concurrency 8] \
 *     [--terms term1,term2,...]
 *
 * Behavior:
 *   - Iterates a list of diverse search terms; for each term hits
 *     https://itunes.apple.com/search?term=<t>&entity=software&country=us&limit=200
 *     paced at ~1 req/s. From every result we take every entry in
 *     `ipadScreenshotUrls` (Apple-served preview screenshots).
 *   - Rewrites each URL's trailing size segment to `<W>x<H>bb.jpg` so we
 *     get high-res, aspect-preserving portrait JPEGs.
 *   - Resumes from highest existing appstore-NNNNN.jpg in --out.
 *   - Concurrent downloads (default 8), per-image 20 s timeout. Failures
 *     are skipped and do not count toward --count.
 *   - URLs (post-rewrite) deduped within-run via a Set.
 *   - Appends rows to data/scene-backgrounds/manifest.jsonl with
 *     src="appstore-ipad" and license="appstore-preview".
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

interface CliOpts {
  count: number;
  out: string;
  width: number;
  height: number;
  concurrency: number;
  terms: string[];
}

interface ManifestRow {
  src: 'appstore-ipad';
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  license: 'appstore-preview';
  search_term: string;
  app_id: number;
  app_name: string;
  fetched_at: string;
}

interface ITunesResult {
  trackId?: number;
  trackName?: string;
  ipadScreenshotUrls?: string[];
}

interface ITunesResponse {
  resultCount?: number;
  results?: ITunesResult[];
}

const DEFAULT_TERMS = [
  'productivity', 'photography', 'drawing', 'painting', 'games', 'puzzle',
  'music', 'weather', 'news', 'social', 'finance', 'banking', 'education',
  'health', 'fitness', 'travel', 'food', 'recipes', 'kids', 'business',
  'books', 'reader', 'magazines', 'calculator', 'todo', 'calendar',
  'notes', 'mail', 'video', 'streaming', 'podcast', 'code', 'design',
  'art', 'science', 'maps', 'navigation', 'sketch', 'chat', 'meditation',
  'sleep', 'language', 'shopping', 'photo editor', 'journal', 'reminders',
  'budget', 'crypto', 'fishing',
];

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    count: 1500,
    out: 'data/scene-backgrounds/appstore-ipad',
    width: 1640,
    height: 2360,
    concurrency: 8,
    terms: DEFAULT_TERMS,
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
      case '--height': opts.height = parseInt(next(), 10); break;
      case '--concurrency': opts.concurrency = parseInt(next(), 10); break;
      case '--terms':
        opts.terms = next().split(',').map((s) => s.trim()).filter(Boolean);
        break;
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
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findNextIndex(outDir: string, prefix: string): Promise<number> {
  let max = 0;
  try {
    const entries = await readdir(outDir);
    const re = new RegExp(`^${prefix}-(\\d{5})\\.jpg$`);
    for (const e of entries) {
      const m = e.match(re);
      if (m && m[1] !== undefined) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  } catch {
    // dir doesn't exist; caller will mkdir
  }
  return max + 1;
}

/**
 * Apple's mzstatic CDN encodes the output size as the final path segment,
 * e.g. ".../1_IPAD_13.png/576x768bb.png". Rewriting that last segment to
 * "<W>x<H>bb.jpg" yields a JPEG bounded by the requested dimensions while
 * preserving the source aspect ratio (the "bb" flag = "bounding box").
 */
function rewriteImageUrl(url: string, width: number, height: number): string {
  const lastSlash = url.lastIndexOf('/');
  if (lastSlash < 0) return url;
  return `${url.slice(0, lastSlash)}/${width}x${height}bb.jpg`;
}

async function downloadWithTimeout(url: string, timeoutMs: number): Promise<Buffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      console.error(`[appstore] HTTP ${res.status} for ${url}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[appstore] fetch error ${url}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function writeAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Parse JPEG SOF0/SOF2 marker to extract width/height without a decoder dep.
 * Returns null if the buffer isn't a recognizable JPEG or the marker isn't
 * found within reasonable bounds.
 */
function parseJpegDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    // skip fill bytes
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) return null;
    const marker = buf[i++];
    if (marker === undefined) return null;
    // standalone markers without length
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= buf.length) return null;
    const segLen = buf.readUInt16BE(i);
    // SOF0..SOF15 except DHT(0xc4), DAC(0xcc), DNL(0xdc)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc && marker !== 0xc8;
    if (isSof) {
      if (i + 7 > buf.length) return null;
      const h = buf.readUInt16BE(i + 3);
      const w = buf.readUInt16BE(i + 5);
      return { width: w, height: h };
    }
    i += segLen;
  }
  return null;
}

interface DownloadTask {
  index: number;
  filename: string;
  targetPath: string;
  relPath: string;
  url: string;
  searchTerm: string;
  appId: number;
  appName: string;
}

async function runWithConcurrency<T>(
  tasks: T[],
  limit: number,
  worker: (t: T) => Promise<boolean>,
  stop: () => boolean,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    runners.push((async () => {
      while (true) {
        if (stop()) return;
        const idx = cursor++;
        if (idx >= tasks.length) return;
        const t = tasks[idx];
        if (t === undefined) return;
        try {
          await worker(t);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[appstore] worker error: ${msg}`);
        }
      }
    })());
  }
  await Promise.all(runners);
}

async function searchITunes(term: string): Promise<ITunesResult[]> {
  const u = new URL('https://itunes.apple.com/search');
  u.searchParams.set('term', term);
  u.searchParams.set('entity', 'software');
  u.searchParams.set('country', 'us');
  u.searchParams.set('limit', '200');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(u.toString(), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'pikvm-mcp-server scene-catalog' },
    });
    if (!res.ok) {
      console.error(`[appstore] search HTTP ${res.status} for term=${term}`);
      return [];
    }
    const j = (await res.json()) as ITunesResponse;
    return j.results ?? [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[appstore] search error term=${term}: ${msg}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const outAbs = resolve(opts.out);
  const manifestAbs = resolve(dirname(outAbs), 'manifest.jsonl');

  await mkdir(outAbs, { recursive: true });
  await mkdir(dirname(manifestAbs), { recursive: true });

  console.log(
    `[appstore] target=${opts.count} dims<=${opts.width}x${opts.height} ` +
    `terms=${opts.terms.length} out=${outAbs}`,
  );

  let nextIdx = await findNextIndex(outAbs, 'appstore');
  const seenUrls = new Set<string>();
  let okCount = 0;
  let attempted = 0;
  const t0 = Date.now();

  for (let ti = 0; ti < opts.terms.length; ti++) {
    if (okCount >= opts.count) break;
    const term = opts.terms[ti];
    if (term === undefined) continue;

    const results = await searchITunes(term);
    // Build the task batch for this term, deduping by rewritten URL.
    const tasks: DownloadTask[] = [];
    for (const r of results) {
      const urls = r.ipadScreenshotUrls ?? [];
      if (urls.length === 0) continue;
      const appId = r.trackId ?? 0;
      const appName = r.trackName ?? '';
      for (const rawUrl of urls) {
        const url = rewriteImageUrl(rawUrl, opts.width, opts.height);
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        const index = nextIdx++;
        const filename = `appstore-${pad5(index)}.jpg`;
        const targetPath = join(outAbs, filename);
        const relPath = `appstore-ipad/${filename}`;
        tasks.push({ index, filename, targetPath, relPath, url, searchTerm: term, appId, appName });
      }
    }

    console.log(
      `[appstore] term="${term}" (${ti + 1}/${opts.terms.length}) ` +
      `apps=${results.length} new_urls=${tasks.length} ` +
      `progress=${okCount}/${opts.count}`,
    );

    if (tasks.length > 0) {
      await runWithConcurrency(
        tasks,
        opts.concurrency,
        async (t) => {
          if (okCount >= opts.count) return false;
          if (await fileExists(t.targetPath)) {
            attempted++;
            return false;
          }
          const buf = await downloadWithTimeout(t.url, 20_000);
          attempted++;
          if (!buf) return false;
          if (buf.length < 1024) {
            console.error(`[appstore] suspiciously small (${buf.length}B) for ${t.url}; skipping`);
            return false;
          }
          const dims = parseJpegDims(buf);
          if (!dims) {
            console.error(`[appstore] could not decode JPEG header for ${t.url}; skipping`);
            return false;
          }
          // Reject obviously-wrong aspect (we want portrait iPad screenshots).
          if (dims.width > dims.height) {
            // landscape iPad screenshot — keep, it's still iPad UI, but log.
          }
          await writeAtomic(t.targetPath, buf);
          const row: ManifestRow = {
            src: 'appstore-ipad',
            path: t.relPath,
            url: t.url,
            sha256: sha256Hex(buf),
            bytes: buf.length,
            width: dims.width,
            height: dims.height,
            license: 'appstore-preview',
            search_term: t.searchTerm,
            app_id: t.appId,
            app_name: t.appName,
            fetched_at: new Date().toISOString(),
          };
          await appendFile(manifestAbs, JSON.stringify(row) + '\n');
          okCount++;
          if (okCount % 25 === 0) {
            const dt = (Date.now() - t0) / 1000;
            const rate = dt > 0 ? (okCount / dt).toFixed(2) : '0.00';
            console.log(`[appstore] ${okCount}/${opts.count} (rate=${rate}/s)`);
          }
          return true;
        },
        () => okCount >= opts.count,
      );
    }

    // Pace iTunes Search API at ~1 req/s (skip the pause after the last term).
    if (ti < opts.terms.length - 1 && okCount < opts.count) {
      await new Promise<void>((r) => setTimeout(r, 1_000));
    }
  }

  const dt = (Date.now() - t0) / 1000;
  const rate = dt > 0 ? (okCount / dt).toFixed(2) : '0.00';
  console.log(
    `[appstore] done ok=${okCount}/${opts.count} attempted=${attempted} ` +
    `unique_urls_seen=${seenUrls.size} elapsed=${dt.toFixed(1)}s rate=${rate}/s`,
  );
  console.log(`[appstore] manifest: ${manifestAbs}`);
}

main().catch((e) => {
  console.error(`[appstore] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
