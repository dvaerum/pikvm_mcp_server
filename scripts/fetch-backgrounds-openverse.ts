/**
 * Fetch CC-licensed images from the Openverse API (api.openverse.org) for the
 * iPad-collector scene catalog. No API key required.
 *
 * Openverse anonymous-tier limits:
 *   - max page_size = 20
 *   - max pagination depth = 240 results per query
 *   - so each unique query term yields up to 240 image URLs
 *
 * Strategy: walk a list of broad scenery/wallpaper query terms, page each one
 * to depth 240, dedup by URL, then download. Pace ~1 req/s to be polite to
 * both the Openverse API and the underlying CDN (mostly live.staticflickr.com).
 *
 * Usage:
 *   npx tsx scripts/fetch-backgrounds-openverse.ts \
 *     [--count N=2700] [--out data/scene-backgrounds/openverse] \
 *     [--concurrency 4]
 *
 * Behavior:
 *   - Resumes by finding the highest existing openverse-NNNNN.jpg in --out
 *     and starting at next index.
 *   - Appends rows to data/scene-backgrounds/manifest.jsonl.
 *   - Skips URLs already present in manifest.jsonl (dedup by URL).
 *   - Atomic writes (.tmp + rename).
 *   - Per-image 20 s timeout. Failures logged and skipped.
 *   - Progress: "[openverse] N/N (rate=X/s)" every 25 successful downloads.
 *   - Backs off on HTTP 429 (sleeps 30 s, retries once).
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface CliOpts {
  count: number;
  out: string;
  concurrency: number;
}

interface ManifestRow {
  src: 'openverse';
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  license: string;
  fetched_at: string;
  // extra fields beyond the required set; harmless
  creator?: string;
  provider?: string;
  foreign_landing_url?: string;
}

interface OpenverseResult {
  id: string;
  title?: string;
  url: string;
  width: number;
  height: number;
  license: string;
  license_version?: string;
  creator?: string;
  provider?: string;
  foreign_landing_url?: string;
}

// Broad, generic query terms that should yield 240 results each on Openverse.
// Chosen to be visually diverse — landscapes, cities, abstract, textures, etc.
// 24 terms × 240 max = 5,760 candidate URLs before dedup; we target ~2,700.
const QUERIES = [
  'landscape', 'mountain', 'ocean', 'forest', 'desert',
  'sunset', 'sunrise', 'beach', 'sky', 'clouds',
  'city', 'architecture', 'flowers', 'autumn', 'winter',
  'spring', 'river', 'lake', 'waterfall', 'meadow',
  'canyon', 'island', 'jungle', 'snow', 'aurora',
  'galaxy', 'nebula', 'abstract', 'texture', 'pattern',
];

const API_BASE = 'https://api.openverse.org/v1/images/';
const PAGE_SIZE = 20;
const MAX_PAGES = 12; // 12 * 20 = 240 (anonymous cap)
const API_PACING_MS = 350; // per query worker; 4 workers => ~11 req/s peak
const API_QUERY_CONCURRENCY = 4;

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    count: 2700,
    out: 'data/scene-backgrounds/openverse',
    concurrency: 4,
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
      case '--concurrency': opts.concurrency = parseInt(next(), 10); break;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

async function loadExistingUrls(manifestPath: string): Promise<Set<string>> {
  const urls = new Set<string>();
  if (!existsSync(manifestPath)) return urls;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { url?: string };
        if (row.url) urls.add(row.url);
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // ignore
  }
  return urls;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[openverse] fetch error ${url}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadImage(url: string, timeoutMs: number): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res) return null;
    if (res.status === 429) {
      console.error(`[openverse] HTTP 429 for ${url}; sleeping 30 s`);
      await sleep(30_000);
      continue;
    }
    if (!res.ok) {
      console.error(`[openverse] HTTP ${res.status} for ${url}`);
      return null;
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) {
      console.error(`[openverse] non-image content-type ${ct} for ${url}`);
      return null;
    }
    try {
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[openverse] body read error ${url}: ${msg}`);
      return null;
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

interface Candidate {
  url: string;
  width: number;
  height: number;
  license: string;
  creator?: string;
  provider?: string;
  foreign_landing_url?: string;
}

/**
 * Walk all (query, page) combinations and collect deduped image candidates,
 * skipping any URL already present in the manifest. Stops early once enough
 * candidates accumulate.
 *
 * Concurrency model: API_QUERY_CONCURRENCY workers each take a query off a
 * queue and walk its 12 pages sequentially (each worker paces itself with
 * API_PACING_MS between pages). dedup is via shared Set under JS single-thread
 * invariants — concurrent appends to `out` are safe.
 */
async function collectCandidates(
  needed: number,
  existingUrls: Set<string>,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>(existingUrls);
  // Target ~2x needed to allow for download failures.
  const target = Math.ceil(needed * 1.6);
  let stop = false;

  let qCursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < API_QUERY_CONCURRENCY; w++) {
    workers.push((async () => {
      while (!stop) {
        const qi = qCursor++;
        if (qi >= QUERIES.length) return;
        const q = QUERIES[qi];
        if (q === undefined) return;
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (stop) return;
          const url = `${API_BASE}?q=${encodeURIComponent(q)}&page_size=${PAGE_SIZE}&page=${page}`;
          const res = await fetchWithTimeout(url, 15_000, {
            headers: { 'User-Agent': 'pikvm-mcp-scene-collector/1.0 (claude.ai@varum.dk)' },
          });
          if (!res) {
            await sleep(API_PACING_MS);
            continue;
          }
          if (res.status === 429) {
            console.error(`[openverse] API 429 on query=${q} page=${page}; sleep 30 s`);
            await sleep(30_000);
            page--; // retry
            continue;
          }
          if (!res.ok) {
            console.error(`[openverse] API HTTP ${res.status} on query=${q} page=${page}; skip rest of query`);
            break;
          }
          let data: { results?: OpenverseResult[] };
          try {
            data = await res.json() as { results?: OpenverseResult[] };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[openverse] JSON parse error on query=${q} page=${page}: ${msg}`);
            break;
          }
          const results = data.results || [];
          if (results.length === 0) break;
          let added = 0;
          for (const r of results) {
            if (!r.url || !r.url.startsWith('http')) continue;
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            out.push({
              url: r.url,
              width: r.width || 0,
              height: r.height || 0,
              license: r.license_version ? `${r.license}-${r.license_version}` : r.license,
              creator: r.creator,
              provider: r.provider,
              foreign_landing_url: r.foreign_landing_url,
            });
            added++;
            if (out.length >= target) {
              stop = true;
              break;
            }
          }
          if (added > 0) {
            console.log(`[openverse] query="${q}" page=${page} +${added} (cand=${out.length}/${target})`);
          }
          if (stop) return;
          await sleep(API_PACING_MS);
        }
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

async function runWithConcurrency<T>(
  tasks: T[],
  limit: number,
  worker: (t: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    runners.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= tasks.length) return;
        const t = tasks[idx];
        if (t === undefined) return;
        try {
          await worker(t);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[openverse] worker error: ${msg}`);
        }
      }
    })());
  }
  await Promise.all(runners);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const outAbs = resolve(opts.out);
  const manifestAbs = resolve(dirname(outAbs), 'manifest.jsonl');

  await mkdir(outAbs, { recursive: true });
  await mkdir(dirname(manifestAbs), { recursive: true });

  const existingUrls = await loadExistingUrls(manifestAbs);
  console.log(`[openverse] manifest has ${existingUrls.size} existing URLs (will skip dupes)`);

  const startIdx = await findNextIndex(outAbs, 'openverse');
  console.log(`[openverse] target=${opts.count} startIdx=${startIdx} out=${outAbs}`);

  console.log(`[openverse] collecting candidates from ${QUERIES.length} queries...`);
  const candidates = await collectCandidates(opts.count, existingUrls);
  console.log(`[openverse] collected ${candidates.length} unique candidate URLs`);

  if (candidates.length === 0) {
    console.log('[openverse] no candidates; exiting');
    return;
  }

  let nextIdx = startIdx;
  let done = 0;
  let okCount = 0;
  const t0 = Date.now();
  const idxLock = { v: nextIdx };

  await runWithConcurrency(candidates, opts.concurrency, async (c) => {
    if (okCount >= opts.count) return;
    const buf = await downloadImage(c.url, 20_000);
    done++;
    if (!buf) return;
    if (buf.length < 1024) {
      console.error(`[openverse] suspiciously small (${buf.length}B) for ${c.url}; skipping`);
      return;
    }
    // Allocate index atomically.
    const myIdx = idxLock.v++;
    const filename = `openverse-${pad5(myIdx)}.jpg`;
    const targetPath = join(outAbs, filename);
    const relPath = `openverse/${filename}`;
    if (await fileExists(targetPath)) {
      // Very unlikely collision; just skip.
      return;
    }
    await writeAtomic(targetPath, buf);
    const row: ManifestRow = {
      src: 'openverse',
      path: relPath,
      url: c.url,
      sha256: sha256Hex(buf),
      bytes: buf.length,
      width: c.width,
      height: c.height,
      license: c.license,
      fetched_at: new Date().toISOString(),
      ...(c.creator ? { creator: c.creator } : {}),
      ...(c.provider ? { provider: c.provider } : {}),
      ...(c.foreign_landing_url ? { foreign_landing_url: c.foreign_landing_url } : {}),
    };
    await appendFile(manifestAbs, JSON.stringify(row) + '\n');
    okCount++;
    if (okCount % 25 === 0) {
      const dt = (Date.now() - t0) / 1000;
      const rate = dt > 0 ? (okCount / dt).toFixed(2) : '0.00';
      console.log(`[openverse] ${okCount}/${opts.count} (rate=${rate}/s)`);
    }
  });

  const dt = (Date.now() - t0) / 1000;
  const rate = dt > 0 ? (okCount / dt).toFixed(2) : '0.00';
  console.log(`[openverse] done ok=${okCount}/${opts.count} attempted=${done} elapsed=${dt.toFixed(1)}s rate=${rate}/s`);
  console.log(`[openverse] manifest: ${manifestAbs}`);
}

main().catch((e) => {
  console.error(`[openverse] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
