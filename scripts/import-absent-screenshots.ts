/**
 * Import absent-cursor PiKVM screenshots as scene backgrounds.
 *
 * The PiKVM HDMI capture letterboxes the iPad display inside a black
 * border. For the synthetic-frame collector we want clean iPad-UI
 * background images — so we detect the iPad-content rectangle in each
 * frame and crop the tight content rect out.
 *
 * Input frames come from a cursor-collect-absent run, where the
 * pointer-auto-hide timer fired before capture, so no cursor is
 * present in the iPad content.
 *
 * Usage:
 *   npx tsx scripts/import-absent-screenshots.ts \
 *     [--in data/cursor-collect-absent-2026-05-30T08-03-23] \
 *     [--out data/scene-backgrounds/ipad-screenshots]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const DEFAULT_IN = 'data/cursor-collect-absent-2026-05-30T08-03-23';
const DEFAULT_OUT = 'data/scene-backgrounds/ipad-screenshots';
const MANIFEST_PATH = 'data/scene-backgrounds/manifest.jsonl';
const MIN_TIGHT_PX = 200;

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

async function walkJpegs(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recur(dir: string): Promise<void> {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await recur(p);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.jpg')) {
        out.push(p);
      }
    }
  }
  await recur(root);
  out.sort();
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function nextSeq(outDir: string): Promise<number> {
  try {
    const ents = await fs.readdir(outDir);
    let max = 0;
    for (const name of ents) {
      const m = name.match(/^ipad-(\d{5})\.jpg$/);
      if (m) {
        const n = Number(m[1]);
        if (n > max) max = n;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/** Read manifest.jsonl (if present) and return the set of source_frame
 *  paths already imported. Lets re-runs skip frames they've already
 *  processed without writing duplicates under new sequence numbers. */
async function loadImportedSources(manifestPath: string): Promise<Set<string>> {
  const out = new Set<string>();
  let text: string;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { source_frame?: string };
      if (row.source_frame) out.add(row.source_frame);
    } catch {
      /* ignore malformed lines */
    }
  }
  return out;
}

async function main(): Promise<void> {
  const inDir = argOf('--in') ?? DEFAULT_IN;
  const outDir = argOf('--out') ?? DEFAULT_OUT;

  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });

  const frames = await walkJpegs(inDir);
  console.log(`[import-absent] found ${frames.length} jpegs under ${inDir}`);

  const alreadyImported = await loadImportedSources(MANIFEST_PATH);
  let seq = await nextSeq(outDir);
  let saved = 0;
  let skippedFallback = 0;
  let skippedSmall = 0;
  let skippedExists = 0;
  let skippedError = 0;

  for (let i = 0; i < frames.length; i++) {
    const src = frames[i];
    if (alreadyImported.has(src)) {
      skippedExists++;
      continue;
    }
    try {
      const buf = await fs.readFile(src);
      const region = await detectIpadRegion(buf);

      const isFallback =
        region.x === 0 &&
        region.y === 0 &&
        region.w === region.frameW &&
        region.h === region.frameH;
      if (isFallback) {
        skippedFallback++;
        continue;
      }

      // Tight content rect — same logic as bench-collect-synthetic.ts.
      const tight = {
        x: region.x + NATIVE_MARGIN,
        y: region.y + NATIVE_MARGIN,
        w: region.w - 2 * NATIVE_MARGIN,
        h: region.h - 2 * NATIVE_MARGIN,
      };

      if (tight.w < MIN_TIGHT_PX || tight.h < MIN_TIGHT_PX) {
        skippedSmall++;
        continue;
      }

      const outName = `ipad-${String(seq).padStart(5, '0')}.jpg`;
      const outPath = path.join(outDir, outName);
      if (await fileExists(outPath)) {
        skippedExists++;
        seq++;
        continue;
      }

      await sharp(buf)
        .extract({
          left: tight.x,
          top: tight.y,
          width: tight.w,
          height: tight.h,
        })
        .jpeg()
        .toFile(outPath);

      const manifestRow = {
        src: 'ipad-screenshots',
        path: `ipad-screenshots/${outName}`,
        source_frame: src,
        region: { x: tight.x, y: tight.y, w: tight.w, h: tight.h },
        license: 'internal',
        imported_at: new Date().toISOString(),
      };
      await fs.appendFile(MANIFEST_PATH, JSON.stringify(manifestRow) + '\n');

      saved++;
      seq++;
    } catch (e) {
      skippedError++;
      console.error(`[import-absent] error on ${src}: ${(e as Error).message}`);
    }

    if ((i + 1) % 10 === 0) {
      console.log(
        `[import-absent] ${i + 1}/${frames.length}  saved=${saved} fallback=${skippedFallback} small=${skippedSmall} exists=${skippedExists} err=${skippedError}`,
      );
    }
  }

  console.log(
    `[import-absent] done. saved=${saved} fallback=${skippedFallback} small=${skippedSmall} exists=${skippedExists} err=${skippedError}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
