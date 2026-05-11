/**
 * Phase 258 (v0.5.218) — shape-based cursor detector.
 *
 * Architectural alternative to template-based (NCC) cursor detection.
 * Phase 251 confirmed NCC fails on the iPad home screen: cached
 * templates score below 0.83 minScore at any position even when the
 * cursor is plainly visible. The fundamental problem is that NCC
 * compares captured pixels — when the backdrop changes, NCC drops.
 *
 * This module finds the cursor by SHAPE descriptors instead:
 *   - dark connected component
 *   - cursor-sized (~80 px range)
 *   - asymmetric mass distribution (arrow has one heavy quadrant)
 *   - centroid offset from bbox center (arrow mass is off-centre)
 *
 * No template required. No "stale cache" failure mode. Works on any
 * backdrop where the cursor is dark relative to surroundings.
 *
 * Phase 257 prototype validated detection: cursor consistently in
 * the top-5 candidates by shape score across 5 Phase 251 frames
 * where NCC failed completely.
 *
 * Phase 258 added the locality gate: combined with an
 * `expectedNear` hint (e.g. from cursor-belief.position), top-1
 * selection picks the cursor 5/5 trials.
 *
 * Stays opt-in until production integration. Existing NCC path is
 * untouched; this is a parallel detector.
 */

import { findClusters, mergeClusters } from './cursor-detect.js';

export interface ShapeCandidate {
  /** Centroid in HDMI pixels. */
  centroidX: number;
  centroidY: number;
  /** Connected-component pixel count (after merge). */
  pixels: number;
  /** Heuristic shape score (higher = more cursor-like). */
  shapeScore: number;
}

export interface ShapeOptions {
  /** Hint where the cursor is expected to be — e.g.
   *  `client.belief.position`. Filters candidates to those within
   *  `expectedNearRadius` of this point. Default undefined =
   *  no filter (returns highest-scoring candidate anywhere). */
  expectedNear?: { x: number; y: number };
  /** Radius around `expectedNear` in pixels. Default 200. Tight
   *  enough to filter out unrelated dark UI features (clock widget,
   *  app icons, dock icons) while loose enough to admit the real
   *  cursor even if belief drifts. Phase 258 N=5 verified 200 px
   *  picks correctly when the hint is reasonably accurate. */
  expectedNearRadius?: number;
  /** Override the dark-pixel threshold (0-255). Pixels with
   *  grayscale brightness below this are candidate cursor mass.
   *  Default 100 — admits anti-aliased iPadOS arrow shadow while
   *  excluding most wallpapers (teal/blue ~150-200). */
  darkThreshold?: number;
  /** Min cluster size in pixels. Default 15 — excludes JPEG noise. */
  minClusterPixels?: number;
  /** Max cluster size in pixels. Default 250 — admits cursor with
   *  generous edge-tolerance (cursor measured ~80 px Phase 104). */
  maxClusterPixels?: number;
}

/**
 * Compute the shape score for a candidate centred at `(cx, cy)`.
 * Pure helper, exported for unit tests.
 *
 * Scoring components:
 *   - sizeFit: peaks at 80 px (calibrated cursor size from Phase
 *     104). Falls off as a Gaussian; very small (15 px) and very
 *     large (200+ px) clusters score low.
 *   - asymmetry: max-quadrant mass / min-quadrant mass, capped at
 *     5.0. Cap prevents tiny noise blobs from scoring infinity by
 *     accident.
 *   - centroid offset from bbox center: capped at 10 px. Real
 *     cursors have visible offset (~3-8 px); blobs centred in their
 *     bbox don't.
 *   - aspect-ratio penalty: log-distance from 1.0. Cursor bbox is
 *     roughly square (24×24 nominal); elongated rectangles get
 *     penalised.
 */
export function shapeScoreFor(
  pixels: number,
  asymmetry: number,
  centroidOffset: number,
  bboxAspectRatio: number,
): number {
  const aspectPenalty = Math.abs(Math.log(Math.max(0.01, bboxAspectRatio)));
  const sizeFit = Math.exp(-Math.pow(pixels - 80, 2) / 600);
  const cappedAsym = Math.min(asymmetry, 5);
  const cappedOffset = Math.min(centroidOffset, 10);
  return (
    sizeFit *
    (1 + cappedAsym / 3) *
    (1 + cappedOffset / 5) *
    Math.exp(-aspectPenalty)
  );
}

/**
 * Find the top-K shape candidates without picking a single winner.
 * Returns up to `k` candidates (within the locality gate if
 * `expectedNear` set), sorted by shape score descending.
 *
 * Phase 260 use: hand the top-K to a motion-diff verifier that
 * picks the one that actually moves between two frames.
 */
export function findCursorShapeCandidates(
  rgb: Buffer,
  width: number,
  height: number,
  k: number = 5,
  options: ShapeOptions = {},
): ShapeCandidate[] {
  const all = findAllShapeCandidates(rgb, width, height, options);
  return all.slice(0, k);
}

/**
 * Find the cursor in a screenshot by shape, not by template
 * matching.
 *
 * Returns the highest-scoring shape candidate (within the locality
 * gate, if `expectedNear` was supplied), or null if no candidate
 * passes the filters.
 *
 * @param rgb  raw RGB buffer (width*height*3 bytes)
 * @param width  frame width in pixels
 * @param height  frame height in pixels
 */
export function findCursorByShape(
  rgb: Buffer,
  width: number,
  height: number,
  options: ShapeOptions = {},
): ShapeCandidate | null {
  const sorted = findAllShapeCandidates(rgb, width, height, options);
  return sorted.length > 0 ? sorted[0] : null;
}

/** Internal: find ALL shape candidates, locality-filtered and
 *  sorted by score descending. Pure / no-IO. Both public entry
 *  points use this. */
function findAllShapeCandidates(
  rgb: Buffer,
  width: number,
  height: number,
  options: ShapeOptions = {},
): ShapeCandidate[] {
  const darkThreshold = options.darkThreshold ?? 100;
  const minPx = options.minClusterPixels ?? 15;
  const maxPx = options.maxClusterPixels ?? 250;

  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    gray[i] = Math.round(rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114);
  }

  const mask: boolean[] = new Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = gray[i] < darkThreshold;
  }

  const rawClusters = findClusters(mask, width, height, minPx, maxPx, rgb);
  const merged = mergeClusters(rawClusters, 8);

  // Per-candidate shape descriptors. We re-scan the mask within a
  // 25-px box around each centroid to get bbox + 4-quadrant mass
  // (the mergeClusters output doesn't carry these).
  // Phase 259 (v0.5.219): also accumulate per-channel sums for
  // grayscale-ness check. The iPad cursor is grayscale (R ≈ G ≈ B);
  // dock icons (App Store blue, AppTV) and notification badges (red
  // numbers) are NOT, even when they have small dark sub-regions.
  // Reject candidates whose dominant pixels show high chromatic
  // variation.
  const candidates: ShapeCandidate[] = [];
  for (const c of merged) {
    const cx = Math.round(c.centroidX);
    const cy = Math.round(c.centroidY);
    const R = 25;
    let minX = cx, maxX = cx, minY = cy, maxY = cy;
    let qNW = 0, qNE = 0, qSW = 0, qSE = 0;
    let sumR = 0, sumG = 0, sumB = 0, darkCount = 0;
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= width) continue;
        if (!mask[y * width + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const ri = (y * width + x) * 3;
        sumR += rgb[ri];
        sumG += rgb[ri + 1];
        sumB += rgb[ri + 2];
        darkCount++;
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

    // Phase 259: grayscale-ness penalty. The iPad cursor is dark
    // gray (R ≈ G ≈ B). Dock-icon dark sub-regions usually have a
    // colour cast (App Store blue, AppTV dark-with-rendered-logo,
    // badge red). Penalise shapeScore by chroma — soft penalty
    // (vs hard reject) so coloured candidates can still win when
    // nothing better is available.
    let chroma = 0;
    if (darkCount > 0) {
      const mR = sumR / darkCount;
      const mG = sumG / darkCount;
      const mB = sumB / darkCount;
      chroma = Math.max(mR, mG, mB) - Math.min(mR, mG, mB);
    }
    // Chroma penalty halves the score at chroma=20 (mild colour
    // cast), reduces to ~10% at chroma=50 (clearly coloured icon).
    const chromaPenalty = Math.exp(-chroma / 20);

    candidates.push({
      centroidX: c.centroidX,
      centroidY: c.centroidY,
      pixels: c.pixels,
      shapeScore:
        shapeScoreFor(c.pixels, asymmetry, centroidOffset, aspectRatio) *
        chromaPenalty,
    });
  }

  // Locality gate.
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

  pool.sort((a, b) => b.shapeScore - a.shapeScore);
  return pool;
}
