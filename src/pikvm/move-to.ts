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
  slamToCorner,
} from './ballistics.js';
import {
  Cluster,
  CursorTemplate,
  DEFAULT_DETECTION_CONFIG,
  diffScreenshots,
  extractCursorTemplate,
  findCursorByTemplate,
  loadCursorTemplate,
  locateCursor,
  saveCursorTemplate,
} from './cursor-detect.js';
import {
  detectIpadBounds,
  slamOriginFromBounds,
} from './orientation.js';

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
}

export interface CorrectionPass {
  detectedCursor: { x: number; y: number };
  livePxPerMickey: number;
  correctionMickeys: { x: number; y: number };
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
  /** Best-known cursor position after all moves. Comes from the last
   *  successful motion-diff detection; null if detection never
   *  succeeded (in which case the caller should treat accuracy as
   *  uncertain). */
  finalDetectedPosition: { x: number; y: number } | null;
  resolution: ScreenResolution;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  screenshot: Buffer,
  cursorPos: { x: number; y: number },
): Promise<void> {
  if (cachedTemplate) return; // already have one
  try {
    const t = await extractCursorTemplate(screenshot, cursorPos, 32);
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
  let slamOrigin = options.slamOriginPx;
  if (!slamOrigin) {
    try {
      const bounds = await detectIpadBounds(client, { verbose: options.verbose });
      slamOrigin = slamOriginFromBounds(bounds);
      if (options.verbose) {
        console.error(
          `[move-to] auto-detected ${bounds.orientation} slam-origin (${slamOrigin.x},${slamOrigin.y})`,
        );
      }
    } catch (e) {
      if (options.verbose) console.error(`[move-to] bounds detection failed: ${(e as Error).message}; using portrait default`);
      slamOrigin = { x: 625, y: 65 };
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

async function detectMotion(
  a: Buffer,
  b: Buffer,
  expectedStart: { x: number; y: number },
  expectedEnd: { x: number; y: number },
  commandedMickeys: { x: number; y: number },
  preWindow: number,
  postWindow: number,
  verbose: boolean,
): Promise<MotionPair | null> {
  const clusters = await diffScreenshots(a, b, {
    ...DEFAULT_DETECTION_CONFIG,
    brightnessFloor: 170,
    mergeRadius: 18,
  });

  // Cursor is typically 15-50 px. Tighten this range to reject iPadOS
  // pointer-effect highlights on icons (which are 80-200 px) and widget
  // animations (which vary).
  const sized = clusters.filter((c) => c.pixels >= 10 && c.pixels <= 60);

  const dist = (c: Cluster, p: { x: number; y: number }) =>
    Math.hypot(c.centroidX - p.x, c.centroidY - p.y);

  const preCandidates = sized.filter((c) => dist(c, expectedStart) <= preWindow);
  const postCandidates = sized.filter((c) => dist(c, expectedEnd) <= postWindow);

  if (verbose) {
    console.error(
      `[motion] ${clusters.length} total, ${sized.length} cursor-sized; ` +
        `pre-cands(window=${preWindow}@${Math.round(expectedStart.x)},${Math.round(expectedStart.y)})=${preCandidates.length}, ` +
        `post-cands(window=${postWindow}@${Math.round(expectedEnd.x)},${Math.round(expectedEnd.y)})=${postCandidates.length}`,
    );
  }

  if (preCandidates.length === 0 || postCandidates.length === 0) return null;

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

  return best ? best.pair : null;
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

  const fallback = options.fallbackPxPerMickey ?? 1.3;
  const chunkMag = options.chunkMagnitude ?? 60;
  const chunkPaceMs = options.chunkPaceMs ?? 20;
  const postSettleMs = options.postMoveSettleMs ?? 30;
  const doCorrect = options.correct !== false;
  const maxPasses = options.maxCorrectionPasses ?? 2;
  const minResidualPx = options.minResidualPx ?? 25;
  const warmupMickeys = options.warmupMickeys ?? 8;
  const preWindow = options.preWindow ?? 120;
  const postWindow = options.postWindow ?? 600;
  const verbose = options.verbose ?? false;

  const pxPerMickeyX =
    (options.profile && lookupPxPerMickey(options.profile, 'x', chunkMag, 'slow')) ?? fallback;
  const pxPerMickeyY =
    (options.profile && lookupPxPerMickey(options.profile, 'y', chunkMag, 'slow')) ?? fallback;

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

  // 3. Screenshot A
  const shotA = await client.screenshot();

  // 4. Open-loop emission
  const openMickeysX = signX * rawMickeysX;
  const openMickeysY = signY * rawMickeysY;
  const chunkCount = await emitChunked(client, openMickeysX, openMickeysY, chunkMag, chunkPaceMs);

  // Settle briefly so the streamer catches up and cursor is still visible.
  if (postSettleMs > 0) await sleep(postSettleMs);

  // 5. Screenshot B
  const shotB = await client.screenshot();

  // 6. Motion diff (open-loop)
  const corrections: CorrectionPass[] = [];
  let finalDetectedPosition: { x: number; y: number } | null = null;
  let observedRatioX = pxPerMickeyX;
  let observedRatioY = pxPerMickeyY;
  let currentPos: { x: number; y: number };

  const motion = doCorrect
    ? await detectMotion(
        shotA.buffer,
        shotB.buffer,
        postWarmupExpected,
        predicted,
        { x: openMickeysX, y: openMickeysY },
        preWindow,
        postWindow,
        verbose,
      )
    : null;

  if (motion) {
    currentPos = { x: motion.post.centroidX, y: motion.post.centroidY };
    // Update ratios from observed motion (only for the dominant axis).
    if (Math.abs(openMickeysX) > Math.abs(openMickeysY)) {
      observedRatioX = Math.abs(motion.displacement.x) / Math.max(1, Math.abs(openMickeysX));
    } else {
      observedRatioY = Math.abs(motion.displacement.y) / Math.max(1, Math.abs(openMickeysY));
    }
    // Use same ratio on the other axis if no info.
    if (observedRatioX < 0.5 || observedRatioX > 3) observedRatioX = fallback;
    if (observedRatioY < 0.5 || observedRatioY > 3) observedRatioY = fallback;
    finalDetectedPosition = { ...currentPos };

    // Capture & persist a cursor template on first success — useful as a
    // non-perturbing detection fallback for future calls.
    await maybePersistTemplate(shotB.buffer, currentPos);
  } else {
    // Motion-diff failed. Try template matching as a fallback — this
    // doesn't require any cursor movement and is robust to widget noise.
    const tmpl = await getCachedTemplate();
    if (tmpl) {
      const found = await findCursorByTemplate(shotB.buffer, tmpl, {
        searchCentre: predicted,
        searchWindow: postWindow,
        verbose,
      });
      if (found) {
        currentPos = found.position;
        finalDetectedPosition = { ...currentPos };
        if (verbose) {
          console.error(
            `[move-to] motion-diff failed; template match found cursor at (${found.position.x},${found.position.y}) score=${found.score.toFixed(3)}`,
          );
        }
      } else {
        currentPos = { ...predicted };
      }
    } else {
      currentPos = { ...predicted };
    }
  }

  // 7. Correction passes — each diffs before/after its own delta.
  let prevShot = shotB;
  let prevPos = currentPos;
  if (doCorrect) {
    for (let pass = 0; pass < maxPasses; pass++) {
      const errX = targetX - currentPos.x;
      const errY = targetY - currentPos.y;
      if (Math.abs(errX) < minResidualPx && Math.abs(errY) < minResidualPx) {
        if (verbose) {
          console.error(`[move-to] pass ${pass}: residual (${errX},${errY}) within tolerance; done.`);
        }
        break;
      }

      const corrMickeysX = Math.round(errX / observedRatioX);
      const corrMickeysY = Math.round(errY / observedRatioY);

      // Predicted new position after correction.
      const newPredicted = {
        x: currentPos.x + corrMickeysX * observedRatioX,
        y: currentPos.y + corrMickeysY * observedRatioY,
      };

      if (verbose) {
        console.error(
          `[move-to] correction pass ${pass + 1}: err=(${errX},${errY}) ` +
            `→ mickeys=(${corrMickeysX},${corrMickeysY}) @ ratio=(${observedRatioX.toFixed(3)},${observedRatioY.toFixed(3)})`,
        );
      }

      await emitChunked(client, corrMickeysX, corrMickeysY, chunkMag, chunkPaceMs);
      await sleep(postSettleMs);
      const shotC = await client.screenshot();

      const cMotion = await detectMotion(
        prevShot.buffer,
        shotC.buffer,
        prevPos,
        newPredicted,
        { x: corrMickeysX, y: corrMickeysY },
        preWindow,
        postWindow,
        verbose,
      );

      if (cMotion) {
        currentPos = { x: cMotion.post.centroidX, y: cMotion.post.centroidY };
        // Update ratio on dominant axis
        if (Math.abs(corrMickeysX) > Math.abs(corrMickeysY)) {
          const r = Math.abs(cMotion.displacement.x) / Math.max(1, Math.abs(corrMickeysX));
          if (r >= 0.5 && r <= 3) observedRatioX = r;
        } else {
          const r = Math.abs(cMotion.displacement.y) / Math.max(1, Math.abs(corrMickeysY));
          if (r >= 0.5 && r <= 3) observedRatioY = r;
        }
        finalDetectedPosition = { ...currentPos };
      } else {
        // Detection failed — trust prediction.
        currentPos = newPredicted;
      }

      corrections.push({
        detectedCursor: cMotion
          ? { x: cMotion.post.centroidX, y: cMotion.post.centroidY }
          : { x: Math.round(newPredicted.x), y: Math.round(newPredicted.y) },
        livePxPerMickey: cMotion?.livePxPerMickey ?? (observedRatioX + observedRatioY) / 2,
        correctionMickeys: { x: corrMickeysX, y: corrMickeysY },
      });

      prevShot = shotC;
      prevPos = currentPos;
    }
  }

  const shot = await client.screenshot();

  const parts: string[] = [];
  parts.push(`Target (${targetX},${targetY}).`);
  parts.push(`Origin via ${actualStrategy} at (${Math.round(origin.x)},${Math.round(origin.y)}).`);
  parts.push(
    `Open-loop emitted ${Math.abs(openMickeysX)}X+${Math.abs(openMickeysY)}Y mickeys in ${chunkCount} chunk(s); ` +
      `default px/mickey=(${pxPerMickeyX.toFixed(2)},${pxPerMickeyY.toFixed(2)}).`,
  );
  if (motion) {
    parts.push(
      `Motion-diff detected landing at (${motion.post.centroidX},${motion.post.centroidY}); ` +
        `live ratio ≈ ${motion.livePxPerMickey.toFixed(2)}.`,
    );
  } else if (doCorrect) {
    parts.push('Motion-diff failed — cursor pair not found; using predicted landing.');
  }
  if (corrections.length > 0) {
    parts.push(
      `${corrections.length} correction pass(es); ` +
        `last applied (${corrections[corrections.length - 1].correctionMickeys.x},${corrections[corrections.length - 1].correctionMickeys.y}) mickeys.`,
    );
  }
  if (finalDetectedPosition) {
    parts.push(
      `Final cursor detected at (${finalDetectedPosition.x},${finalDetectedPosition.y}); ` +
        `residual (${finalDetectedPosition.x - targetX},${finalDetectedPosition.y - targetY}).`,
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
    finalDetectedPosition,
    resolution,
    message: parts.join(' '),
  };
}
