/**
 * Approximate-absolute move-to-pixel for PiKVM targets in relative mouse
 * mode (mouse.absolute=false, e.g. iPad).
 *
 * **Motion-as-probe architecture (Phase 3):** the detection signal is the
 * real movement we're emitting anyway, not synthetic probes. Flow:
 *
 *   1. Origin discovery — find where the cursor currently is (strategy).
 *   2. Warmup + screenshot A (cursor rendered at start position).
 *   3. Emit open-loop move + screenshot B (cursor at landing).
 *   4. diff(A, B) → two cursor clusters separated by the commanded travel.
 *      pre ≈ origin + warmup; post ≈ actual landing. Compute live
 *      px/mickey from the real motion, not a different-magnitude probe.
 *   5. If |target − post| exceeds tolerance, loop: emit correction delta,
 *      screenshot C, diff B/C, update observed position. No probes.
 *
 * The diff has displacement on the order of the full open-loop travel
 * (often 500+ px on HDMI), so cursor clusters are easy to separate from
 * widget/icon noise (which typically changes tens of px). iPadOS's cursor
 * morphing still contaminates, but we mitigate by (a) expecting iPad users
 * to disable Pointer Animations in Accessibility settings and (b) filtering
 * candidate pairs by proximity to origin/predicted plus expected direction.
 */

import { PiKVMClient, ScreenResolution } from './client.js';
import {
  BallisticsProfile,
  lookupPxPerMickey,
  profileIsFreshFor,
  slamToCorner,
} from './ballistics.js';
import {
  Cluster,
  CursorTemplate,
  DecodedScreenshot,
  DEFAULT_DETECTION_CONFIG,
  decodeScreenshot,
  diffScreenshotsDecoded,
  extractCursorTemplateDecoded,
  findCursorByTemplateDecoded,
  loadCursorTemplate,
  locateCursor,
  saveCursorTemplate,
} from './cursor-detect.js';
import {
  detectBoundsOrNull,
  getLastGoodBounds,
  slamOriginFromBounds,
  LEGACY_PORTRAIT_SLAM_ORIGIN,
} from './orientation.js';
import { sleep } from './util.js';

export type MoveStrategy = 'detect-then-move' | 'slam-then-move' | 'assume-at';
export type Axis = 'x' | 'y';

export interface MoveToOptions {
  /** Cursor origin discovery. */
  strategy?: MoveStrategy;
  assumeCursorAt?: { x: number; y: number };
  slamOriginPx?: { x: number; y: number };
  slamFirst?: boolean;

  profile?: BallisticsProfile | null;
  fallbackPxPerMickey?: number;
  chunkMagnitude?: number;
  chunkPaceMs?: number;
  postMoveSettleMs?: number;

  /** Enable closed-loop correction (default true). */
  correct?: boolean;
  /** Max correction passes. Default 2. */
  maxCorrectionPasses?: number;
  /** Tolerance for early-exit (px). If observed |residual| below this in
   *  both axes, stop. Default 25. */
  minResidualPx?: number;

  /** Warmup move emitted before screenshot A so the cursor is rendered.
   *  Mickeys; default 8. */
  warmupMickeys?: number;
  /** Max distance (px) from origin where the "pre" cluster may be.
   *  Default 120. */
  preWindow?: number;
  /** Max distance (px) from predicted landing where the "post" cluster may be.
   *  Default 600 — wide enough to tolerate 2× acceleration variance on a
   *  iPad-size target. */
  postWindow?: number;

  /** Forwarded to slamToCorner when slam strategy is used. */
  slamCalls?: number;
  slamPaceMs?: number;
  verbose?: boolean;

  // -- Phase C: linear-region final approach -------------------------------
  // iPadOS pointer acceleration is velocity-dependent. Slow, small moves
  // land in a near-1:1 region with low variance — the only regime in which
  // open-loop emission is trustworthy. Once we're within
  // `linearTriggerResidualPx` of the target, switch to small-magnitude
  // slow-pace bursts and tighten the convergence target so passes stop at
  // single-digit residuals instead of bottoming out around `minResidualPx`.

  /** Per-call mickey size during the linear-region approach. Default 8 —
   *  small enough that iPadOS doesn't kick acceleration in. */
  linearChunkMagnitude?: number;
  /** Inter-call pace during the linear approach. Default 60 ms — slow
   *  enough that consecutive deltas don't accumulate into a fast burst. */
  linearChunkPaceMs?: number;
  /** Residual at which we drop into the linear regime. Default 100 px. */
  linearTriggerResidualPx?: number;
  /** Convergence target during the linear regime. Default 3 px. */
  linearResidualPx?: number;
  /** Max linear-regime passes (independent of `maxCorrectionPasses`).
   *  Default 4. */
  linearMaxPasses?: number;
  /** Per-axis sanity bounds for the live ratio update. Default [0.3, 5];
   *  loosened from the original [0.5, 3] which was rejecting real bursts
   *  on iPadOS and silently reverting to fallback. */
  ratioClampLo?: number;
  ratioClampHi?: number;

  /** When set, every frame captured during this move (shotA, shotB,
   *  per-pass shotC) is written to this directory as a JPEG. Use only
   *  for debugging — the disk traffic adds latency. */
  debugDir?: string;
}

export interface CorrectionPass {
  detectedCursor: { x: number; y: number };
  livePxPerMickey: number;
  correctionMickeys: { x: number; y: number };
  /** How the post-correction position was determined. `motion`: motion-
   *  diff succeeded. `template`: motion-diff failed and template-match
   *  succeeded. `predicted`: both detection paths failed; we trusted
   *  the open-loop prediction (and probably introduced error). */
  mode: 'motion' | 'template' | 'predicted';
  /** Free-form diagnostic: failure reason when motion-diff returned
   *  null, template-match score when fallback fired, etc. */
  reason: string | null;
}

/** A single step in moveToPixel's per-pass accounting. Tracks both the
 *  open-loop probe and every correction so the caller can see exactly
 *  where convergence stalled. */
export interface MovePassDiagnostic {
  /** 0 = the initial open-loop emission; 1..N = correction passes. */
  pass: number;
  /** Which detection path produced the post-position estimate. */
  mode: 'motion' | 'template' | 'predicted';
  /** Position estimate after this pass (motion-diff post centroid,
   *  template-match centre, or open-loop prediction). */
  detectedAt: { x: number; y: number };
  /** Euclidean residual to target. */
  residualPx: number;
  /** px/mickey ratio used to plan this pass's emission. */
  ratioUsed: { x: number; y: number };
  /** Why the chosen mode was used (motion-diff failure reason, template
   *  score, or "ok"). */
  reason: string | null;
  /** True if this pass was emitted in the slow/small linear-region
   *  approach mode (Phase C). */
  linearPhase: boolean;
}

export interface MoveToResult {
  screenshot: Buffer;
  screenshotWidth: number;
  screenshotHeight: number;
  target: { x: number; y: number };
  predicted: { x: number; y: number };
  emittedMickeys: { x: number; y: number };
  usedPxPerMickey: { x: number; y: number };
  chunkCount: number;
  strategy: MoveStrategy;
  corrections: CorrectionPass[];
  /** Per-pass accounting (open-loop + each correction). */
  diagnostics: MovePassDiagnostic[];
  /** Best-known cursor position after all moves. Comes from the last
   *  successful motion-diff or template-match detection; null if no
   *  detection ever succeeded (in which case the caller should treat
   *  accuracy as uncertain). */
  finalDetectedPosition: { x: number; y: number } | null;
  /** Final residual (Euclidean px from target to finalDetectedPosition).
   *  null when finalDetectedPosition is null. */
  finalResidualPx: number | null;
  resolution: ScreenResolution;
  message: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ============================================================================
// Stale-template-match guard.
//
// Problem: template-match has stable false positives — e.g., a button or
// glyph in the iPad UI that scores 0.74-0.82 against the cursor template.
// When motion-diff is failing in a noisy context, the algorithm trusts
// template-match. If the false positive is at a fixed location, every
// correction pass "finds" the cursor there and emits the same correction,
// burning the pass budget without progress.
//
// Detection: if template-match returns the same position (within 5 px)
// after we emitted ≥30 mickeys of correction in between, treat as stale
// and reject the match — the real cursor moved with the emission, but
// the false positive didn't.
// ============================================================================

/** Returns true if `current` should be rejected as a stale repeat of
 *  `previous` after a correction whose magnitude is `emittedMickeys`.
 *  Exported for unit tests. */
export function isStaleTemplateMatch(
  current: { x: number; y: number },
  previous: { x: number; y: number } | null,
  emittedMickeys: number,
): boolean {
  if (previous === null) return false;
  const drift = Math.hypot(current.x - previous.x, current.y - previous.y);
  // 5 px drift threshold: real cursor + JPEG noise rarely produces less
  // than this when actually re-detected.
  // 30 mickey emission threshold: smaller corrections may legitimately
  // not move the cursor enough to register a different match.
  return drift < 5 && emittedMickeys >= 30;
}

// ============================================================================
// Cursor template cache. Captured on first successful motion-diff, persisted
// to disk, and reused as a non-perturbing detection fallback when motion-diff
// fails (cursor faded, screen too noisy, etc.).
// ============================================================================

const TEMPLATE_PATH = './data/cursor-template.jpg';
let cachedTemplate: CursorTemplate | null | undefined; // undefined = unloaded

async function getCachedTemplate(): Promise<CursorTemplate | null> {
  if (cachedTemplate !== undefined) return cachedTemplate;
  cachedTemplate = await loadCursorTemplate(TEMPLATE_PATH).catch(() => null);
  return cachedTemplate;
}

async function maybePersistTemplate(
  screenshot: DecodedScreenshot,
  cursorPos: { x: number; y: number },
): Promise<void> {
  if (cachedTemplate) return; // already have one
  try {
    const t = extractCursorTemplateDecoded(screenshot, cursorPos, 32);
    cachedTemplate = t;
    await saveCursorTemplate(t, TEMPLATE_PATH);
  } catch {
    // Best-effort; failing to persist is non-fatal.
  }
}

// ============================================================================
// Origin discovery (unchanged from Phase 2)
// ============================================================================

async function discoverOrigin(
  client: PiKVMClient,
  options: MoveToOptions,
): Promise<{ point: { x: number; y: number }; method: MoveStrategy }> {
  const requested = options.strategy
    ?? (options.slamFirst === false ? 'assume-at' : 'detect-then-move');

  if (requested === 'assume-at') {
    if (!options.assumeCursorAt) {
      throw new Error("strategy='assume-at' requires assumeCursorAt");
    }
    return { point: options.assumeCursorAt, method: 'assume-at' };
  }

  if (requested === 'detect-then-move') {
    const located = await locateCursor(client, {
      probeDelta: 20,
      settleMs: 120,
      detection: { brightnessFloor: 170 },
      maxAttempts: 2,
      verbose: options.verbose,
    });
    if (located) {
      return { point: located.position, method: 'detect-then-move' };
    }
    if (options.verbose) console.error('[move-to] detect-then-move failed; falling back to slam');
  }

  // Auto-detect iPad bounds for the slam origin if not explicitly set,
  // so landscape and non-default-letterbox iPads work without configuration.
  // Fast path: if we already have a sane cached detection from earlier in
  // this process, reuse it instead of re-decoding + re-scanning a fresh
  // screenshot (~50 ms saving per call on tight loops).
  let slamOrigin = options.slamOriginPx;
  if (!slamOrigin) {
    let bounds = getLastGoodBounds();
    if (bounds) {
      if (options.verbose) {
        console.error(
          `[move-to] using cached ${bounds.orientation} bounds ${bounds.width}×${bounds.height} (no re-detection)`,
        );
      }
    } else {
      bounds = await detectBoundsOrNull(client, {
        verbose: options.verbose,
        logPrefix: 'move-to',
      });
    }
    if (bounds) {
      slamOrigin = slamOriginFromBounds(bounds);
      if (options.verbose) {
        console.error(
          `[move-to] auto-detected ${bounds.orientation} slam-origin (${slamOrigin.x},${slamOrigin.y})`,
        );
      }
    } else {
      slamOrigin = LEGACY_PORTRAIT_SLAM_ORIGIN;
    }
  }

  await slamToCorner(client, {
    calls: options.slamCalls,
    paceMs: options.slamPaceMs,
    corner: 'top-left',
    verbose: options.verbose,
  });
  return { point: slamOrigin, method: 'slam-then-move' };
}

// ============================================================================
// Chunked relative emission
// ============================================================================

async function emitChunked(
  client: PiKVMClient,
  totalX: number,
  totalY: number,
  chunkMag: number,
  chunkPaceMs: number,
): Promise<number> {
  let remX = Math.abs(totalX);
  let remY = Math.abs(totalY);
  const sx = Math.sign(totalX);
  const sy = Math.sign(totalY);
  let chunks = 0;
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(chunkMag, remX) * sx : 0;
    const stepY = remY > 0 ? Math.min(chunkMag, remY) * sy : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX = Math.max(0, remX - Math.abs(stepX));
    remY = Math.max(0, remY - Math.abs(stepY));
    chunks++;
    if (chunkPaceMs > 0 && (remX > 0 || remY > 0)) await sleep(chunkPaceMs);
  }
  return chunks;
}

// ============================================================================
// Motion diff — find a cursor pair whose displacement matches a commanded
// move, anchored by a known starting neighbourhood and a predicted landing.
// ============================================================================

interface MotionPair {
  pre: Cluster;
  post: Cluster;
  displacement: { x: number; y: number };
  livePxPerMickey: number;
}

/** Return shape for `detectMotion`. On success carries the pair; on
 *  failure carries a structured reason so callers can surface it in
 *  diagnostics rather than silently trusting prediction. */
interface MotionDiffResult {
  pair: MotionPair | null;
  /** Compact human-readable failure reason; null on success. Rendered into
   *  CorrectionPass.reason and the [move-to] WARN log line. */
  reason: string | null;
  /** Cluster bookkeeping for diagnostics. */
  rawClusters: number;
  sizedClusters: number;
  preCandidates: number;
  postCandidates: number;
}

/** Exported for unit tests. Not part of the public MCP tool surface. */
export function detectMotion(
  a: DecodedScreenshot,
  b: DecodedScreenshot,
  expectedStart: { x: number; y: number },
  expectedEnd: { x: number; y: number },
  commandedMickeys: { x: number; y: number },
  preWindow: number,
  postWindow: number,
  verbose: boolean,
  clusterMin: number = 8,
  clusterMax: number = 90,
  brightnessFloor: number = 100,
): MotionDiffResult {
  // brightnessFloor lowered from 170 → 100. Cursor pixels rendered over
  // a dimmed-modal scrim or a dark wallpaper land in 100–160 range; the
  // 170 floor was rejecting them entirely and motion-diff returned zero
  // clusters. 100 still rejects most non-cursor noise (dark UI elements
  // are below 100 per channel) while catching cursor on dim contexts.
  // Verified empirically with a frame-by-frame trace 2026-04-25.
  const clusters = diffScreenshotsDecoded(a, b, {
    ...DEFAULT_DETECTION_CONFIG,
    brightnessFloor,
    mergeRadius: 18,
  });

  // Cursor is typically 15-50 px steady, can blur to ~70 px during fast
  // bursts. Tighten this range to reject iPadOS pointer-effect highlights
  // on icons (which are 100+ px) and widget animations (variable).
  const sized = clusters.filter((c) => c.pixels >= clusterMin && c.pixels <= clusterMax);

  const dist = (c: Cluster, p: { x: number; y: number }) =>
    Math.hypot(c.centroidX - p.x, c.centroidY - p.y);

  const preCandidatesWindow = sized.filter((c) => dist(c, expectedStart) <= preWindow);
  const postCandidates = sized.filter((c) => dist(c, expectedEnd) <= postWindow);

  // Fallback: if the windowed pre-search came up empty but we have
  // multiple sized clusters, the cursor probably wasn't where we
  // expected (slam mis-anchored, prior trial drifted, modal trapping,
  // etc.). Open the pre-pool to ALL sized clusters; the direction +
  // magnitude validation downstream still keeps bad pairs out.
  let preCandidates = preCandidatesWindow;
  let preWindowExpanded = false;
  if (preCandidatesWindow.length === 0 && sized.length >= 2) {
    preCandidates = sized;
    preWindowExpanded = true;
  }

  if (verbose) {
    console.error(
      `[motion] ${clusters.length} total, ${sized.length} cursor-sized [${clusterMin}-${clusterMax}px]; ` +
        `pre-cands(window=${preWindow}@${Math.round(expectedStart.x)},${Math.round(expectedStart.y)})=${preCandidatesWindow.length}` +
        `${preWindowExpanded ? ` →expanded to ${preCandidates.length} (no pre in window)` : ''}, ` +
        `post-cands(window=${postWindow}@${Math.round(expectedEnd.x)},${Math.round(expectedEnd.y)})=${postCandidates.length}`,
    );
  }

  const result = (pair: MotionPair | null, reason: string | null): MotionDiffResult => ({
    pair, reason,
    rawClusters: clusters.length,
    sizedClusters: sized.length,
    preCandidates: preCandidates.length,
    postCandidates: postCandidates.length,
  });

  if (sized.length === 0) {
    return result(null, `no clusters in ${clusterMin}-${clusterMax}px size range (raw=${clusters.length})`);
  }
  if (preCandidates.length === 0 && postCandidates.length === 0) {
    return result(null, 'no pre or post candidates within search windows');
  }
  if (preCandidates.length === 0) {
    return result(null, `no pre candidate within ${preWindow}px of expected start (and only ${sized.length} sized cluster total)`);
  }
  if (postCandidates.length === 0) {
    return result(null, `no post candidate within ${postWindow}px of expected end`);
  }

  // Commanded direction in px (approximate — magnitude is approximate
  // because we haven't measured the actual ratio yet; we use direction only
  // for pair validation).
  const expectedDx = expectedEnd.x - expectedStart.x;
  const expectedDy = expectedEnd.y - expectedStart.y;
  const expectedDist = Math.hypot(expectedDx, expectedDy);
  const unit = expectedDist > 0
    ? { x: expectedDx / expectedDist, y: expectedDy / expectedDist }
    : { x: 1, y: 0 };

  const maxMickeys = Math.max(Math.abs(commandedMickeys.x), Math.abs(commandedMickeys.y));

  let best: { pair: MotionPair; score: number } | null = null;
  for (const pre of preCandidates) {
    for (const post of postCandidates) {
      if (pre === post) continue;
      const dispX = post.centroidX - pre.centroidX;
      const dispY = post.centroidY - pre.centroidY;
      const dispMag = Math.hypot(dispX, dispY);
      if (dispMag < 10) continue; // too short — probably the same cluster or noise

      // Direction must roughly match commanded (dot product along unit).
      const along = dispX * unit.x + dispY * unit.y;
      if (along <= 0) continue;
      // Reject pairs whose direction diverges > 45° from commanded.
      if (along / dispMag < 0.7) continue;

      const livePxPerMickey = maxMickeys > 0 ? dispMag / maxMickeys : 1;
      // Sanity: ratio must be in [0.3, 4] — iPad is ~1-2, anything wilder
      // is probably a bad pair.
      if (livePxPerMickey < 0.3 || livePxPerMickey > 4) continue;

      // Score: prefer pairs whose post is close to expectedEnd AND pre is
      // close to expectedStart, with similar sizes.
      const sizeRatio = Math.max(pre.pixels, post.pixels) /
        Math.max(1, Math.min(pre.pixels, post.pixels));
      if (sizeRatio > 4) continue;

      const score =
        -dist(post, expectedEnd)
        - dist(pre, expectedStart)
        - 30 * Math.log2(sizeRatio);
      if (!best || score > best.score) {
        best = {
          pair: {
            pre,
            post,
            displacement: { x: dispX, y: dispY },
            livePxPerMickey,
          },
          score,
        };
      }
    }
  }

  if (verbose && best) {
    console.error(
      `[motion] picked pre=(${best.pair.pre.centroidX},${best.pair.pre.centroidY},${best.pair.pre.pixels}px) ` +
        `post=(${best.pair.post.centroidX},${best.pair.post.centroidY},${best.pair.post.pixels}px) ` +
        `disp=(${best.pair.displacement.x},${best.pair.displacement.y}) ratio=${best.pair.livePxPerMickey.toFixed(3)}`,
    );
  }

  if (best) return result(best.pair, null);
  return result(null, `${preCandidates.length}×${postCandidates.length} cands considered, no pair passed direction/sanity filters`);
}

// ============================================================================
// Main entry
// ============================================================================

export async function moveToPixel(
  client: PiKVMClient,
  target: { x: number; y: number },
  options: MoveToOptions = {},
): Promise<MoveToResult> {
  const resolution = await client.getResolution(true);

  // Phase B defaults — tuned from live observation of this iPad:
  // - fallback 1.3 → 1.0  (the linear-region value)
  // - minResidualPx 25 → 8
  // - maxCorrectionPasses 2 → 5
  // - cluster filter 10-60 → 8-90 (handles motion blur on fast bursts)
  // - ratio clamp [0.5, 3] → [0.3, 5] (don't reject real bursts)
  const fallback = options.fallbackPxPerMickey ?? 1.0;
  const chunkMag = options.chunkMagnitude ?? 60;
  const chunkPaceMs = options.chunkPaceMs ?? 20;
  const postSettleMs = options.postMoveSettleMs ?? 30;
  const doCorrect = options.correct !== false;
  const maxPasses = options.maxCorrectionPasses ?? 5;
  const minResidualPx = options.minResidualPx ?? 8;
  const warmupMickeys = options.warmupMickeys ?? 8;
  const preWindow = options.preWindow ?? 120;
  const postWindow = options.postWindow ?? 600;
  const verbose = options.verbose ?? false;
  const ratioLo = options.ratioClampLo ?? 0.3;
  const ratioHi = options.ratioClampHi ?? 5;
  // Phase C: linear-region approach knobs.
  const linChunkMag = options.linearChunkMagnitude ?? 8;
  const linChunkPaceMs = options.linearChunkPaceMs ?? 60;
  const linTriggerPx = options.linearTriggerResidualPx ?? 100;
  const linResidualPx = options.linearResidualPx ?? 3;
  const linMaxPasses = options.linearMaxPasses ?? 4;
  // Cursor cluster size range (Phase B): widened from 10-60 to 8-90.
  const clusterMin = 8;
  const clusterMax = 90;

  // Phase B: validate ballistics profile freshness against current
  // resolution. A profile measured on a different device silently
  // mis-predicts every move; better to drop it and warn.
  let profile: BallisticsProfile | null = options.profile ?? null;
  if (profile) {
    const profileRes = profile.resolution;
    if (!profileIsFreshFor(profile, resolution)) {
      if (verbose) {
        console.error(
          `[move-to] WARN profile resolution ${profileRes.width}×${profileRes.height} ` +
            `does not match current ${resolution.width}×${resolution.height}; dropping profile, using fallback ${fallback}`,
        );
      }
      profile = null;
    }
  }

  const pxPerMickeyX =
    (profile && lookupPxPerMickey(profile, 'x', chunkMag, 'slow')) ?? fallback;
  const pxPerMickeyY =
    (profile && lookupPxPerMickey(profile, 'y', chunkMag, 'slow')) ?? fallback;

  const targetX = clamp(Math.round(target.x), 0, resolution.width - 1);
  const targetY = clamp(Math.round(target.y), 0, resolution.height - 1);

  // 1. Origin discovery
  const discovered = await discoverOrigin(client, options);
  const origin = discovered.point;
  const actualStrategy = discovered.method;

  const dxPx = targetX - origin.x;
  const dyPx = targetY - origin.y;
  const rawMickeysX = Math.round(Math.abs(dxPx) / pxPerMickeyX);
  const rawMickeysY = Math.round(Math.abs(dyPx) / pxPerMickeyY);
  const signX = dxPx >= 0 ? 1 : -1;
  const signY = dyPx >= 0 ? 1 : -1;

  const predicted = {
    x: origin.x + signX * rawMickeysX * pxPerMickeyX,
    y: origin.y + signY * rawMickeysY * pxPerMickeyY,
  };

  // 2. Warmup — ensure cursor is rendered at screenshot-A time.
  //    Warmup direction matches the measurement axis (commanded direction).
  const warmupAxis: Axis = Math.abs(dxPx) >= Math.abs(dyPx) ? 'x' : 'y';
  const warmupSign = warmupAxis === 'x' ? signX : signY;
  const warmupX = warmupAxis === 'x' ? warmupMickeys * warmupSign : 0;
  const warmupY = warmupAxis === 'y' ? warmupMickeys * warmupSign : 0;
  if (warmupMickeys > 0) {
    await client.mouseMoveRelative(warmupX, warmupY);
    await sleep(100);
  }

  // After warmup, estimated cursor position (for pre-window matching) is
  // origin + warmup * fallback (small; just a better guess than origin).
  const warmupPxX = warmupX * pxPerMickeyX;
  const warmupPxY = warmupY * pxPerMickeyY;
  const postWarmupExpected = {
    x: origin.x + warmupPxX,
    y: origin.y + warmupPxY,
  };

  // 3. Screenshot A — decoded once and reused for diffs / template extraction.
  const shotA = await decodeScreenshot((await client.screenshot()).buffer);

  // 4. Open-loop emission
  const openMickeysX = signX * rawMickeysX;
  const openMickeysY = signY * rawMickeysY;
  const chunkCount = await emitChunked(client, openMickeysX, openMickeysY, chunkMag, chunkPaceMs);

  // Settle briefly so the streamer catches up and cursor is still visible.
  if (postSettleMs > 0) await sleep(postSettleMs);

  // 5. Screenshot B
  const shotB = await decodeScreenshot((await client.screenshot()).buffer);

  // 6. Motion diff (open-loop)
  const corrections: CorrectionPass[] = [];
  const diagnostics: MovePassDiagnostic[] = [];
  let finalDetectedPosition: { x: number; y: number } | null = null;
  let observedRatioX = pxPerMickeyX;
  let observedRatioY = pxPerMickeyY;
  let currentPos: { x: number; y: number };
  let openLoopMode: 'motion' | 'template' | 'predicted' = 'predicted';
  let openLoopReason: string | null = null;

  // Debug: when verbose, dump the frame pair so failures can be inspected.
  const debugDir = options.debugDir ?? null;
  if (debugDir) {
    await import('fs').then((fs) => fs.promises.mkdir(debugDir, { recursive: true }));
    await import('fs').then((fs) =>
      fs.promises.writeFile(`${debugDir}/00-shotA.jpg`, shotA.buffer)
    );
    await import('fs').then((fs) =>
      fs.promises.writeFile(`${debugDir}/01-shotB.jpg`, shotB.buffer)
    );
  }

  const motionResult = doCorrect
    ? detectMotion(
        shotA,
        shotB,
        postWarmupExpected,
        predicted,
        { x: openMickeysX, y: openMickeysY },
        preWindow,
        postWindow,
        verbose,
        clusterMin,
        clusterMax,
      )
    : null;

  if (motionResult && motionResult.pair) {
    const motion = motionResult.pair;
    currentPos = { x: motion.post.centroidX, y: motion.post.centroidY };
    // Update ratios from observed motion (only for the dominant axis).
    if (Math.abs(openMickeysX) > Math.abs(openMickeysY)) {
      observedRatioX = Math.abs(motion.displacement.x) / Math.max(1, Math.abs(openMickeysX));
    } else {
      observedRatioY = Math.abs(motion.displacement.y) / Math.max(1, Math.abs(openMickeysY));
    }
    if (observedRatioX < ratioLo || observedRatioX > ratioHi) observedRatioX = fallback;
    if (observedRatioY < ratioLo || observedRatioY > ratioHi) observedRatioY = fallback;
    finalDetectedPosition = { ...currentPos };
    openLoopMode = 'motion';
    openLoopReason = `live ratio ${motion.livePxPerMickey.toFixed(3)}`;
    await maybePersistTemplate(shotB, currentPos);
  } else {
    // Motion-diff failed. Try template matching as a fallback.
    const motionFailReason = motionResult ? motionResult.reason : 'correction disabled';
    if (verbose && doCorrect) {
      console.error(`[move-to] motion-diff returned null: ${motionFailReason}`);
    }
    const tmpl = await getCachedTemplate();
    if (tmpl) {
      const found = findCursorByTemplateDecoded(shotB, tmpl, {
        searchCentre: predicted,
        searchWindow: postWindow,
        verbose,
      });
      if (found) {
        currentPos = found.position;
        finalDetectedPosition = { ...currentPos };
        openLoopMode = 'template';
        openLoopReason = `template-match score=${found.score.toFixed(3)} (motion: ${motionFailReason})`;
        if (verbose) {
          console.error(
            `[move-to] motion-diff failed; template match found cursor at (${found.position.x},${found.position.y}) score=${found.score.toFixed(3)}`,
          );
        }
      } else {
        currentPos = { ...predicted };
        openLoopMode = 'predicted';
        openLoopReason = `template-match below threshold (motion: ${motionFailReason})`;
        if (verbose) {
          console.error(
            `[move-to] WARN open-loop: motion-diff (${motionFailReason}) AND template-match both failed; trusting prediction`,
          );
        }
      }
    } else {
      currentPos = { ...predicted };
      openLoopMode = 'predicted';
      openLoopReason = `no template cached (motion: ${motionFailReason})`;
      if (verbose && doCorrect) {
        console.error(
          `[move-to] WARN open-loop: motion-diff failed (${motionFailReason}) and no cursor template cached; trusting prediction`,
        );
      }
    }
  }

  // Track template-match position to catch stable false positives.
  let lastTemplateMatch: { x: number; y: number } | null =
    openLoopMode === 'template' ? { ...currentPos } : null;

  diagnostics.push({
    pass: 0,
    mode: openLoopMode,
    detectedAt: { ...currentPos },
    residualPx: Math.hypot(currentPos.x - targetX, currentPos.y - targetY),
    ratioUsed: { x: observedRatioX, y: observedRatioY },
    reason: openLoopReason,
    linearPhase: false,
  });

  // 7. Correction passes — each diffs before/after its own delta.
  let prevShot = shotB;
  let prevPos = currentPos;
  let linearEntered = false;
  let totalPasses = 0;

  if (doCorrect) {
    // Combined budget: at most maxPasses gross + linMaxPasses linear.
    // We always ALLOW the linear phase to start once residual drops
    // below the trigger; it has its own pass budget.
    let grossPassesUsed = 0;
    let linearPassesUsed = 0;

    while (true) {
      const errX = targetX - currentPos.x;
      const errY = targetY - currentPos.y;
      const residual = Math.hypot(errX, errY);

      // Decide which regime we're in. Phase C: enter linear region as
      // soon as residual is small enough that small/slow chunks can
      // span it without acceleration kicking in.
      const useLinear = residual <= linTriggerPx;
      const passLimit = useLinear ? linMaxPasses : maxPasses;
      const passUsed = useLinear ? linearPassesUsed : grossPassesUsed;
      const stopPx = useLinear ? linResidualPx : minResidualPx;
      const usedChunkMag = useLinear ? linChunkMag : chunkMag;
      const usedChunkPaceMs = useLinear ? linChunkPaceMs : chunkPaceMs;

      if (residual < stopPx) {
        if (verbose) {
          console.error(
            `[move-to] pass ${totalPasses}: residual ${residual.toFixed(1)}px within ${useLinear ? 'linear' : 'gross'} tolerance ${stopPx}px; done.`,
          );
        }
        break;
      }
      if (passUsed >= passLimit) {
        if (verbose) {
          console.error(
            `[move-to] ${useLinear ? 'linear' : 'gross'} pass budget exhausted at ${passLimit}; remaining residual ${residual.toFixed(1)}px`,
          );
        }
        break;
      }

      if (useLinear && !linearEntered) {
        linearEntered = true;
        if (verbose) {
          console.error(
            `[move-to] entering LINEAR phase: residual=${residual.toFixed(1)}px ≤ ${linTriggerPx}px; ` +
              `chunkMag=${linChunkMag} pace=${linChunkPaceMs}ms target≤${linResidualPx}px`,
          );
        }
      }

      const corrMickeysX = Math.round(errX / observedRatioX);
      const corrMickeysY = Math.round(errY / observedRatioY);
      if (corrMickeysX === 0 && corrMickeysY === 0) {
        if (verbose) console.error(`[move-to] pass ${totalPasses + 1}: zero-mickey correction; cannot improve further.`);
        break;
      }

      const newPredicted = {
        x: currentPos.x + corrMickeysX * observedRatioX,
        y: currentPos.y + corrMickeysY * observedRatioY,
      };

      if (verbose) {
        console.error(
          `[move-to] ${useLinear ? 'linear' : 'gross'} pass ${totalPasses + 1}: ` +
            `err=(${errX.toFixed(1)},${errY.toFixed(1)}) → mickeys=(${corrMickeysX},${corrMickeysY}) ` +
            `@ ratio=(${observedRatioX.toFixed(3)},${observedRatioY.toFixed(3)}) chunk=${usedChunkMag} pace=${usedChunkPaceMs}ms`,
        );
      }

      await emitChunked(client, corrMickeysX, corrMickeysY, usedChunkMag, usedChunkPaceMs);
      await sleep(postSettleMs);
      const shotC = await decodeScreenshot((await client.screenshot()).buffer);
      if (debugDir) {
        const tag = String(totalPasses + 1).padStart(2, '0');
        const phaseTag = useLinear ? 'L' : 'G';
        await import('fs').then((fs) =>
          fs.promises.writeFile(`${debugDir}/${tag}-${phaseTag}-pass-shotC.jpg`, shotC.buffer)
        );
      }

      const cResult = detectMotion(
        prevShot,
        shotC,
        prevPos,
        newPredicted,
        { x: corrMickeysX, y: corrMickeysY },
        preWindow,
        postWindow,
        verbose,
        clusterMin,
        clusterMax,
      );

      let passMode: 'motion' | 'template' | 'predicted' = 'predicted';
      let passReason: string | null = null;

      if (cResult.pair) {
        const cMotion = cResult.pair;
        currentPos = { x: cMotion.post.centroidX, y: cMotion.post.centroidY };
        if (Math.abs(corrMickeysX) > Math.abs(corrMickeysY)) {
          const r = Math.abs(cMotion.displacement.x) / Math.max(1, Math.abs(corrMickeysX));
          if (r >= ratioLo && r <= ratioHi) observedRatioX = r;
        } else {
          const r = Math.abs(cMotion.displacement.y) / Math.max(1, Math.abs(corrMickeysY));
          if (r >= ratioLo && r <= ratioHi) observedRatioY = r;
        }
        finalDetectedPosition = { ...currentPos };
        passMode = 'motion';
        passReason = `live ratio ${cMotion.livePxPerMickey.toFixed(3)}`;
      } else {
        // Motion-diff failed on correction — try template match before
        // falling back to prediction.
        const motionFailReason = cResult.reason ?? 'unknown';
        const tmpl = await getCachedTemplate();
        let templated = false;
        if (tmpl) {
          const found = findCursorByTemplateDecoded(shotC, tmpl, {
            searchCentre: newPredicted,
            searchWindow: postWindow,
            verbose,
          });
          if (found) {
            // Stable false-positive guard: if template-match returns the
            // same spot it returned last pass after we emitted significant
            // mickeys, the match is not the cursor — the cursor moved.
            const emittedMag = Math.hypot(corrMickeysX, corrMickeysY);
            if (isStaleTemplateMatch(found.position, lastTemplateMatch, emittedMag)) {
              if (verbose) {
                console.error(
                  `[move-to] WARN pass ${totalPasses + 1}: template-match returned stale position (${found.position.x},${found.position.y}) after ${emittedMag.toFixed(0)} mickeys emitted — rejecting as stable false positive`,
                );
              }
              passMode = 'predicted';
              passReason = `template-match stale at (${found.position.x},${found.position.y}) after ${emittedMag.toFixed(0)} mickeys`;
              currentPos = newPredicted;
              templated = true;
            } else {
              currentPos = found.position;
              finalDetectedPosition = { ...currentPos };
              lastTemplateMatch = { ...found.position };
              passMode = 'template';
              passReason = `template score=${found.score.toFixed(3)} (motion: ${motionFailReason})`;
              templated = true;
              if (verbose) {
                console.error(
                  `[move-to] WARN pass ${totalPasses + 1}: motion-diff failed (${motionFailReason}); template-match recovered cursor at (${found.position.x},${found.position.y}) score=${found.score.toFixed(3)}`,
                );
              }
            }
          }
        }
        if (!templated) {
          currentPos = newPredicted;
          passMode = 'predicted';
          passReason = `motion: ${motionFailReason}; no template fallback`;
          if (verbose) {
            console.error(
              `[move-to] WARN pass ${totalPasses + 1}: motion-diff failed (${motionFailReason}) AND template-match unavailable; trusting prediction`,
            );
          }
        }
      }

      corrections.push({
        detectedCursor: cResult.pair
          ? { x: cResult.pair.post.centroidX, y: cResult.pair.post.centroidY }
          : { x: Math.round(currentPos.x), y: Math.round(currentPos.y) },
        livePxPerMickey: cResult.pair?.livePxPerMickey ?? (observedRatioX + observedRatioY) / 2,
        correctionMickeys: { x: corrMickeysX, y: corrMickeysY },
        mode: passMode,
        reason: passReason,
      });

      diagnostics.push({
        pass: totalPasses + 1,
        mode: passMode,
        detectedAt: { ...currentPos },
        residualPx: Math.hypot(currentPos.x - targetX, currentPos.y - targetY),
        ratioUsed: { x: observedRatioX, y: observedRatioY },
        reason: passReason,
        linearPhase: useLinear,
      });

      prevShot = shotC;
      prevPos = currentPos;
      totalPasses++;
      if (useLinear) linearPassesUsed++;
      else grossPassesUsed++;
    }
  }

  const shot = await client.screenshot();

  const finalResidualPx = finalDetectedPosition
    ? Math.hypot(finalDetectedPosition.x - targetX, finalDetectedPosition.y - targetY)
    : null;

  const parts: string[] = [];
  parts.push(`Target (${targetX},${targetY}).`);
  parts.push(`Origin via ${actualStrategy} at (${Math.round(origin.x)},${Math.round(origin.y)}).`);
  parts.push(
    `Open-loop emitted ${Math.abs(openMickeysX)}X+${Math.abs(openMickeysY)}Y mickeys in ${chunkCount} chunk(s); ` +
      `default px/mickey=(${pxPerMickeyX.toFixed(2)},${pxPerMickeyY.toFixed(2)}).`,
  );
  parts.push(`Open-loop landing via ${openLoopMode}: ${openLoopReason ?? 'n/a'}.`);
  if (corrections.length > 0) {
    const grossCount = corrections.filter((_, i) => !diagnostics[i + 1]?.linearPhase).length;
    const linearCount = corrections.length - grossCount;
    parts.push(
      `${corrections.length} correction pass(es) (${grossCount} gross, ${linearCount} linear); ` +
        `last applied (${corrections[corrections.length - 1].correctionMickeys.x},${corrections[corrections.length - 1].correctionMickeys.y}) mickeys.`,
    );
    const lastFailures = corrections.filter((c) => c.mode !== 'motion').length;
    if (lastFailures > 0) {
      parts.push(`${lastFailures}/${corrections.length} pass(es) used template/predicted fallback (motion-diff blind).`);
    }
  }
  if (linearEntered) {
    parts.push(`Linear approach engaged; final ratio ≈ (${observedRatioX.toFixed(2)}, ${observedRatioY.toFixed(2)}).`);
  }
  if (finalDetectedPosition && finalResidualPx !== null) {
    parts.push(
      `Final cursor at (${finalDetectedPosition.x},${finalDetectedPosition.y}); ` +
        `residual (${finalDetectedPosition.x - targetX},${finalDetectedPosition.y - targetY}) = ${finalResidualPx.toFixed(1)}px.`,
    );
  } else if (doCorrect) {
    parts.push('Final position not detected — click accuracy uncertain.');
  }
  if (actualStrategy === 'slam-then-move' && options.strategy === 'detect-then-move') {
    parts.push('WARNING: detect-origin fell back to slam; iPad may have re-locked via hot corner.');
  }

  return {
    screenshot: shot.buffer,
    screenshotWidth: shot.screenshotWidth,
    screenshotHeight: shot.screenshotHeight,
    target: { x: targetX, y: targetY },
    predicted,
    emittedMickeys: { x: Math.abs(openMickeysX), y: Math.abs(openMickeysY) },
    usedPxPerMickey: { x: observedRatioX, y: observedRatioY },
    chunkCount,
    strategy: actualStrategy,
    corrections,
    diagnostics,
    finalDetectedPosition,
    finalResidualPx,
    resolution,
    message: parts.join(' '),
  };
}
