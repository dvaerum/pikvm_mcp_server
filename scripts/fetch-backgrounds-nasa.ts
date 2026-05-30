/**
 * Fetch NASA APOD (Astronomy Picture of the Day) images for the iPad-collector
 * scene catalog.
 *
 * Usage:
 *   npx tsx scripts/fetch-backgrounds-nasa.ts \
 *     [--count N=500] [--out data/scene-backgrounds/nasa] \
 *     [--start-date 2000-01-01] [--concurrency 4]
 *
 * Behavior:
 *   - Resumes by finding highest existing nasa-NNNNN.jpg in --out.
 *   - Iterates calendar dates forward from --start-date. For each date fetches
 *     the APOD JSON. Skips media_type != "image" (videos, interactive). Prefers
 *     hdurl, falls back to url.
 *   - Stops after `count` successful image downloads OR after probing 2*count
 *     dates (some are videos), whichever comes first.
 *   - Appends rows to data/scene-backgrounds/manifest.jsonl.
 *   - Per-image timeout 30 s; concurrency default 4 (DEMO_KEY quota is tight).
 *   - Image dimensions are parsed from the JPEG SOF0/SOF2 markers (no deps).
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

interface CliOpts {
  count: number;
  out: string;
  startDate: string;
  concurrency: number;
}

interface ManifestRow {
  src: 'nasa';
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  license: 'public domain';
  fetched_at: string;
  date: string;
  title: string;
}

interface ApodResponse {
  date?: string;
  title?: string;
  media_type?: string;
  url?: string;
  hdurl?: string;
  explanation?: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    count: 500,
    out: 'data/scene-backgrounds/nasa',
    startDate: '2000-01-01',
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
      case '--start-date': opts.startDate = next(); break;
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.startDate)) {
    throw new Error(`--start-date must be YYYY-MM-DD, got ${opts.startDate}`);
  }
  return opts;
}

function pad5(n: number): string {
  return n.toString().padStart(5, '0');
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
    // dir doesn't exist
  }
  return max + 1;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[nasa] fetch error ${url}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBuffer(url: string, timeoutMs: number): Promise<Buffer | null> {
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res) return null;
  if (!res.ok) {
    console.error(`[nasa] HTTP ${res.status} for ${url}`);
    return null;
  }
  try {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[nasa] body read error ${url}: ${msg}`);
    return null;
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
 * Parse JPEG width/height from the SOFn marker. Returns null for non-JPEG or
 * malformed input. PNG fallback included since NASA occasionally serves PNG.
 */
function parseImageDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature then IHDR (width@16, height@20, big-endian).
  if (
    buf.length >= 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  // JPEG: starts with FF D8. Walk markers until an SOFn marker (C0..CF except
  // C4, C8, CC which are DHT/JPG/DAC), then read height (3 bytes in) and
  // width (5 bytes in) as big-endian uint16.
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) return null;
    // Skip fill bytes.
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) return null;
    const marker = buf[i++];
    if (marker === undefined) return null;
    if (marker === 0xd8 || marker === 0xd9) return null; // SOI/EOI w/o SOF
    if (marker >= 0xd0 && marker <= 0xd7) continue; // RSTn, no length
    if (i + 1 >= buf.length) return null;
    const segLen = buf.readUInt16BE(i);
    if (segLen < 2 || i + segLen > buf.length) return null;
    const isSof = (
      marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    );
    if (isSof) {
      // Segment layout: [len:2][precision:1][height:2][width:2]...
      if (i + 7 > buf.length) return null;
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    i += segLen;
  }
  return null;
}

interface ProbeResult {
  date: string;
  ok: boolean;
  reason?: string;
  apod?: ApodResponse;
  imageUrl?: string;
}

const NASA_BASE = 'https://api.nasa.gov/planetary/apod';

async function probeApod(date: string): Promise<ProbeResult> {
  const apiUrl = `${NASA_BASE}?api_key=DEMO_KEY&date=${date}`;
  const res = await fetchWithTimeout(apiUrl, 30_000);
  if (!res) return { date, ok: false, reason: 'network' };
  if (res.status === 404) return { date, ok: false, reason: 'no-apod' };
  if (!res.ok) {
    return { date, ok: false, reason: `http-${res.status}` };
  }
  let apod: ApodResponse;
  try {
    apod = (await res.json()) as ApodResponse;
  } catch {
    return { date, ok: false, reason: 'json-parse' };
  }
  if (apod.media_type !== 'image') {
    return { date, ok: false, reason: `media-${apod.media_type ?? 'unknown'}`, apod };
  }
  const imageUrl = apod.hdurl ?? apod.url;
  if (!imageUrl) return { date, ok: false, reason: 'no-url', apod };
  return { date, ok: true, apod, imageUrl };
}

/**
 * Sequential semaphore. Submit returns a promise that resolves once `fn` has
 * run under the concurrency cap.
 */
class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((r) => this.queue.push(r));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const outAbs = resolve(opts.out);
  const manifestAbs = resolve(dirname(outAbs), 'manifest.jsonl');
  await mkdir(outAbs, { recursive: true });
  await mkdir(dirname(manifestAbs), { recursive: true });

  let nextIdx = await findNextIndex(outAbs, 'nasa');
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[nasa] target=${opts.count} startDate=${opts.startDate} startIdx=${nextIdx} out=${outAbs}`);

  // Build the candidate date list up to 2*count dates (cap at today).
  const dates: string[] = [];
  let cursor = opts.startDate;
  for (let i = 0; i < opts.count * 2; i++) {
    if (cursor > today) break;
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const sem = new Semaphore(opts.concurrency);
  let okCount = 0;
  let probed = 0;
  const t0 = Date.now();
  // Mutex so index allocation + manifest append are serialised.
  let chainOk: Promise<void> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chainOk.then(fn);
    chainOk = p.then(() => undefined, () => undefined);
    return p;
  };

  let stopped = false;
  const workers: Promise<void>[] = dates.map((d) => sem.run(async () => {
    if (stopped) return;
    probed++;
    const probe = await probeApod(d);
    if (stopped) return;
    if (!probe.ok || !probe.imageUrl || !probe.apod) {
      return;
    }
    const apod = probe.apod;
    const imageUrl = probe.imageUrl;
    const buf = await downloadBuffer(imageUrl, 30_000);
    if (!buf) return;
    if (buf.length < 1024) {
      console.error(`[nasa] tiny payload (${buf.length}B) for ${imageUrl}; skipping`);
      return;
    }

    // Reserve an index + write file + append manifest under a single lock so
    // numbering stays monotonic and we don't double-claim.
    await serialize(async () => {
      if (stopped) return;
      const idx = nextIdx++;
      const filename = `nasa-${pad5(idx)}.jpg`;
      const targetPath = join(outAbs, filename);
      if (await fileExists(targetPath)) {
        // Extremely unlikely (we just allocated idx) but defensive.
        return;
      }
      await writeAtomic(targetPath, buf);
      const dims = parseImageDimensions(buf) ?? { width: 0, height: 0 };
      const row: ManifestRow = {
        src: 'nasa',
        path: `nasa/${filename}`,
        url: imageUrl,
        sha256: sha256Hex(buf),
        bytes: buf.length,
        width: dims.width,
        height: dims.height,
        license: 'public domain',
        fetched_at: new Date().toISOString(),
        date: apod.date ?? d,
        title: apod.title ?? '',
      };
      await appendFile(manifestAbs, JSON.stringify(row) + '\n');
      okCount++;
      if (okCount % 20 === 0) {
        const dt = (Date.now() - t0) / 1000;
        const rate = dt > 0 ? (okCount / dt).toFixed(2) : '0.00';
        console.log(`[nasa] ${okCount}/${opts.count} (rate=${rate}/s) probed=${probed}`);
      }
      if (okCount >= opts.count) {
        stopped = true;
      }
    });
  }));

  await Promise.all(workers);

  const dt = (Date.now() - t0) / 1000;
  const rate = dt > 0 ? (okCount / dt).toFixed(2) : '0.00';
  console.log(`[nasa] done ok=${okCount}/${opts.count} probed=${probed} elapsed=${dt.toFixed(1)}s rate=${rate}/s`);
  console.log(`[nasa] manifest: ${manifestAbs}`);
}

main().catch((e) => {
  console.error(`[nasa] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
