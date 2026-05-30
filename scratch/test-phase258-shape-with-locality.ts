/**
 * Phase 258: shape detector + locality gate.
 *
 * Phase 257 found the shape detector consistently ranks the cursor
 * top-5 by shape score, but my heuristic picks the wrong top-1.
 * The fix: combine with a locality hint (where the cursor is expected
 * from cursor-belief). Filter top-K candidates to "within `radius` of
 * `expectedNear`"; among those, pick highest shape score.
 *
 * The cursor-belief in production already tracks predicted position
 * from prior emits. This experiment uses a HARD-CODED hint (the
 * known visual cursor position) as a stand-in. If shape+locality
 * picks the cursor as top-1 reliably with the right hint, the
 * production integration is straightforward.
 *
 * Test corpus: Phase 251 saved frames (5 trials, cursor at
 * approximately (1063, 778)).
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { findClusters, mergeClusters } from '../src/pikvm/cursor-detect.js';

interface ShapeCandidate {
  centroidX: number;
  centroidY: number;
  pixels: number;
  shapeScore: number;
}

interface ShapeOptions {
  /** Hint where the cursor should be (e.g. from cursor-belief.position). */
  expectedNear?: { x: number; y: number };
  /** Radius around hint within which to accept candidates. */
  expectedNearRadius?: number;
}

function findCursorByShape(
  rgb: Buffer,
  width: number,
  height: number,
  options: ShapeOptions = {},
): ShapeCandidate | null {
  // Step 1: grayscale brightness.
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    gray[i] = Math.round(rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114);
  }

  // Step 2: dark-pixel mask.
  const DARK_THRESHOLD = 100;
  const mask = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = gray[i] < DARK_THRESHOLD ? 1 : 0;
  }

  // Step 3: find connected components, merge near-adjacent.
  const rawClusters = findClusters(mask, width, height, 15, 250, rgb);
  const merged = mergeClusters(rawClusters, 8);

  // Step 4: compute shape descriptors per candidate.
  const candidates: ShapeCandidate[] = [];
  for (const c of merged) {
    const cx = Math.round(c.centroidX);
    const cy = Math.round(c.centroidY);
    const R = 25;
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

    const aspectPenalty = Math.abs(Math.log(aspectRatio));
    const sizeFit = Math.exp(-Math.pow(c.pixels - 80, 2) / 600);
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
      shapeScore,
    });
  }

  // Step 5: locality filter.
  let pool = candidates;
  if (options.expectedNear) {
    const hint = options.expectedNear;
    const r = options.expectedNearRadius ?? 200;
    const r2 = r * r;
    pool = candidates.filter((c) => {
      const dx = c.centroidX - hint.x;
      const dy = c.centroidY - hint.y;
      return dx * dx + dy * dy <= r2;
    });
  }

  if (pool.length === 0) return null;
  pool.sort((a, b) => b.shapeScore - a.shapeScore);
  return pool[0];
}

// --- Run on Phase 251 trial frames ---
const HINT = { x: 1063, y: 778 };
const RADIUS = 200;
console.error(`=== Phase 258 shape + locality gate ===`);
console.error(`Hint: (${HINT.x}, ${HINT.y}), radius: ${RADIUS} px\n`);

console.error('trial | with-hint top-1   | dist | shape-only top-1   | dist');
console.error('------+-------------------+------+--------------------+------');
for (let t = 1; t <= 5; t++) {
  const buf = await fs.readFile(`./data/phase251-topk/trial${t}.jpg`);
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const withHint = findCursorByShape(data, info.width, info.height, {
    expectedNear: HINT,
    expectedNearRadius: RADIUS,
  });
  const noHint = findCursorByShape(data, info.width, info.height);

  const fmt = (r: ShapeCandidate | null) => {
    if (!r) return ['(null)', 'n/a'];
    const dist = Math.hypot(r.centroidX - HINT.x, r.centroidY - HINT.y);
    return [`(${Math.round(r.centroidX)}, ${Math.round(r.centroidY)})`, dist.toFixed(0)];
  };
  const [w, wd] = fmt(withHint);
  const [n, nd] = fmt(noHint);
  console.error(`  ${t}   | ${w.padEnd(17)} | ${wd.padStart(4)} | ${n.padEnd(18)} | ${nd.padStart(4)}`);
}

// Stress test: bad hint (way off from where cursor actually is)
console.error('\n=== Stress test: bad hint at (200, 200), radius 200 px ===');
console.error('(should return null because cursor is at ~(1063, 778), nowhere near the hint)');
const buf = await fs.readFile('./data/phase251-topk/trial1.jpg');
const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const badHint = findCursorByShape(data, info.width, info.height, {
  expectedNear: { x: 200, y: 200 },
  expectedNearRadius: 200,
});
console.error(`Result: ${badHint ? `(${Math.round(badHint.centroidX)}, ${Math.round(badHint.centroidY)}) — FALSE POSITIVE` : 'null — correct rejection'}`);

console.error('\n=== Stress test: very loose hint, radius 800 px ===');
console.error('(should still find the right candidate, even with broad hint)');
const looseHint = findCursorByShape(data, info.width, info.height, {
  expectedNear: { x: 800, y: 600 },
  expectedNearRadius: 800,
});
if (looseHint) {
  const dist = Math.hypot(looseHint.centroidX - HINT.x, looseHint.centroidY - HINT.y);
  console.error(`Result: (${Math.round(looseHint.centroidX)}, ${Math.round(looseHint.centroidY)}) — dist=${dist.toFixed(0)} to cursor`);
}

process.exit(0);
