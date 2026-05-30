/**
 * fetch-backgrounds-unsplash.ts
 *
 * Pull high-quality portrait photos from Unsplash for the iPad scene-background
 * catalog. Uses the free-tier Unsplash API (50 requests/hour); requires the
 * UNSPLASH_ACCESS_KEY env var. The script never hardcodes a key.
 *
 *   npx tsx scripts/fetch-backgrounds-unsplash.ts \
 *     [--count N=500] \
 *     [--out data/scene-backgrounds/unsplash] \
 *     [--queries nature,architecture,abstract,texture,art,city,landscape,interior]
 *
 * Behavior:
 *   - Resume-safe: skips existing files; picks next free unsplash-NNNNN.jpg index.
 *   - Balanced: count is split evenly across queries.
 *   - Rate-limited: tracks API request count; sleeps to the next hour boundary
 *     before hitting 50/hr.
 *   - Defensive writes via .tmp + rename.
 *   - Concurrency 4, per-image timeout 15 s.
 *   - Manifest row appended to data/scene-backgrounds/manifest.jsonl.
 *
 * No new npm deps — built-in fetch, node:fs/promises, node:crypto only.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// ---------- CLI parsing ----------

interface Args {
  count: number;
  out: string;
  queries: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    count: 500,
    out: 'data/scene-backgrounds/unsplash',
    queries: [
      'nature',
      'architecture',
      'abstract',
      'texture',
      'art',
      'city',
      'landscape',
      'interior',
    ],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--count' && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--count must be a positive integer, got ${next}`);
      }
      out.count = n;
      i++;
    } else if (a === '--out' && next !== undefined) {
      out.out = next;
      i++;
    } else if (a === '--queries' && next !== undefined) {
      out.queries = next
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (out.queries.length === 0) {
        throw new Error('--queries must list at least one term');
      }
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: npx tsx scripts/fetch-backgrounds-unsplash.ts [--count N] [--out DIR] [--queries a,b,c]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

// ---------- Unsplash types (only the fields we touch) ----------

interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  urls: {
    regular: string;
  };
  links?: {
    html?: string;
  };
  user: {
    name: string;
    links?: {
      html?: string;
    };
  };
}

// ---------- Rate-limit tracking ----------

const RATE_LIMIT_PER_HOUR = 50;
const RATE_LIMIT_SAFE_MAX = 49; // leave one in case we miscounted

class RateLimiter {
  private requests = 0;
  private windowStart = Date.now();

  async beforeRequest(): Promise<void> {
    if (this.requests >= RATE_LIMIT_SAFE_MAX) {
      const nextHour = this.windowStart + 60 * 60 * 1000;
      const waitMs = Math.max(0, nextHour - Date.now()) + 5_000;
      const waitMin = Math.ceil(waitMs / 60_000);
      console.log(`rate-limited — sleeping ${waitMin} min until next hour boundary`);
      await sleep(waitMs);
      this.requests = 0;
      this.windowStart = Date.now();
    }
    this.requests++;
  }

  spent(): number {
    return this.requests;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Filesystem helpers ----------

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function nextFreeIndex(outDir: string): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await readdir(outDir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const name of entries) {
    const m = /^unsplash-(\d{5})\.jpg$/.exec(name);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function indexToName(i: number): string {
  return `unsplash-${String(i).padStart(5, '0')}.jpg`;
}

async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// ---------- HTTP with timeout ----------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- Unsplash API ----------

async function fetchBatch(
  accessKey: string,
  query: string,
  count: number,
  rl: RateLimiter,
): Promise<UnsplashPhoto[]> {
  await rl.beforeRequest();
  const url =
    `https://api.unsplash.com/photos/random` +
    `?count=${encodeURIComponent(String(count))}` +
    `&query=${encodeURIComponent(query)}` +
    `&orientation=portrait`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        'Accept-Version': 'v1',
      },
    },
    15_000,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`unsplash /photos/random ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as UnsplashPhoto[] | UnsplashPhoto;
  // The endpoint returns an array when count>=1; defend against the single-object form.
  return Array.isArray(json) ? json : [json];
}

async function downloadImage(url: string): Promise<Uint8Array> {
  const res = await fetchWithTimeout(url, {}, 15_000);
  if (!res.ok) {
    throw new Error(`image download ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// ---------- Manifest ----------

interface ManifestRow {
  src: 'unsplash';
  path: string;
  url: string;
  photographer: string;
  photographer_url: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  license: 'Unsplash License';
  query: string;
  fetched_at: string;
}

async function appendManifest(manifestPath: string, row: ManifestRow): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await appendFile(manifestPath, JSON.stringify(row) + '\n');
}

// ---------- Concurrency pool ----------

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners: Promise<void>[] = [];
  for (let k = 0; k < Math.min(concurrency, items.length); k++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = i++;
          if (idx >= items.length) return;
          const item = items[idx]!;
          try {
            await worker(item);
          } catch (err) {
            console.error(`worker error: ${(err as Error).message}`);
          }
        }
      })(),
    );
  }
  await Promise.all(runners);
}

// ---------- Main ----------

async function main(): Promise<void> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey || accessKey.trim() === '') {
    console.error(
      'missing UNSPLASH_ACCESS_KEY — get a free key at https://unsplash.com/developers and re-run with the env var',
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  const manifestPath = resolve('data/scene-backgrounds/manifest.jsonl');
  await mkdir(outDir, { recursive: true });

  const perQuery = Math.ceil(args.count / args.queries.length);
  console.log(
    `target: ${args.count} images across ${args.queries.length} queries ` +
      `(~${perQuery}/query) → ${outDir}`,
  );

  const rl = new RateLimiter();
  let nextIdx = await nextFreeIndex(outDir);
  let totalSaved = 0;
  // Track which Unsplash photo IDs we've already grabbed this run to avoid
  // re-downloading duplicates returned by separate /random calls.
  const seenIds = new Set<string>();

  for (const query of args.queries) {
    if (totalSaved >= args.count) break;
    let savedForQuery = 0;
    console.log(`\n=== query: ${query} (target ${perQuery}) ===`);

    while (savedForQuery < perQuery && totalSaved < args.count) {
      const remainingForQuery = perQuery - savedForQuery;
      const batchSize = Math.min(30, remainingForQuery);

      let photos: UnsplashPhoto[];
      try {
        photos = await fetchBatch(accessKey, query, batchSize, rl);
      } catch (err) {
        console.error(`  batch failed: ${(err as Error).message}`);
        break;
      }

      // De-dupe within this run.
      const fresh = photos.filter((p) => !seenIds.has(p.id));
      for (const p of fresh) seenIds.add(p.id);
      if (fresh.length === 0) {
        console.log(`  no new photos in batch (all duplicates); moving on`);
        break;
      }

      // Assign filenames up front so the pool can run in parallel safely.
      const jobs = fresh.map((photo) => {
        const idx = nextIdx++;
        const name = indexToName(idx);
        return { photo, name, path: join(outDir, name) };
      });

      let savedThisBatch = 0;
      await runPool(jobs, 4, async ({ photo, name, path }) => {
        if (await fileExists(path)) {
          return;
        }
        const bytes = await downloadImage(photo.urls.regular);
        await writeFileAtomic(path, bytes);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const row: ManifestRow = {
          src: 'unsplash',
          path: join('data/scene-backgrounds/unsplash', name),
          url: photo.urls.regular,
          photographer: photo.user.name,
          photographer_url: photo.user.links?.html ?? '',
          sha256,
          bytes: bytes.byteLength,
          width: photo.width,
          height: photo.height,
          license: 'Unsplash License',
          query,
          fetched_at: new Date().toISOString(),
        };
        await appendManifest(manifestPath, row);
        savedThisBatch++;
      });

      savedForQuery += savedThisBatch;
      totalSaved += savedThisBatch;
      console.log(
        `  +${savedThisBatch} saved (query ${savedForQuery}/${perQuery}, ` +
          `total ${totalSaved}/${args.count}, api calls spent: ${rl.spent()})`,
      );

      if (savedThisBatch === 0) {
        // Nothing landed this batch — likely all existed on disk. Bail to next query.
        break;
      }
    }
  }

  console.log(`\ndone: ${totalSaved} new images saved`);
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
