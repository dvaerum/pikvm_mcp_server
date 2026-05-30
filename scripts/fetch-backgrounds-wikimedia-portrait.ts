/**
 * Fetch portrait-oriented Wikimedia Commons images (mobile UI / phone /
 * tablet / app screenshots) into the scene-background catalog. Target
 * aspect ratio matches the iPad logical resolution 820x1180 (ratio ~0.7),
 * but we accept any portrait image (width < height) in a reasonable size
 * window (600-3000 px thumbnail width).
 *
 * Pace: 1 concurrent download, 1500 ms between API/asset requests. On
 * HTTP 429 we honor exponential backoff (5s, 10s, 20s, 40s, 60s) and then
 * give up on that file. After 5 consecutive 429s anywhere in the pipeline
 * we abort the run early.
 *
 *   npx tsx scripts/fetch-backgrounds-wikimedia-portrait.ts \
 *       [--count 1000] \
 *       [--out data/scene-backgrounds/wikimedia-portrait] \
 *       [--width 1200]
 *
 * Resumes from the highest existing wikimedia-portrait-NNNNN.jpg index.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

const ARGS = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
}
const COUNT = Number(arg('--count', '1000'));
const OUT_DIR = arg('--out', 'data/scene-backgrounds/wikimedia-portrait');
const WIDTH = Number(arg('--width', '1200'));
const MANIFEST = path.join(path.dirname(OUT_DIR), 'manifest.jsonl');
const API = 'https://commons.wikimedia.org/w/api.php';
const REQUEST_DELAY_MS = 1500;
const USER_AGENT = 'pikvm-mcp-server scene-catalog (claude.ai@varum.dk)';

const MIN_THUMB_WIDTH = 600;
const MAX_THUMB_WIDTH = 3000;
const BACKOFF_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const MAX_CONSECUTIVE_RATE_LIMITS = 5;

/**
 * Curated leaf categories likely to contain portrait phone / tablet UI
 * shots. Probed manually 2026-05-30 — all return content with reasonable
 * size. We also recursively expand a couple of parent categories below.
 */
const SEED_CATEGORIES = [
  'IOS screenshots',
  'Mobile phone screenshots',
  'Wikipedia mobile screenshots',
  'Wikipedia iOS app screenshots',
  'Commons iOS app screenshots',
  'English Wikipedia mobile screenshots',
  'Screenshots of Safari mobile',
  'Cydia screenshots',
  'IOS settings screenshots',
  'Cell Broadcast settings on iOS',
  'Vietnamese Wikipedia mobile screenshots',
  'Odia Wikipedia mobile screenshots',
];

/**
 * Parents we recursively expand once to collect leaves (depth 1 only —
 * avoid runaway category-tree explosions).
 */
const PARENT_CATEGORIES_TO_EXPAND = [
  'Screenshots of Android by version',
  'Wikipedia mobile screenshots',
  'IOS screenshots',
];

interface MwImage {
  pageid: number;
  ns: number;
  title: string;
  imageinfo?: Array<{
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

let consecutiveRateLimits = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function existingMax(): Promise<number> {
  try {
    const entries = await fs.readdir(OUT_DIR);
    let max = 0;
    for (const e of entries) {
      const m = e.match(/^wikimedia-portrait-(\d+)\.jpg$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  } catch {
    return 0;
  }
}

class RateLimitAbort extends Error {
  constructor() {
    super('too many consecutive 429s — aborting run');
  }
}

/**
 * GET with 429-aware exponential backoff. Returns null if we give up
 * after exhausting BACKOFF_STEPS_MS. Throws RateLimitAbort if we have
 * seen MAX_CONSECUTIVE_RATE_LIMITS in a row across the pipeline.
 */
async function fetchWithBackoff(
  url: string,
  label: string,
): Promise<Response | null> {
  for (let step = 0; step <= BACKOFF_STEPS_MS.length; step++) {
    if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
      throw new RateLimitAbort();
    }
    let r: Response;
    try {
      r = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      console.error(`[mw] ${label} fetch error: ${(e as Error).message}`);
      return null;
    }
    if (r.status === 429) {
      consecutiveRateLimits++;
      if (step === BACKOFF_STEPS_MS.length) {
        console.error(`[mw] ${label}: 429 after final backoff, giving up`);
        return null;
      }
      const wait = BACKOFF_STEPS_MS[step];
      console.error(`[mw] ${label}: 429 — backoff ${wait}ms (consecutive=${consecutiveRateLimits})`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) {
      console.error(`[mw] ${label}: HTTP ${r.status}`);
      consecutiveRateLimits = 0;
      return null;
    }
    consecutiveRateLimits = 0;
    return r;
  }
  return null;
}

async function apiQuery(params: URLSearchParams, label: string): Promise<any | null> {
  const url = `${API}?${params.toString()}`;
  const r = await fetchWithBackoff(url, label);
  if (!r) return null;
  try {
    return await r.json();
  } catch (e) {
    console.error(`[mw] ${label}: invalid JSON: ${(e as Error).message}`);
    return null;
  }
}

async function expandSubcategories(parent: string): Promise<string[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'categorymembers',
    cmtitle: `Category:${parent}`,
    cmtype: 'subcat',
    cmlimit: '100',
    format: 'json',
    formatversion: '2',
  });
  const j = await apiQuery(params, `expand[${parent}]`);
  if (!j) return [];
  const members = j?.query?.categorymembers ?? [];
  return members
    .filter((m: any) => m.ns === 14)
    .map((m: any) => (m.title as string).replace(/^Category:/, ''));
}

async function fetchCategoryPage(
  category: string,
  cont: string | null,
): Promise<{ images: MwImage[]; next: string | null } | null> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'categorymembers',
    gcmtitle: `Category:${category}`,
    gcmtype: 'file',
    gcmlimit: '50',
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: String(WIDTH),
    iimetadataversion: 'latest',
    format: 'json',
    formatversion: '2',
  });
  if (cont) params.set('gcmcontinue', cont);
  const j = await apiQuery(params, `page[${category}]`);
  if (!j) return null;
  const images = (j?.query?.pages ?? []) as MwImage[];
  const next = j?.continue?.gcmcontinue ?? null;
  return { images, next };
}

async function downloadOne(
  url: string,
  outPath: string,
): Promise<{ bytes: number; sha256: string } | null> {
  const r = await fetchWithBackoff(url, `dl[${path.basename(outPath)}]`);
  if (!r) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = outPath + '.tmp';
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, outPath);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const startIdx = (await existingMax()) + 1;

  // Build the working category list — seeds + depth-1 subcats of parents.
  const categorySet = new Set<string>(SEED_CATEGORIES);
  for (const parent of PARENT_CATEGORIES_TO_EXPAND) {
    const subs = await expandSubcategories(parent);
    for (const s of subs) categorySet.add(s);
    await sleep(REQUEST_DELAY_MS);
  }
  const categories = Array.from(categorySet);
  console.log(
    `[mw-portrait] target=${COUNT} startIdx=${startIdx} categories=${categories.length}`,
  );

  let nextIdx = startIdx;
  let saved = 0;
  let skipped_non_image = 0;
  let skipped_landscape = 0;
  let skipped_size = 0;
  let skipped_dup = 0;
  let failed = 0;
  const seenIds = new Set<number>();
  const seenSha = new Set<string>();
  const manifestRows: string[] = [];
  const t0 = Date.now();
  const cursors: Record<string, { token: string | null; done: boolean }> =
    Object.fromEntries(categories.map((c) => [c, { token: null, done: false }]));

  try {
    outer: while (saved < COUNT) {
      let advancedThisRound = false;

      for (const category of categories) {
        if (saved >= COUNT) break outer;
        const cur = cursors[category];
        if (cur.done) continue;

        const res = await fetchCategoryPage(category, cur.token);
        await sleep(REQUEST_DELAY_MS);
        if (!res) {
          // network error / non-429 failure — skip to next category
          cur.done = true;
          continue;
        }
        cur.token = res.next;
        if (!res.next) cur.done = true;
        if (res.images.length === 0) {
          cur.done = true;
          continue;
        }
        advancedThisRound = true;

        for (const item of res.images) {
          if (saved >= COUNT) break outer;
          if (seenIds.has(item.pageid)) {
            skipped_dup++;
            continue;
          }
          seenIds.add(item.pageid);
          const ii = item.imageinfo?.[0];
          if (!ii || !ii.mime?.startsWith('image/')) {
            skipped_non_image++;
            continue;
          }
          const tw = ii.thumbwidth ?? ii.width;
          const th = ii.thumbheight ?? ii.height;
          if (!tw || !th) {
            skipped_size++;
            continue;
          }
          if (tw >= th) {
            skipped_landscape++;
            continue;
          }
          if (tw < MIN_THUMB_WIDTH || tw > MAX_THUMB_WIDTH) {
            skipped_size++;
            continue;
          }
          const url = ii.thumburl ?? ii.url;
          if (!url) {
            skipped_non_image++;
            continue;
          }
          const idx = nextIdx++;
          const filename = `wikimedia-portrait-${String(idx).padStart(5, '0')}.jpg`;
          const outPath = path.join(OUT_DIR, filename);
          const dlres = await downloadOne(url, outPath);
          await sleep(REQUEST_DELAY_MS);
          if (!dlres) {
            failed++;
            // free index — but it's cheap to leave the gap; just leave it.
            continue;
          }
          if (seenSha.has(dlres.sha256)) {
            skipped_dup++;
            await fs.rm(outPath).catch(() => {});
            continue;
          }
          seenSha.add(dlres.sha256);
          saved++;
          manifestRows.push(JSON.stringify({
            src: 'wikimedia-portrait',
            path: `wikimedia-portrait/${filename}`,
            url,
            original_url: ii.url,
            wikimedia_page: `https://commons.wikimedia.org/?curid=${item.pageid}`,
            title: item.title,
            sha256: dlres.sha256,
            bytes: dlres.bytes,
            width: tw,
            height: th,
            license: 'CC/PD (per Commons)',
            category,
            fetched_at: new Date().toISOString(),
          }));
          if (saved % 10 === 0) {
            const elapsed = (Date.now() - t0) / 1000;
            console.log(
              `[mw-portrait] saved=${saved}/${COUNT} skipped(landscape=${skipped_landscape} size=${skipped_size} dup=${skipped_dup} non-img=${skipped_non_image}) failed=${failed} rate=${(saved / elapsed).toFixed(3)}/s`,
            );
            // Flush manifest periodically so a long run doesn't lose data.
            await fs.appendFile(MANIFEST, manifestRows.splice(0).join('\n') + '\n');
          }
        }
      }

      if (!advancedThisRound) {
        console.log('[mw-portrait] all categories exhausted');
        break;
      }
    }
  } catch (e) {
    if (e instanceof RateLimitAbort) {
      console.error(`[mw-portrait] ABORTED: ${e.message}`);
    } else {
      throw e;
    }
  }

  if (manifestRows.length) {
    await fs.appendFile(MANIFEST, manifestRows.join('\n') + '\n');
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(
    `[mw-portrait] done saved=${saved}/${COUNT} skipped(landscape=${skipped_landscape} size=${skipped_size} dup=${skipped_dup} non-img=${skipped_non_image}) failed=${failed} elapsed=${elapsed.toFixed(1)}s`,
  );
  console.log(`[mw-portrait] manifest: ${path.resolve(MANIFEST)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
