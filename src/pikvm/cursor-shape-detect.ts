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
  /** Phase 293: BRIGHT-pixel threshold (0-255). When set, also run a
   *  second cluster-extraction pass with mask = brightness > this.
   *  Returned clusters from both passes are scored uniformly and
   *  competed against each other. Default undefined = dark-only
   *  (back-compat). Set 120-140 to catch iPadOS pointer-effect-snap
   *  cursors that render as LIGHT gray (~150-200 brightness) over
   *  medium wallpaper (~50-100). Phase 293 N=4 frames showed
   *  brightThreshold=120 picks the cursor within 7-39 px of truth
   *  when the dark-only path failed entirely (cursor invisible to
   *  dark mask in pointer-effect mode). */
  brightThreshold?: number;
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
  const brightThreshold = options.brightThreshold;
  const minPx = options.minClusterPixels ?? 15;
  const maxPx = options.maxClusterPixels ?? 250;

  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    gray[i] = Math.round(rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114);
  }

  // Phase 293: dual-pass cluster extraction. Dark mask catches the
  // classic dark cursor over light wallpaper; bright mask (when
  // enabled) catches the iPadOS pointer-effect-snap cursor which
  // renders LIGHT (~150-200) over medium wallpaper (~50-100). The
  // two cluster sets are processed INDEPENDENTLY (different mergeClusters
  // calls) so dark-mask clusters and bright-mask clusters don't
  // accidentally merge into single objects with double-counted pixels.
  // Their scored candidates compete in the locality pool.
  const darkMask: boolean[] = new Array(width * height);
  for (let i = 0; i < width * height; i++) darkMask[i] = gray[i] < darkThreshold;
  const darkClusters = findClusters(darkMask, width, height, minPx, maxPx, rgb, { keepMembers: true });
  const darkMerged = mergeClusters(darkClusters, 8);

  let brightMerged: typeof darkMerged = [];
  if (brightThreshold !== undefined) {
    const brightMask: boolean[] = new Array(width * height);
    for (let i = 0; i < width * height; i++) brightMask[i] = gray[i] > brightThreshold;
    const brightClusters = findClusters(brightMask, width, height, minPx, maxPx, rgb, { keepMembers: true });
    brightMerged = mergeClusters(brightClusters, 8);
  }
  const merged = [...darkMerged, ...brightMerged];

  // Phase 290 (v0.5.227): compute shape descriptors from each cluster's
  // ACTUAL member pixels + true bbox, not a fixed-radius rescan around
  // the centroid. The old 25-px rescan would saturate the clock-widget
  // FP's bbox at ~50×51 (covering the whole scan window) because the
  // clock-face area has many isolated dark UI elements (digits, dial
  // marks, two hands) within 25 px of any single hand's centroid. That
  // gave clock-FP an aspectFactor of ~1.0 — matching the cursor's
  // square-ish bbox — and let it consistently out-score the cursor.
  //
  // Per-cluster bbox is tight to the connected component: a thin clock
  // hand has bbox ~5×35 (aspect 0.14 → strong aspectPenalty), and the
  // cursor's bbox is ~14×20 (aspect 0.70 → small penalty). Member-pixel
  // quadrants give true asymmetry/offset undiluted by neighbouring
  // unrelated dark pixels.
  const candidates: ShapeCandidate[] = [];
  for (const c of merged) {
    const bboxW = c.bboxMaxX - c.bboxMinX + 1;
    const bboxH = c.bboxMaxY - c.bboxMinY + 1;
    const aspectRatio = bboxW / Math.max(1, bboxH);
    const bboxCenterX = (c.bboxMinX + c.bboxMaxX) / 2;
    const bboxCenterY = (c.bboxMinY + c.bboxMaxY) / 2;
    const centroidOffset = Math.hypot(c.centroidX - bboxCenterX, c.centroidY - bboxCenterY);

    let qNW = 0, qNE = 0, qSW = 0, qSE = 0;
    if (c.members) {
      for (const idx of c.members) {
        const px = idx % width;
        const py = (idx - px) / width;
        if (px < c.centroidX && py < c.centroidY) qNW++;
        else if (px >= c.centroidX && py < c.centroidY) qNE++;
        else if (px < c.centroidX && py >= c.centroidY) qSW++;
        else qSE++;
      }
    }
    const quadMasses = [qNW, qNE, qSW, qSE].sort((a, b) => b - a);
    const asymmetry = quadMasses[3] === 0 ? 0 : quadMasses[0] / Math.max(1, quadMasses[3]);

    // Chroma from cluster's own meanR/G/B (computed by findClusters
    // over cluster members only — no neighbour pollution). Phase 290
    // softens the chroma penalty from /20 to /40 because cluster-only
    // chroma is much lower than the old rescan-based chroma (the old
    // rescan accumulated nearby wallpaper-tinted dark pixels). With
    // the softer penalty the cursor-on-busy-wallpaper case still
    // competes against grayscale FPs.
    let chroma = 0;
    if (c.meanR !== undefined && c.meanG !== undefined && c.meanB !== undefined) {
      chroma = Math.max(c.meanR, c.meanG, c.meanB) - Math.min(c.meanR, c.meanG, c.meanB);
    }
    const chromaPenalty = Math.exp(-chroma / 40);

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
