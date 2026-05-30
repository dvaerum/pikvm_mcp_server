/**
 * Fetch random CC-licensed photos from Lorem Picsum (picsum.photos) for the
 * iPad-collector scene catalog.
 *
 * Usage:
 *   npx tsx scripts/fetch-backgrounds-picsum.ts \
 *     [--count N=500] [--out data/scene-backgrounds/picsum] \
 *     [--width 1640] [--height 2360] [--concurrency 8]
 *
 * Behavior:
 *   - Resumes by finding the highest existing picsum-NNNNN.jpg in --out and
 *     starting at next index. Skips files that already exist.
 *   - Appends rows to data/scene-backgrounds/manifest.jsonl (line-delimited).
 *   - Concurrency-limited (default 8). Per-image 15 s timeout. Failures logged
 *     and skipped — they do NOT count toward --count.
 *   - Progress: "[picsum] N/N (rate=X/s)" every 20 successful downloads.
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
}

interface ManifestRow {
  src: 'picsum';
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  license: 'CC0';
  fetched_at: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    count: 500,
    out: 'data/scene-backgrounds/picsum',
    width: 1640,
    height: 2360,
    concurrency: 8,
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
 * Download a URL to a temp path with a timeout. Follows redirects (picsum
 * 302s to fastly CDN). Returns the Buffer or null on any failure.
 */
async function downloadWithTimeout(url: string, timeoutMs: number): Promise<Buffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      console.error(`[picsum] HTTP ${res.status} for ${url}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[picsum] fetch error ${url}: ${msg}`);
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

interface Task {
  index: number;
  filename: string;
  targetPath: string;
  relPath: string;
  url: string;
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
          console.error(`[picsum] worker error: ${msg}`);
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

  const startIdx = await findNextIndex(outAbs, 'picsum');
  const tasks: Task[] = [];
  for (let n = 0; n < opts.count; n++) {
    const index = startIdx + n;
    const filename = `picsum-${pad5(index)}.jpg`;
    const targetPath = join(outAbs, filename);
    const relPath = `picsum/${filename}`;
    // Seed = numeric index so the URL is deterministic for that slot.
    const url = `https://picsum.photos/${opts.width}/${opts.height}?random=${index}`;
    tasks.push({ index, filename, targetPath, relPath, url });
  }

  console.log(`[picsum] target=${opts.count} dims=${opts.width}x${opts.height} startIdx=${startIdx} out=${outAbs}`);

  let done = 0;
  let okCount = 0;
  const t0 = Date.now();

  await runWithConcurrency(tasks, opts.concurrency, async (t) => {
    if (await fileExists(t.targetPath)) {
      done++;
      return;
    }
    const buf = await downloadWithTimeout(t.url, 15_000);
    done++;
    if (!buf) return;
    if (buf.length < 256) {
      console.error(`[picsum] suspiciously small (${buf.length}B) for ${t.url}; skipping`);
      return;
    }
    await writeAtomic(t.targetPath, buf);
    const row: ManifestRow = {
      src: 'picsum',
      path: t.relPath,
      url: t.url,
      sha256: sha256Hex(buf),
      bytes: buf.length,
      width: opts.width,
      height: opts.height,
      license: 'CC0',
      fetched_at: new Date().toISOString(),
    };
    await appendFile(manifestAbs, JSON.stringify(row) + '\n');
    okCount++;
    if (okCount % 20 === 0) {
      const dt = (Date.now() - t0) / 1000;
      const rate = dt > 0 ? (okCount / dt).toFixed(2) : '0.00';
      console.log(`[picsum] ${okCount}/${opts.count} (rate=${rate}/s)`);
    }
  });

  const dt = (Date.now() - t0) / 1000;
  const rate = dt > 0 ? (okCount / dt).toFixed(2) : '0.00';
  console.log(`[picsum] done ok=${okCount}/${opts.count} attempted=${done} elapsed=${dt.toFixed(1)}s rate=${rate}/s`);
  console.log(`[picsum] manifest: ${manifestAbs}`);
}

main().catch((e) => {
  console.error(`[picsum] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
