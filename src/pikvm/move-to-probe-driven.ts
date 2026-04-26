/**
 * Phase 26 — probe-driven correction loop (Direction 2).
 *
 * The motion-diff pipeline in move-to.ts has two recurring failure modes
 * on busy iPad backdrops, both observed live (see
 * docs/troubleshooting/ipad-cursor-detection.md):
 *
 *   1. Motion-diff picks a wrong pair (UI element instead of cursor).
 *      The algorithm reports "verified" finalDetectedPosition that is
 *      hundreds of pixels away from the actual cursor location. Phase
 *      24's lag flag does NOT catch this — verification was recent,
 *      just incorrect.
 *
 *   2. Motion-diff fails entirely (no pair passes sanity filters).
 *      Algorithm falls through to predicted landing; cursor lands
 *      wherever iPadOS pointer-acceleration randomness puts it.
 *
 * The probe-driven approach replaces motion-diff with `locateCursor`
 * probes — a known small emit + observe pattern that gives ground-truth
 * cursor position regardless of backdrop noise. Each iteration:
 *
 *   1. Compute residual from target.
 *   2. If within tolerance → done.
 *   3. Emit a small step toward target.
 *   4. Probe (locateCursor) to observe the actual new position.
 *   5. Update belief; loop.
 *
 * Cost: each probe is ~500 ms (wakeup nudge + probe motion + 2
 * screenshots + diff). With 5–8 iterations, total ~3–4 s per move.
 * Acceptable on iPad where the alternative is unreliable single-shot
 * clicks.
 *
 * Falls back to estimated position when a probe fails mid-iteration so
 * one bad probe doesn't kill the whole move. The injected `probeFn`
 * lets unit tests substitute a deterministic cursor model so we don't
 * have to mock screenshot streams.
 */

import type { PiKVMClient } from './client.js';
import { locateCursor } from './cursor-detect.js';
import { sleep } from './util.js';

export interface ProbePosition {
  position: { x: number; y: number };
}

export type ProbeFn = (
  client: PiKVMClient,
  lastKnown: { x: number; y: number } | null,
) => Promise<ProbePosition | null>;

export interface ProbeDrivenOptions {
  /** Substitute the locateCursor probe (e.g. for unit tests). */
  probeFn?: ProbeFn;
  /** Stop when residual to target is below this many pixels. Default 30. */
  tolerance?: number;
  /** Max correction iterations. Default 12. */
  maxIterations?: number;
  /** Initial px/mickey estimate used to compute step size. The closed-
   *  loop probes correct for this being wrong, so a rough estimate is
   *  fine. Default 1.5 (iPad-typical). */
  pxPerMickeyEstimate?: number;
  /** Cap each iteration's emitted mickeys per axis. Smaller = more
   *  iterations but less variance per step. Default 30. */
  maxStepMickeys?: number;
  /** Settle delay (ms) between emit and probe. Default 100. */
  settleMs?: number;
  /** Verbose logging to stderr. Default false. */
  verbose?: boolean;
}

export interface ProbeDrivenTraceEntry {
  iteration: number;
  cursorX: number;
  cursorY: number;
  emitX: number;
  emitY: number;
  residual: number;
  probeFailed: boolean;
}

export interface ProbeDrivenResult {
  success: boolean;
  /** Final believed cursor position (last successful probe, or last
   *  estimate if probes kept failing). */
  finalPosition: { x: number; y: number };
  /** Final residual (Euclidean px from target to finalPosition). */
  residual: number;
  /** Number of iterations executed. */
  iterations: number;
  /** Per-iteration diagnostic trace. */
  trace: ProbeDrivenTraceEntry[];
  /** Human-readable explanation of why the loop ended. */
  reason: string;
}

/**
 * Default probe function that takes a `lastKnown` hint (Phase 27) so
 * locateCursor can locality-filter out widget false positives on iPad
 * busy backdrops. Caller is responsible for tracking lastKnown across
 * iterations; the orchestrator below does this automatically.
 */
async function defaultProbeFn(
  client: PiKVMClient,
  lastKnown: Point | null,
): Promise<ProbePosition | null> {
  const r = await locateCursor(client, {
    ...(lastKnown ? { expectedNear: lastKnown, expectedNearRadius: 250 } : {}),
  });
  return r ? { position: r.position } : null;
}

interface Point {
  x: number;
  y: number;
}

export async function moveToPixelProbeDriven(
  client: PiKVMClient,
  target: { x: number; y: number },
  options: ProbeDrivenOptions = {},
): Promise<ProbeDrivenResult> {
  const probeFn = options.probeFn ?? defaultProbeFn;
  const tolerance = options.tolerance ?? 30;
  const maxIterations = options.maxIterations ?? 12;
  const pxPerMickey = options.pxPerMickeyEstimate ?? 1.5;
  const maxStepMickeys = options.maxStepMickeys ?? 30;
  const settleMs = options.settleMs ?? 100;
  const verbose = options.verbose ?? false;

  const trace: ProbeDrivenTraceEntry[] = [];

  // Initial probe: ground-truth origin. No lastKnown hint yet — the
  // first probe has to discover the cursor without spatial guidance.
  const initial = await probeFn(client, null);
  if (!initial) {
    return {
      success: false,
      finalPosition: { x: 0, y: 0 },
      residual: Infinity,
      iterations: 0,
      trace,
      reason: 'initial locateCursor probe failed',
    };
  }
  let cursor = { ...initial.position };

  for (let iter = 0; iter < maxIterations; iter++) {
    const dx = target.x - cursor.x;
    const dy = target.y - cursor.y;
    const residual = Math.hypot(dx, dy);

    if (verbose) {
      console.error(`[probe-driven] iter ${iter}: cursor=(${cursor.x.toFixed(0)},${cursor.y.toFixed(0)}) residual=${residual.toFixed(1)}`);
    }

    if (residual < tolerance) {
      return {
        success: true,
        finalPosition: cursor,
        residual,
        iterations: iter,
        trace,
        reason: `converged: residual ${residual.toFixed(1)}px < tolerance ${tolerance}px`,
      };
    }

    // Compute capped step toward target.
    const desiredMickeysX = dx / pxPerMickey;
    const desiredMickeysY = dy / pxPerMickey;
    const stepX = Math.round(
      Math.sign(desiredMickeysX) *
        Math.min(Math.abs(desiredMickeysX), maxStepMickeys),
    );
    const stepY = Math.round(
      Math.sign(desiredMickeysY) *
        Math.min(Math.abs(desiredMickeysY), maxStepMickeys),
    );

    // Emit step.
    if (stepX !== 0 || stepY !== 0) {
      await client.mouseMoveRelative(stepX, stepY);
    }
    if (settleMs > 0) await sleep(settleMs);

    // Probe for ground truth. Pass current cursor belief as the
    // spatial hint so locateCursor can locality-filter false positives
    // (Phase 27).
    const probe = await probeFn(client, cursor);
    let probeFailed = false;
    const estimatedNewPos = {
      x: cursor.x + stepX * pxPerMickey,
      y: cursor.y + stepY * pxPerMickey,
    };

    // Plausibility check: reject probe results that imply an implausibly
    // large cursor jump given the emitted step. iPadOS acceleration can
    // multiply a step by ~3× at most; locateCursor false positives on
    // busy iPad backdrops typically report positions 200+ px from where
    // the cursor actually is. If the probe disagrees with the estimate
    // by more than 3× the expected step magnitude (plus a generous
    // floor for rest-state probe wakeup motion), trust the estimate.
    const expectedStepPx = Math.hypot(stepX, stepY) * pxPerMickey;
    const probeWakeupAllowance = 80; // wakeup nudge + probe motion in px
    const maxPlausibleJump = expectedStepPx * 3 + probeWakeupAllowance;

    if (probe) {
      const probeJump = Math.hypot(
        probe.position.x - cursor.x,
        probe.position.y - cursor.y,
      );
      if (probeJump > maxPlausibleJump) {
        // Likely false positive (UI element misidentified as cursor).
        // Fall back to estimate.
        probeFailed = true;
        cursor = estimatedNewPos;
        if (verbose) {
          console.error(
            `[probe-driven] iter ${iter}: REJECT probe at (${probe.position.x.toFixed(0)},${probe.position.y.toFixed(0)}) — jump ${probeJump.toFixed(0)}px > maxPlausible ${maxPlausibleJump.toFixed(0)}px; using estimate`,
          );
        }
      } else {
        cursor = { ...probe.position };
      }
    } else {
      probeFailed = true;
      cursor = estimatedNewPos;
      if (verbose) {
        console.error(`[probe-driven] iter ${iter}: probe returned null, using estimate`);
      }
    }

    trace.push({
      iteration: iter,
      cursorX: cursor.x,
      cursorY: cursor.y,
      emitX: stepX,
      emitY: stepY,
      residual,
      probeFailed,
    });
  }

  // Budget exhausted.
  const finalDx = target.x - cursor.x;
  const finalDy = target.y - cursor.y;
  const finalResidual = Math.hypot(finalDx, finalDy);
  return {
    success: finalResidual < tolerance,
    finalPosition: cursor,
    residual: finalResidual,
    iterations: maxIterations,
    trace,
    reason: `budget exhausted: ${maxIterations} iterations, residual ${finalResidual.toFixed(1)}px`,
  };
}
