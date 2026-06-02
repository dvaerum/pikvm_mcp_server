/**
 * Open-loop emit-sequence planner (Stage 1, step 1.12).
 *
 * Given a desired (dx_px, dy_px) cursor displacement on the HDMI
 * screenshot frame, produce a sequence of HID mouse emits whose
 * cumulative predicted effect (per the trained v2 forward model)
 * lands within `tolPx` of the target.
 *
 * The planner is greedy and one-axis-at-a-time, matching v2's
 * chunkedBurst training distribution (cardinal-only chunks). See
 * `docs/troubleshooting/2026-06-01-pointer-accel-v2-open-loop-design.md`
 * for the rationale and the three-planner comparison that led here.
 *
 * The forward model returns predicted displacement in **logical** iPad
 * pixels; the caller supplies the HDMI-per-logical-px scale so the
 * planner can compare against the target (which is given in HDMI
 * pixels — that's the moveToPixel input space).
 *
 * Pure-async: only `predict` is async; the rest is deterministic given
 * a stub predictor. That's what the Phase 1 unit test exploits.
 */

import { buildFeatures, type EmitEvent } from './pointer-accel.js';

/** One element of the planned emit sequence. `paceMs` is the delay
 *  the caller should apply BEFORE firing this emit (matches the
 *  `chunkPaceMs` semantics used by move-to's chunked-burst loop). */
export interface PlannedEmit {
  dx: number;
  dy: number;
  paceMs: number;
}

export interface PlanOpts {
  /** Per-chunk emit magnitude in mickeys. Must match v2's training
   *  distribution — chunkedBurst was collected at mag ∈ {20, 30}. */
  chunkMag: number;

  /** Inter-chunk delay in ms (the trainer's `dt_prev_emit_ms`). */
  chunkPaceMs: number;

  /** Horizon over which `predict` reports displacement, in ms. Used to
   *  back out a per-ms velocity estimate for the feature vector. Must
   *  match the trainer's HORIZON_MS (default 50 ms). */
  horizonMs: number;

  /** Stop when remaining displacement falls below this many HDMI px on
   *  both axes. */
  tolPx: number;

  /** Hard cap on planned emits — bounds wall-clock time and guarantees
   *  termination even with a degenerate predictor. */
  maxEmits: number;

  /** Forward model: features → predicted logical-px (dx, dy) over one
   *  horizonMs window. Caller passes
   *  `predictDisplacement` from pointer-accel.ts in production, or a
   *  stub in unit tests. */
  predict: (features: number[]) => Promise<{ dx: number; dy: number } | null>;

  /** HDMI-pixels-per-logical-pixel scale from the cached iPad bounds.
   *  Matches the scale used in `learnedBallisticsPxPerMickey` in
   *  move-to.ts. */
  hdmiPerLogicalScale: { x: number; y: number };
}

/** Plan an open-loop emit sequence whose cumulative predicted effect
 *  lands within `tolPx` of the target.
 *
 *  Returns the emit list and a small diagnostic record. The diagnostic
 *  is mostly for tests + the future combined-system A/B; production
 *  callers can ignore it.
 */
export interface PlanResult {
  emits: PlannedEmit[];
  /** Final remaining-to-target after the planner stopped, HDMI px. */
  residualPx: { x: number; y: number };
  /** `true` when the planner hit `maxEmits` instead of converging. */
  hitMaxEmits: boolean;
  /** `true` when the predictor returned `null` at any point (model
   *  unavailable). The planner returns whatever emits it accumulated;
   *  the caller is expected to fall back to the existing path. */
  predictorFailed: boolean;
}

export async function planOpenLoopEmits(
  target: { dxPx: number; dyPx: number },
  opts: PlanOpts,
): Promise<PlanResult> {
  const emits: PlannedEmit[] = [];
  // emitHistory uses the EmitEvent shape (t,dx,dy) that buildFeatures
  // expects; we synthesise virtual timestamps starting at 0.
  const emitHistory: EmitEvent[] = [];
  let simCursorX = 0;
  let simCursorY = 0;
  let simVx = 0;
  let simVy = 0;
  let simT = 0;
  let predictorFailed = false;

  while (emits.length < opts.maxEmits) {
    const remX = target.dxPx - simCursorX;
    const remY = target.dyPx - simCursorY;
    if (Math.abs(remX) <= opts.tolPx && Math.abs(remY) <= opts.tolPx) {
      break;
    }

    // Pick a cardinal chunk on the dominant remaining axis. Matches
    // v2's chunkedBurst training distribution.
    let dx = 0;
    let dy = 0;
    if (Math.abs(remX) >= Math.abs(remY)) {
      dx = Math.sign(remX) * opts.chunkMag;
    } else {
      dy = Math.sign(remY) * opts.chunkMag;
    }

    simT += opts.chunkPaceMs;
    const features = buildFeatures(
      emitHistory,
      { vxPxPerMs: simVx, vyPxPerMs: simVy },
      { dx, dy, t: simT },
      opts.chunkPaceMs,
    );

    const pred = await opts.predict(features);
    if (pred === null) {
      predictorFailed = true;
      break;
    }

    // logical px → HDMI px
    const predHdmiX = pred.dx * opts.hdmiPerLogicalScale.x;
    const predHdmiY = pred.dy * opts.hdmiPerLogicalScale.y;
    simCursorX += predHdmiX;
    simCursorY += predHdmiY;
    // velocity is logical px / ms (matches trainer's instantaneous_velocity).
    simVx = pred.dx / opts.horizonMs;
    simVy = pred.dy / opts.horizonMs;
    emits.push({ dx, dy, paceMs: opts.chunkPaceMs });
    emitHistory.push({ t: simT, dx, dy });
  }

  const finalRemX = target.dxPx - simCursorX;
  const finalRemY = target.dyPx - simCursorY;
  return {
    emits,
    residualPx: { x: finalRemX, y: finalRemY },
    hitMaxEmits: emits.length >= opts.maxEmits,
    predictorFailed,
  };
}
