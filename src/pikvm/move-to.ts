/**
 * Approximate-absolute move-to-pixel for PiKVM targets in relative mouse
 * mode (mouse.absolute=false, e.g. iPad).
 *
 * The pointer state in iPadOS is tracked by iPadOS, not PiKVM, so there is
 * no "absolute" addressing. We approximate it with three layers:
 *
 *   1. Origin discovery — find where the cursor currently is. Default
 *      strategy is probe+diff (safer than slam, which can re-lock the iPad
 *      via iPadOS's hot-corner gesture). Slam remains available as a
 *      fallback.
 *   2. Open-loop move — emit a calculated relative delta sequence to cross
 *      the pixel distance from origin to target, using either a ballistics
 *      profile or a default px/mickey.
 *   3. Closed-loop correction — repeat: probe a known amount, diff the
 *      before/after screenshots, measure live px/mickey, compute residual
 *      error, emit a correction delta. Up to `maxCorrectionPasses` passes,
 *      with early-exit when residual < `minResidualPx`.
 *
 * A final ground-truth probe+diff is done after the last correction so the
 * caller knows where the cursor actually landed — not just where we hoped
 * it would land.
 */

import { PiKVMClient, ScreenResolution } from './client.js';
import {
  BallisticsProfile,
  lookupPxPerMickey,
  slamToCorner,
} from './ballistics.js';
import {
  Cluster,
  DEFAULT_DETECTION_CONFIG,
  diffScreenshots,
  locateCursor,
} from './cursor-detect.js';

export type MoveStrategy = 'detect-then-move' | 'slam-then-move' | 'assume-at';
export type Axis = 'x' | 'y';

export interface MoveToOptions {
  /** How to establish the cursor's starting position:
   *  - 'detect-then-move' (default): probe + diff to locate the cursor
   *    without moving it much. Safe — no slam, no hot-corner risk.
   *  - 'slam-then-move': slam to top-left and assume slamOriginPx. Risky
   *    on iPad (re-lock via hot-corner gesture) but reliable on other
   *    targets.
   *  - 'assume-at': trust `assumeCursorAt` — caller already knows. */
  strategy?: MoveStrategy;
  /** Used when strategy='assume-at'. HDMI pixels. */
  assumeCursorAt?: { x: number; y: number };
  /** Used when strategy='slam-then-move'. HDMI pixels iPadOS clamps to
   *  after a top-left slam. Default (625, 65) for iPad-portrait in
   *  1920x1080. */
  slamOriginPx?: { x: number; y: number };
  /** Legacy option. If false with no `strategy` set, strategy becomes
   *  'assume-at' using `assumeCursorAt` or slamOriginPx. */
  slamFirst?: boolean;

  /** Ballistics profile to consult for px/mickey. */
  profile?: BallisticsProfile | null;
  /** Fallback px/mickey when no profile. Observed 1.0–1.7 on iPad; default
   *  1.3 absorbs typical variance without excessive overshoot. */
  fallbackPxPerMickey?: number;
  /** Per-call delta magnitude for chunking. Default 60 — smaller chunks
   *  trigger less iPadOS burst-acceleration amplification. */
  chunkMagnitude?: number;
  /** Pace between chunked calls (ms). Default 20. */
  chunkPaceMs?: number;
  /** Mickeys absorbed by edge dead zone (when slamming). Default 0. */
  deadZoneMickeys?: number;
  /** Settle after the final delta burst. Default 50 ms. */
  postMoveSettleMs?: number;

  /** Enable closed-loop correction (default true). */
  correct?: boolean;
  /** Maximum correction passes. Default 2. */
  maxCorrectionPasses?: number;
  /** Early-exit threshold: if the detected pre-correction error < this
   *  in both axes, skip further correction passes. Default 25 px —
   *  larger than pass-1 noise but smaller than a typical iPad app icon
   *  hit target (~100 px). Set lower only for sub-icon precision. */
  minResidualPx?: number;
  /** Mickey magnitude for the location-probe. Default 100. */
  probeDelta?: number;
  /** Search window around predicted position (px). Default 400. */
  searchWindow?: number;
  /** Whether to run a ground-truth final-detect probe after all corrections.
   *  Default true. Callers that will click immediately (e.g. click_at) set
   *  this to false — the final-detect probe MOVES the cursor by
   *  ~probeDelta × px/mickey, which would make the click miss. */
  runFinalDetect?: boolean;

  /** Tuning passed through to slamToCorner when slam strategy is used. */
  slamCalls?: number;
  slamPaceMs?: number;
  verbose?: boolean;
}

export interface CorrectionPass {
  detectedCursor: { x: number; y: number };
  livePxPerMickey: number;
  correctionMickeys: { x: number; y: number };
  probeAxis: Axis;
  probeSign: 1 | -1;
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
  /** Actual strategy used for origin discovery (may differ from requested
   *  if detection failed and fell back to slam). */
  strategy: MoveStrategy;
  /** Closed-loop correction passes in order. Empty if correction disabled
   *  or cursor couldn't be detected. */
  corrections: CorrectionPass[];
  /** Ground-truth cursor position detected after all corrections. `null`
   *  if final detection failed — caller should treat click accuracy as
   *  uncertain. */
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

/**
 * Pick probe direction so the cursor has room to move. If the predicted
 * position is near the right edge, probe −x (else +x). Similarly for y.
 * We probe only one axis at a time; choose the axis with more room.
 */
function pickProbeDirection(
  predicted: { x: number; y: number },
  resolution: ScreenResolution,
  edgeThreshold = 150,
): { axis: Axis; sign: 1 | -1 } {
  const spaceLeft = predicted.x;
  const spaceRight = resolution.width - 1 - predicted.x;
  const spaceTop = predicted.y;
  const spaceBottom = resolution.height - 1 - predicted.y;

  // Pick axis with more available space.
  const xSpace = Math.max(spaceLeft, spaceRight);
  const ySpace = Math.max(spaceTop, spaceBottom);

  if (xSpace >= ySpace) {
    // Use x-axis; pick sign toward the side with more room (avoid edge).
    if (spaceRight < edgeThreshold && spaceLeft > edgeThreshold) {
      return { axis: 'x', sign: -1 };
    }
    return { axis: 'x', sign: 1 };
  } else {
    if (spaceBottom < edgeThreshold && spaceTop > edgeThreshold) {
      return { axis: 'y', sign: -1 };
    }
    return { axis: 'y', sign: 1 };
  }
}

/**
 * Try to determine where the cursor currently is. Returns null on failure
 * so the caller can fall back to slam.
 */
async function discoverOrigin(
  client: PiKVMClient,
  options: MoveToOptions,
): Promise<{ point: { x: number; y: number }; method: MoveStrategy } | null> {
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
      probeDelta: 15,
      settleMs: 120,
      detection: { brightnessFloor: 170 },
      maxAttempts: 2,
      verbose: options.verbose,
    });
    if (located) {
      return { point: located.position, method: 'detect-then-move' };
    }
    // Fall through to slam fallback.
    if (options.verbose) {
      console.error('[move-to] detect-then-move failed; falling back to slam');
    }
  }

  // slam-then-move (or fallback from detect-then-move)
  const slamOrigin = options.slamOriginPx ?? { x: 625, y: 65 };
  await slamToCorner(client, {
    calls: options.slamCalls,
    paceMs: options.slamPaceMs,
    corner: 'top-left',
    verbose: options.verbose,
  });
  return { point: slamOrigin, method: 'slam-then-move' };
}

/**
 * One correction pass: probe in a chosen direction, diff, compute live
 * px/mickey and residual error, emit correction. Returns the pass record
 * or null if detection failed.
 */
async function runCorrectionPass(
  client: PiKVMClient,
  target: { x: number; y: number },
  searchCentre: { x: number; y: number },
  resolution: ScreenResolution,
  probeDelta: number,
  searchWindow: number,
  chunkPaceMs: number,
  verbose: boolean,
): Promise<CorrectionPass | null> {
  const { axis, sign } = pickProbeDirection(searchCentre, resolution);
  const probeX = axis === 'x' ? probeDelta * sign : 0;
  const probeY = axis === 'y' ? probeDelta * sign : 0;

  // Warm-up probe in the same direction so (a) cursor is rendered when
  // we snap A, and (b) we don't waste a tiny +x nudge on a cursor pinned
  // at the right edge.
  const warmupX = axis === 'x' ? 5 * sign : 0;
  const warmupY = axis === 'y' ? 5 * sign : 0;
  await client.mouseMoveRelative(warmupX, warmupY);
  await sleep(80);
  const a = await client.screenshot();

  await client.mouseMoveRelative(probeX, probeY);
  await sleep(180);
  const b = await client.screenshot();

  const clusters = await diffScreenshots(a.buffer, b.buffer, {
    ...DEFAULT_DETECTION_CONFIG,
    brightnessFloor: 170,
    mergeRadius: 12,
  });

  const inWindow = (c: Cluster): boolean =>
    Math.abs(c.centroidX - searchCentre.x) <= searchWindow &&
    Math.abs(c.centroidY - searchCentre.y) <= searchWindow;

  const candidates = clusters.filter(
    (c) => c.pixels >= 12 && c.pixels <= 200 && inWindow(c),
  );
  if (verbose) {
    console.error(
      `[correct ${axis}${sign > 0 ? '+' : '-'}] ${clusters.length} total / ${candidates.length} in window ` +
        `around (${Math.round(searchCentre.x)},${Math.round(searchCentre.y)})`,
    );
  }

  // If detection fails, restore the cursor to its pre-probe position
  // (undo warmup + main probe) so the caller can still click accurately
  // based on the open-loop landing.
  const restoreProbe = async () => {
    const restoreTotal = -(warmupX + probeX);
    const restoreTotalY = -(warmupY + probeY);
    let rem = Math.abs(restoreTotal);
    const s = Math.sign(restoreTotal);
    while (rem > 0) {
      const step = Math.min(127, rem) * s;
      await client.mouseMoveRelative(axis === 'x' ? step : 0, axis === 'y' ? step : 0);
      rem -= Math.abs(step);
      await sleep(chunkPaceMs);
    }
    // y restore (warmup+probe are single-axis so usually noop here)
    if (restoreTotalY !== 0) {
      let ry = Math.abs(restoreTotalY);
      const sy = Math.sign(restoreTotalY);
      while (ry > 0) {
        const step = Math.min(127, ry) * sy;
        await client.mouseMoveRelative(0, step);
        ry -= Math.abs(step);
        await sleep(chunkPaceMs);
      }
    }
    await sleep(80);
  };

  if (candidates.length < 2) {
    await restoreProbe();
    return null;
  }

  // Find a pair whose displacement matches the probe direction.
  let best: { pre: Cluster; post: Cluster; onAxis: number; offAxis: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const p = candidates[i];
      const q = candidates[j];
      // "pre" is the cluster the probe moved AWAY from (so probe-axis
      // coordinate is SMALLER when sign>0, LARGER when sign<0).
      const onAxisP = axis === 'x' ? p.centroidX : p.centroidY;
      const onAxisQ = axis === 'x' ? q.centroidX : q.centroidY;
      const preP = sign > 0 ? onAxisP < onAxisQ : onAxisP > onAxisQ;
      const pre = preP ? p : q;
      const post = preP ? q : p;

      const preOn = axis === 'x' ? pre.centroidX : pre.centroidY;
      const postOn = axis === 'x' ? post.centroidX : post.centroidY;
      const preOff = axis === 'x' ? pre.centroidY : pre.centroidX;
      const postOff = axis === 'x' ? post.centroidY : post.centroidX;

      const onAxis = (postOn - preOn) * sign; // positive = probe went as commanded
      const offAxis = Math.abs(postOff - preOff);
      if (onAxis <= 0) continue;
      if (onAxis < probeDelta * 0.3 || onAxis > probeDelta * 5) continue;
      if (offAxis > 40) continue;

      const sizeRatio = Math.max(pre.pixels, post.pixels) / Math.max(1, Math.min(pre.pixels, post.pixels));
      if (sizeRatio > 4) continue;
      if (!best || offAxis < best.offAxis) {
        best = { pre, post, onAxis, offAxis };
      }
    }
  }

  if (!best) {
    if (verbose) console.error(`[correct ${axis}${sign > 0 ? '+' : '-'}] no valid cursor pair`);
    await restoreProbe();
    return null;
  }

  const rawRatio = best.onAxis / probeDelta;
  // Sanity-clamp: on iPad the observed px/mickey lives in ~[0.5, 3.0].
  // Anything outside that range is almost certainly a bad pair (two
  // unrelated UI clusters that happen to align). Fall back to the caller's
  // default rather than apply a wildly wrong correction.
  const livePxPerMickey = rawRatio >= 0.5 && rawRatio <= 3.0 ? rawRatio : 1.3;
  if (verbose && rawRatio !== livePxPerMickey) {
    console.error(
      `[correct ${axis}${sign > 0 ? '+' : '-'}] raw ratio ${rawRatio.toFixed(3)} out of sane range ` +
        `[0.5, 3.0]; using fallback ${livePxPerMickey}`,
    );
  }
  // Cursor is currently at post. Compute correction to target.
  const errorX = target.x - best.post.centroidX;
  const errorY = target.y - best.post.centroidY;
  const mickeysX = Math.round(errorX / livePxPerMickey);
  const mickeysY = Math.round(errorY / livePxPerMickey);

  if (verbose) {
    console.error(
      `[correct ${axis}${sign > 0 ? '+' : '-'}] post=(${best.post.centroidX},${best.post.centroidY}) ` +
        `livePxPerMickey=${livePxPerMickey.toFixed(3)} ` +
        `error=(${errorX},${errorY}) correction=(${mickeysX},${mickeysY}) mickeys`,
    );
  }

  // Emit correction.
  let remX = Math.abs(mickeysX);
  let remY = Math.abs(mickeysY);
  const sx = Math.sign(mickeysX);
  const sy = Math.sign(mickeysY);
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(127, remX) * sx : 0;
    const stepY = remY > 0 ? Math.min(127, remY) * sy : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX = Math.max(0, remX - Math.abs(stepX));
    remY = Math.max(0, remY - Math.abs(stepY));
    if (chunkPaceMs > 0 && (remX > 0 || remY > 0)) await sleep(chunkPaceMs);
  }
  await sleep(80);

  return {
    detectedCursor: { x: best.post.centroidX, y: best.post.centroidY },
    livePxPerMickey,
    correctionMickeys: { x: mickeysX, y: mickeysY },
    probeAxis: axis,
    probeSign: sign,
  };
}

/**
 * Ground-truth detection pass after all corrections complete. Returns the
 * cursor's actual position, or null if detection failed.
 */
async function detectFinalPosition(
  client: PiKVMClient,
  target: { x: number; y: number },
  resolution: ScreenResolution,
  probeDelta: number,
  searchWindow: number,
  verbose: boolean,
): Promise<{ x: number; y: number } | null> {
  const { axis, sign } = pickProbeDirection(target, resolution);
  const probeX = axis === 'x' ? probeDelta * sign : 0;
  const probeY = axis === 'y' ? probeDelta * sign : 0;

  // Warmup (re-renders a potentially faded cursor).
  await client.mouseMoveRelative(axis === 'x' ? 5 * sign : 0, axis === 'y' ? 5 * sign : 0);
  await sleep(80);
  const a = await client.screenshot();
  await client.mouseMoveRelative(probeX, probeY);
  await sleep(180);
  const b = await client.screenshot();

  const clusters = await diffScreenshots(a.buffer, b.buffer, {
    ...DEFAULT_DETECTION_CONFIG,
    brightnessFloor: 170,
    mergeRadius: 12,
  });
  const candidates = clusters.filter((c) => {
    if (c.pixels < 12 || c.pixels > 200) return false;
    return Math.abs(c.centroidX - target.x) <= searchWindow &&
      Math.abs(c.centroidY - target.y) <= searchWindow;
  });
  if (candidates.length < 2) {
    if (verbose) console.error(`[final-detect] ${candidates.length} candidates in window — no ground truth`);
    return null;
  }

  // Find a pair matching probe direction; take "pre" as the cursor pos.
  let best: { pre: Cluster; onAxis: number; offAxis: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const p = candidates[i];
      const q = candidates[j];
      const onAxisP = axis === 'x' ? p.centroidX : p.centroidY;
      const onAxisQ = axis === 'x' ? q.centroidX : q.centroidY;
      const preP = sign > 0 ? onAxisP < onAxisQ : onAxisP > onAxisQ;
      const pre = preP ? p : q;
      const post = preP ? q : p;

      const preOn = axis === 'x' ? pre.centroidX : pre.centroidY;
      const postOn = axis === 'x' ? post.centroidX : post.centroidY;
      const preOff = axis === 'x' ? pre.centroidY : pre.centroidX;
      const postOff = axis === 'x' ? post.centroidY : post.centroidX;
      const onAxis = (postOn - preOn) * sign;
      const offAxis = Math.abs(postOff - preOff);
      if (onAxis <= 0) continue;
      if (onAxis < probeDelta * 0.3 || onAxis > probeDelta * 5) continue;
      if (offAxis > 40) continue;
      const sizeRatio = Math.max(pre.pixels, post.pixels) / Math.max(1, Math.min(pre.pixels, post.pixels));
      if (sizeRatio > 4) continue;
      if (!best || offAxis < best.offAxis) {
        best = { pre, onAxis, offAxis };
      }
    }
  }

  if (!best) {
    if (verbose) console.error('[final-detect] no valid cursor pair');
    return null;
  }

  return { x: best.pre.centroidX, y: best.pre.centroidY };
}

export async function moveToPixel(
  client: PiKVMClient,
  target: { x: number; y: number },
  options: MoveToOptions = {},
): Promise<MoveToResult> {
  const resolution = await client.getResolution(true);

  const fallback = options.fallbackPxPerMickey ?? 1.3;
  const chunkMag = options.chunkMagnitude ?? 60;
  const chunkPaceMs = options.chunkPaceMs ?? 20;
  const deadZone = options.deadZoneMickeys ?? 0;
  const postSettleMs = options.postMoveSettleMs ?? 50;
  const doCorrect = options.correct !== false;
  const maxPasses = options.maxCorrectionPasses ?? 2;
  const minResidualPx = options.minResidualPx ?? 25;
  const probeDelta = options.probeDelta ?? 100;
  const searchWindow = options.searchWindow ?? 400;
  const verbose = options.verbose ?? false;

  // Profile lookup uses the actual chunk magnitude we're about to emit.
  const pxPerMickeyX =
    (options.profile && lookupPxPerMickey(options.profile, 'x', chunkMag, 'slow')) ?? fallback;
  const pxPerMickeyY =
    (options.profile && lookupPxPerMickey(options.profile, 'y', chunkMag, 'slow')) ?? fallback;

  // 1. Origin discovery
  const discovered = await discoverOrigin(client, options);
  if (!discovered) {
    throw new Error('Could not determine cursor origin');
  }
  const origin = discovered.point;
  const actualStrategy = discovered.method;

  const targetX = clamp(Math.round(target.x), 0, resolution.width - 1);
  const targetY = clamp(Math.round(target.y), 0, resolution.height - 1);

  const dxPx = targetX - origin.x;
  const dyPx = targetY - origin.y;

  const rawMickeysX = Math.round(Math.abs(dxPx) / pxPerMickeyX);
  const rawMickeysY = Math.round(Math.abs(dyPx) / pxPerMickeyY);
  const mickeysXAbs = rawMickeysX > 0 ? rawMickeysX + deadZone : 0;
  const mickeysYAbs = rawMickeysY > 0 ? rawMickeysY + deadZone : 0;
  const signX = dxPx >= 0 ? 1 : -1;
  const signY = dyPx >= 0 ? 1 : -1;

  // 2. Open-loop move
  let remX = mickeysXAbs;
  let remY = mickeysYAbs;
  let chunkCount = 0;
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(chunkMag, remX) * signX : 0;
    const stepY = remY > 0 ? Math.min(chunkMag, remY) * signY : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX = Math.max(0, remX - Math.abs(stepX));
    remY = Math.max(0, remY - Math.abs(stepY));
    chunkCount++;
    if (chunkPaceMs > 0 && (remX > 0 || remY > 0)) await sleep(chunkPaceMs);
  }
  if (postSettleMs > 0) await sleep(postSettleMs);

  const predicted = {
    x: origin.x + signX * rawMickeysX * pxPerMickeyX,
    y: origin.y + signY * rawMickeysY * pxPerMickeyY,
  };

  // 3. Correction passes
  const corrections: CorrectionPass[] = [];
  let searchCentre = { ...predicted };
  if (doCorrect) {
    for (let pass = 0; pass < maxPasses; pass++) {
      if (pass > 0) {
        // Inter-pass warmup to keep cursor rendered. Direction chosen per
        // current search centre.
        const { axis, sign } = pickProbeDirection(searchCentre, resolution);
        const wx = axis === 'x' ? 3 * sign : 0;
        const wy = axis === 'y' ? 3 * sign : 0;
        await client.mouseMoveRelative(wx, wy);
        await sleep(80);
      }

      const pc = await runCorrectionPass(
        client,
        { x: targetX, y: targetY },
        searchCentre,
        resolution,
        probeDelta,
        searchWindow,
        chunkPaceMs,
        verbose,
      );
      if (!pc) break;
      corrections.push(pc);

      // Early-exit: if the cursor we detected was already close to target,
      // the correction we just emitted landed it on target — no need for
      // another pass (and its cursor-perturbing probe).
      const preErrX = Math.abs(targetX - pc.detectedCursor.x);
      const preErrY = Math.abs(targetY - pc.detectedCursor.y);
      if (preErrX < minResidualPx && preErrY < minResidualPx) {
        if (verbose) {
          console.error(
            `[move-to] pass ${pass + 1} detected pre-correction error (${preErrX},${preErrY}) < minResidualPx=${minResidualPx}; stopping.`,
          );
        }
        break;
      }

      // Next pass probes around the target.
      searchCentre = { x: targetX, y: targetY };
    }
  }

  // 4. Final ground-truth detection (optional — perturbs the cursor, so
  // callers that will click immediately skip it).
  let finalDetectedPosition: { x: number; y: number } | null = null;
  const runFinal = options.runFinalDetect !== false;
  if (doCorrect && runFinal) {
    finalDetectedPosition = await detectFinalPosition(
      client,
      { x: targetX, y: targetY },
      resolution,
      probeDelta,
      searchWindow,
      verbose,
    );
  }

  const shot = await client.screenshot();

  const residualX = finalDetectedPosition ? finalDetectedPosition.x - targetX : null;
  const residualY = finalDetectedPosition ? finalDetectedPosition.y - targetY : null;

  const parts: string[] = [];
  parts.push(`Target (${targetX},${targetY}).`);
  parts.push(`Origin via ${actualStrategy} at (${Math.round(origin.x)},${Math.round(origin.y)}).`);
  parts.push(
    `Open-loop: px/mickey X=${pxPerMickeyX.toFixed(2)} Y=${pxPerMickeyY.toFixed(2)}, ` +
      `emitted ${mickeysXAbs}X+${mickeysYAbs}Y mickeys in ${chunkCount} chunk(s).`,
  );
  if (doCorrect) {
    if (corrections.length === 0) {
      parts.push('Correction skipped (cursor not detected).');
    } else {
      parts.push(`Correction passes: ${corrections.length}/${maxPasses}.`);
    }
  } else {
    parts.push('Correction disabled.');
  }
  if (finalDetectedPosition) {
    parts.push(
      `Final cursor at (${finalDetectedPosition.x},${finalDetectedPosition.y}), residual (${residualX},${residualY}).`,
    );
  } else if (doCorrect) {
    parts.push('Final position detection failed — click accuracy uncertain.');
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
    emittedMickeys: { x: mickeysXAbs, y: mickeysYAbs },
    usedPxPerMickey: { x: pxPerMickeyX, y: pxPerMickeyY },
    chunkCount,
    strategy: actualStrategy,
    corrections,
    finalDetectedPosition,
    resolution,
    message: parts.join(' '),
  };
}
