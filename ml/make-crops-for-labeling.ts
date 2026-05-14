/**
 * Generate per-frame crops for visual ground-truth labeling.
 *
 * For each frame in data/cursor-training-v0/, produce two crops:
 *   1. A 200x200 crop centered on the algorithm's claimed cursor
 *      position. Saved as: _crops/{stem}_crop.jpg
 *   2. A downsampled 2x version of the full frame for context.
 *      Saved as: _crops/{stem}_full.jpg
 *
 * The 200x200 crop is the primary label aid — native pixels, so
 * a 4-5 px cursor is unambiguously visible.
 *
 * Run: npx tsx ml/make-crops-for-labeling.ts
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';

const DATA = 'data/cursor-training-v0';
const OUT = path.join(DATA, '_crops');
const CROP_SIZE = 200;
const HALF = CROP_SIZE / 2;

await fs.mkdir(OUT, { recursive: true });

const all = await fs.readdir(DATA);
const jpgs = all.filter((f) => f.endsWith('.jpg')).sort();

let done = 0;
let skipped = 0;
for (const jpg of jpgs) {
  const stem = jpg.replace(/\.jpg$/, '');
  const jsonPath = path.join(DATA, `${stem}.json`);
  const cropPath = path.join(OUT, `${stem}_crop.jpg`);
  const fullPath = path.join(OUT, `${stem}_full.jpg`);

  // Skip if both crops already exist (resumable).
  try {
    await fs.access(cropPath);
    await fs.access(fullPath);
    skipped++;
    continue;
  } catch {
    /* fall through */
  }

  let meta;
  try {
    meta = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  } catch {
    continue;
  }
  const cx = Math.round(meta.cursor?.x ?? 840);
  const cy = Math.round(meta.cursor?.y ?? 525);

  const img = sharp(path.join(DATA, jpg));
  const { width: W = 1680, height: H = 1050 } = await img.metadata();

  const left = Math.max(0, Math.min(W - CROP_SIZE, cx - HALF));
  const top = Math.max(0, Math.min(H - CROP_SIZE, cy - HALF));

  await sharp(path.join(DATA, jpg))
    .extract({ left, top, width: CROP_SIZE, height: CROP_SIZE })
    .jpeg({ quality: 95 })
    .toFile(cropPath);

  await sharp(path.join(DATA, jpg))
    .resize({ width: Math.floor(W / 2) })
    .jpeg({ quality: 80 })
    .toFile(fullPath);

  // Record crop origin in sidecar so labels can map back.
  meta._crop_origin = { left, top, size: CROP_SIZE };
  await fs.writeFile(jsonPath, JSON.stringify(meta, null, 2));

  done++;
  if (done % 50 === 0) console.error(`  processed ${done} frames`);
}

console.error(`Done: ${done} cropped, ${skipped} already existed.`);
