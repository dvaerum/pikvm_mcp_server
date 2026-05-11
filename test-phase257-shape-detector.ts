/**
 * Phase 257: shape-based cursor detector prototype.
 *
 * The user asked: why are we not detecting the cursor by SHAPE
 * (like a human) instead of pixel-NCC against a captured template?
 *
 * Phase 251 confirmed NCC fails on the home screen — no template
 * scored ≥ 0.83 minScore even though the cursor is plainly visible
 * at ~(1063, 778) in trial1.jpg. A shape-based detector ought to
 * find it without needing a template at all.
 *
 * This prototype uses the SIMPLEST possible shape model:
 *   1. Convert frame to grayscale.
 *   2. Find dark pixels (brightness < threshold).
 *   3. Cluster dark pixels by connectivity (existing findClusters).
 *   4. Filter clusters by size (15-200 px — cursor ~80-90 px
 *      anti-aliased + edge tolerance).
 *   5. For each candidate, compute a shape descriptor:
 *      - aspect ratio (cursor: ~1:1 to 2:1 bbox)
 *      - asymmetry (arrow has more mass in one quadrant)
 *      - convex-deficiency (arrows are non-convex)
 *   6. Score each candidate and report top-K.
 *
 * Test target: trial1.jpg from Phase 251 (cursor at ~1063, 778).
 *
 * Decision criteria:
 *   - PASS: top-1 candidate within 30 px of (1063, 778) on
 *     ≥1 trial frame. → Shape detector is viable; invest further.
 *   - FAIL: top-1 not the cursor on any frame. → Need a better
 *     shape descriptor OR a different signal entirely.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';

// Use the existing cluster-finder primitive — it's already
// well-tested for the iPad use case.
import { findClusters, mergeClusters } from './src/pikvm/cursor-detect.js';

interface ShapeCandidate {
  centroidX: number;
  centroidY: number;
  pixels: number;
  bbox: { minX: number; maxX: number; minY: number; maxY: number };
  aspectRatio: number;
  // 4-quadrant mass asymmetry: max(quadrant mass) / min(quadrant mass)
  // Symmetric blob ≈ 1.0; arrow cursor much higher.
  asymmetry: number;
  // Distance from centroid to bbox center; arrow has mass offset
  // from geometric center.
  centroidOffsetFromBboxCenter: number;
  // Heuristic score combining the above.
  shapeScore: number;
}

const TRIAL = process.argv[2] || './data/phase251-topk/trial1.jpg';
const EXPECTED_X = parseInt(process.argv[3] || '1063', 10);
const EXPECTED_Y = parseInt(process.argv[4] || '778', 10);

console.error(`=== Phase 257 shape-detector prototype ===`);
console.error(`Frame: ${TRIAL}`);
console.error(`Expected cursor at (${EXPECTED_X}, ${EXPECTED_Y})\n`);

const buf = await fs.readFile(TRIAL);

// Decode to raw RGB. sharp.raw() gives a Buffer of width*height*3.
const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const width = info.width;
const height = info.height;
const rgb = data;

// Compute grayscale brightness per pixel. We'll find clusters of
// DARK pixels (brightness < darkThreshold).
const gray = Buffer.alloc(width * height);
for (let i = 0; i < width * height; i++) {
  const o = i * 3;
  // 0.30 R + 0.59 G + 0.11 B (perceptual luminance approximation)
  gray[i] = Math.round(rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114);
}

// Build a "is-dark" mask. iPadOS cursor is medium-dark (anti-aliased
// arrow with shadow). Threshold below 100 in grayscale captures most
// of the cursor while excluding wallpaper (teal/blue ~150-200).
const DARK_THRESHOLD = 100;
const mask = Buffer.alloc(width * height);
for (let i = 0; i < width * height; i++) {
  mask[i] = gray[i] < DARK_THRESHOLD ? 1 : 0;
}

// Reuse findClusters from production — it's already tuned for the
// iPad cursor size range. We pass min/max cluster size that bracket
// the expected cursor footprint.
const rawClusters = findClusters(mask, width, height, 15, 250, rgb);
const merged = mergeClusters(rawClusters, 8);

console.error(`Step 1: ${merged.length} dark connected components in [15-250 px] size range\n`);

// Compute shape descriptors per candidate.
const candidates: ShapeCandidate[] = [];
for (const c of merged) {
  // Recompute bbox + 4-quadrant mass from the raw mask within
  // a generous box around the centroid.
  const cx = Math.round(c.centroidX);
  const cy = Math.round(c.centroidY);
  const R = 25; // search radius around centroid

  let minX = cx, maxX = cx, minY = cy, maxY = cy;
  let qNW = 0, qNE = 0, qSW = 0, qSE = 0;

  for (let dy = -R; dy <= R; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= width) continue;
      if (mask[y * width + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (dx < 0 && dy < 0) qNW++;
      else if (dx >= 0 && dy < 0) qNE++;
      else if (dx < 0 && dy >= 0) qSW++;
      else qSE++;
    }
  }

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const aspectRatio = bboxW / Math.max(1, bboxH);
  const quadMasses = [qNW, qNE, qSW, qSE].sort((a, b) => b - a);
  const asymmetry = quadMasses[3] === 0 ? 0 : quadMasses[0] / Math.max(1, quadMasses[3]);
  const bboxCenterX = (minX + maxX) / 2;
  const bboxCenterY = (minY + maxY) / 2;
  const centroidOffset = Math.hypot(c.centroidX - bboxCenterX, c.centroidY - bboxCenterY);

  // Heuristic shape score (v2): the v1 score was dominated by tiny
  // 15-px blobs that scored asymmetry=97 because all their pixels
  // happen to be in one quadrant. Real cursors are ~70-90 px with
  // moderate asymmetry (~2-5). Cap asymmetry, narrow the size peak.
  const aspectPenalty = Math.abs(Math.log(aspectRatio)); // 0 at ratio=1
  const sizeFit = Math.exp(-Math.pow(c.pixels - 80, 2) / 600); // narrow peak ~80 px
  // Cap asymmetry contribution to prevent tiny blobs from
  // dominating the score.
  const cappedAsym = Math.min(asymmetry, 5);
  const cappedOffset = Math.min(centroidOffset, 10);
  const shapeScore =
    sizeFit *
    (1 + cappedAsym / 3) *
    (1 + cappedOffset / 5) *
    Math.exp(-aspectPenalty);

  candidates.push({
    centroidX: c.centroidX,
    centroidY: c.centroidY,
    pixels: c.pixels,
    bbox: { minX, maxX, minY, maxY },
    aspectRatio,
    asymmetry,
    centroidOffsetFromBboxCenter: centroidOffset,
    shapeScore,
  });
}

// Sort by shape score, take top 10.
candidates.sort((a, b) => b.shapeScore - a.shapeScore);
const topK = candidates.slice(0, 10);

console.error(`Step 2: top-10 candidates by shape score:`);
console.error(`rank | (x, y)        | pix | aspectR | asym  | offset | score | dist to expected`);
console.error(`-----+---------------+-----+---------+-------+--------+-------+-----------------`);
for (let i = 0; i < topK.length; i++) {
  const c = topK[i];
  const dist = Math.hypot(c.centroidX - EXPECTED_X, c.centroidY - EXPECTED_Y);
  console.error(
    `  ${(i + 1).toString().padStart(2)} | ` +
    `(${Math.round(c.centroidX).toString().padStart(4)},${Math.round(c.centroidY).toString().padStart(4)}) | ` +
    `${c.pixels.toString().padStart(3)} | ` +
    `${c.aspectRatio.toFixed(2).padStart(7)} | ` +
    `${c.asymmetry.toFixed(2).padStart(5)} | ` +
    `${c.centroidOffsetFromBboxCenter.toFixed(1).padStart(6)} | ` +
    `${c.shapeScore.toFixed(2).padStart(5)} | ` +
    `${dist.toFixed(0).padStart(15)}`,
  );
}

// Find the candidate closest to expected, regardless of score.
const byDist = [...candidates].sort((a, b) => {
  const da = Math.hypot(a.centroidX - EXPECTED_X, a.centroidY - EXPECTED_Y);
  const db = Math.hypot(b.centroidX - EXPECTED_X, b.centroidY - EXPECTED_Y);
  return da - db;
});

if (byDist.length > 0) {
  const c = byDist[0];
  const dist = Math.hypot(c.centroidX - EXPECTED_X, c.centroidY - EXPECTED_Y);
  console.error(`\nNearest candidate to expected (${EXPECTED_X}, ${EXPECTED_Y}):`);
  console.error(`  (${Math.round(c.centroidX)}, ${Math.round(c.centroidY)}) — dist=${dist.toFixed(0)} px — ` +
    `pixels=${c.pixels}, aspectR=${c.aspectRatio.toFixed(2)}, asym=${c.asymmetry.toFixed(2)}, score=${c.shapeScore.toFixed(2)}`);
  // Where did it rank?
  const rank = candidates.findIndex(x => x === c) + 1;
  console.error(`  Ranked ${rank} of ${candidates.length} by shape score.`);
}

console.error(`\n=== VERDICT ===`);
const top1 = topK[0];
if (top1) {
  const top1Dist = Math.hypot(top1.centroidX - EXPECTED_X, top1.centroidY - EXPECTED_Y);
  if (top1Dist < 30) {
    console.error('PASS: top-1 candidate within 30 px of expected cursor position.');
    console.error('Shape detector is VIABLE on this frame. Worth investing in further.');
  } else if (top1Dist < 100) {
    console.error('CLOSE: top-1 within 100 px but > 30 px. Shape descriptor needs tuning.');
  } else {
    console.error('FAIL: top-1 far from expected cursor.');
    console.error('  Cursor may not have made it into the candidate list, OR shape score');
    console.error('  is selecting the wrong feature. Inspect the rank of the nearest candidate.');
  }
}
process.exit(0);
