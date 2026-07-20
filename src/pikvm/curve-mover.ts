/**
 * Curve-based one-shot mover.
 *
 * Validated 2026-07-20 (N=80 paired, live, vs iPadCollector getCursor, realistic
 * home scene): beats the iterative moveToPixel 80/80 — median 9.1px vs 72.9px,
 * p90 12.4 vs 154. See docs/movement-accuracy-plan.md Phase 3–5 and memory
 * project_curve_oneshot_mover.
 *
 * Why it works: the iPad emit→displacement transfer function is a fixed,
 * deterministic, isotropic nonlinear curve. mouseMoveRelative clamps to
 * ±127/report; a single report's displacement follows EMIT_CURVE (std 0.0), and
 * bursts are linear (FULL_REPORT_PX per full ±127 report). So we detect the
 * cursor once (V8), invert the curve to plan per-axis bursts, and land in ONE
 * open-loop shot — no iterative motion-diff correction (which is what makes the
 * legacy path oscillate / go blind on a textured background).
 *
 * CAVEAT: the curve is calibrated for the current iPad-in-HDMI geometry
 * (1920×1080 frame, this iPad's screen size/position). A future calibration
 * routine should learn it and cache in ballistics.json; until then it is
 * hardcoded from the validation session.
 */
import type { PiKVMClient } from './client.js';
import { findCursorByV8FullFrame } from './cursor-ml-detect.js';
import type { MoveToResult, MoveStrategy } from './move-to.js';

/** Single-report displacement curve: [mickeys, |HDMI px|] on the X axis.
 *  Measured via getCursor ground truth (fine-emit-probe + wide-emit-probe). */
export const EMIT_CURVE_X: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [5, 2.4], [8, 4.9], [12, 8.2], [16, 11.5], [20, 15],
  [40, 49], [60, 89], [80, 120], [100, 136], [127, 157],
];
/** One full ±127 report's displacement (px). Bursts add this linearly. */
export const FULL_REPORT_PX = 157;
/** Y displacement = X × this (isotropic in logical space; the factor is the
 *  HDMI aspect-mapping ratio, ~0.965 for this setup). */
export const Y_SCALE = 0.965;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Invert the single-report curve: mickeys needed for a desired |px| (0..full). */
export function mickeysForReport(px: number, curve = EMIT_CURVE_X, full = FULL_REPORT_PX): number {
  const a = Math.max(0, Math.min(full, Math.abs(px)));
  for (let i = 1; i < curve.length; i++) {
    if (a <= curve[i][1]) {
      const [m0, p0] = curve[i - 1], [m1, p1] = curve[i];
      return Math.round(m0 + (m1 - m0) * (a - p0) / (p1 - p0));
    }
  }
  return 127;
}

/** Plan a signed sequence of per-report deltas (one axis) to move `d` px:
 *  full ±127 reports for the bulk + one partial report for the remainder.
 *  `scale` accounts for the current geometry: actual displacement = scale ×
 *  reference-curve displacement, so we plan against the reference curve using
 *  the scaled-down distance `d/scale`. scale=1 is the reference session. */
export function planAxisEmits(d: number, full = FULL_REPORT_PX, curve = EMIT_CURVE_X, scale = 1): number[] {
  const sign = Math.sign(d), D = Math.abs(d) / scale;
  const nFull = Math.floor(D / full), rem = D - nFull * full;
  const out: number[] = [];
  for (let i = 0; i < nFull; i++) out.push(sign * 127);
  if (rem >= 2) out.push(sign * mickeysForReport(rem, curve, full));
  return out;
}

const CURVE_Y = EMIT_CURVE_X.map(([m, p]) => [m, p * Y_SCALE] as const);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

export interface CurveOneShotOptions {
  /** ms between per-report emits (default 110 — matches the calibration pace). */
  emitPaceMs?: number;
  /** ms to settle after the burst before the verify screenshot (default 250). */
  settleMs?: number;
  /** V8 presence gate for start/verify detection (default 0.5). */
  minPresence?: number;
  /** Run ONE correction shot (re-detect + re-shoot) if the first shot's residual
   *  exceeds this many px. Default 30 — recovers the ~12% start-detection miss
   *  tail (see moveByCurveOneShot). Set to a huge number (e.g. 1e9) to force a
   *  pure single shot (as in the validated N=80 move A/B). */
  correctGatePx?: number;
  /** Per-axis curve scale for the current geometry (default 1 = reference
   *  session, 680×944 region). Measure via calibrateFullReport: scaleX =
   *  measured.x / FULL_REPORT_PX, scaleY = measured.y / (FULL_REPORT_PX×Y_SCALE). */
  curveScaleX?: number;
  curveScaleY?: number;
}

async function detect(client: PiKVMClient, minPresence: number): Promise<{ x: number; y: number } | null> {
  const shot = await client.screenshot({ quality: 80 });
  const v8 = await findCursorByV8FullFrame(shot.buffer, shot.screenshotWidth, shot.screenshotHeight, { minPresence });
  return v8 ? { x: v8.x, y: v8.y } : null;
}

async function emitToward(client: PiKVMClient, from: { x: number; y: number }, target: { x: number; y: number }, paceMs: number, scaleX = 1, scaleY = 1): Promise<{ x: number; y: number }> {
  const ex = planAxisEmits(target.x - from.x, FULL_REPORT_PX, EMIT_CURVE_X, scaleX);
  const ey = planAxisEmits(target.y - from.y, FULL_REPORT_PX * Y_SCALE, CURVE_Y as unknown as ReadonlyArray<readonly [number, number]>, scaleY);
  let mx = 0, my = 0;
  for (const e of ex) { await client.mouseMoveRelative(e, 0); mx += e; await sleep(paceMs); }
  for (const e of ey) { await client.mouseMoveRelative(0, e); my += e; await sleep(paceMs); }
  return { x: mx, y: my };
}

/**
 * Calibrate the emit-curve SCALE for the current iPad-in-HDMI geometry.
 *
 * The curve shape is device-intrinsic (iPad pointer accel in logical px); only
 * the scale (HDMI px per logical px = region-size / logical-resolution) changes
 * when the iPad's screen size/position in the frame changes. So we measure one
 * scale per axis: emit a LARGE burst (reports × ±127, ~300px) where the ~11px
 * detector noise is negligible, and read the per-full-report displacement. The
 * returned {x,y} are measured FULL_REPORT_PX per axis; divide by FULL_REPORT_PX
 * (X) / FULL_REPORT_PX×Y_SCALE (Y) to get the scale factor for the curve.
 *
 * Uses the same V8 detector as production (no getCursor needed). Averages `reps`.
 */
export async function calibrateFullReport(
  client: PiKVMClient,
  opts: { reports?: number; reps?: number; minPresence?: number; settleMs?: number; paceMs?: number } = {},
): Promise<{ x: number; y: number; samplesX: number[]; samplesY: number[] }> {
  const reports = opts.reports ?? 2;
  const reps = opts.reps ?? 3;
  const minPresence = opts.minPresence ?? 0.5;
  const settleMs = opts.settleMs ?? 300;
  const paceMs = opts.paceMs ?? 110;
  const slamCorner = async (): Promise<void> => { for (let s = 0; s < 6; s++) await client.mouseMoveRelative(-127, -127); await sleep(settleMs); };

  const measure = async (axis: 'x' | 'y'): Promise<number[]> => {
    const out: number[] = [];
    for (let r = 0; r < reps; r++) {
      await slamCorner();
      // inset a little off the hard corner so detection isn't clipped
      await client.mouseMoveRelative(axis === 'x' ? 15 : 40, axis === 'x' ? 40 : 15);
      await sleep(settleMs);
      const start = await detect(client, minPresence);
      if (!start) continue;
      for (let i = 0; i < reports; i++) { await client.mouseMoveRelative(axis === 'x' ? 127 : 0, axis === 'y' ? 127 : 0); await sleep(paceMs); }
      await sleep(settleMs);
      const end = await detect(client, minPresence);
      if (!end) continue;
      const disp = axis === 'x' ? (end.x - start.x) : (end.y - start.y);
      if (disp > reports * 40) out.push(disp / reports); // sanity: a full report is ~150px; reject tiny/stale
    }
    return out;
  };
  const samplesX = await measure('x');
  const samplesY = await measure('y');
  const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  return { x: med(samplesX), y: med(samplesY), samplesX, samplesY };
}

/**
 * Detect the cursor once (V8), then move to `target` in a single deterministic
 * curve-based open-loop shot. Optionally one correction shot if `correctGatePx`
 * is set. Returns a MoveToResult-shaped object so existing callers work.
 */
export async function moveByCurveOneShot(
  client: PiKVMClient,
  target: { x: number; y: number },
  options: CurveOneShotOptions = {},
): Promise<MoveToResult> {
  const paceMs = options.emitPaceMs ?? 110;
  const settleMs = options.settleMs ?? 250;
  const minPresence = options.minPresence ?? 0.5;
  const resolution = await client.getResolution(true);

  const start = await detect(client, minPresence);
  const shotAfterStart = await client.screenshot({ quality: 80 });
  const base = {
    screenshot: shotAfterStart.buffer,
    screenshotWidth: shotAfterStart.screenshotWidth,
    screenshotHeight: shotAfterStart.screenshotHeight,
    target,
    predicted: target,
    usedPxPerMickey: { x: 0, y: 0 },
    strategy: 'curve-one-shot' as MoveStrategy,
    corrections: [],
    passesSinceLastVerification: 0,
    bailedToBestPass: false,
    resolution,
  };
  if (!start) {
    return {
      ...base, emittedMickeys: { x: 0, y: 0 }, chunkCount: 0, diagnostics: [],
      finalDetectedPosition: null, finalResidualPx: null,
      message: 'curve-one-shot: V8 start detection failed (no cursor found)',
    };
  }

  const scaleX = options.curveScaleX ?? 1, scaleY = options.curveScaleY ?? 1;
  const m1 = await emitToward(client, start, target, paceMs, scaleX, scaleY);
  await sleep(settleMs);
  let emitted = { ...m1 };
  let chunkCount = 1;

  let landed = await detect(client, minPresence);

  // One correction shot when the first lands beyond the gate (default 30px).
  // A diverse N=16 click bench (2026-07-20) showed the pure single shot has a
  // ~12% miss tail — a single V8 start-detection false-positive on a home-screen
  // widget sends the whole open-loop shot astray with no recovery. Re-detecting
  // and re-shooting recovers most of these (bench: 87.5% → 94% correct-app-open).
  // Never hurts: good shots (<gate) skip it; a persistent V8 false-positive is no
  // worse than without. Set correctGatePx to a huge number to force pure one-shot.
  const correctGatePx = options.correctGatePx ?? 30;
  if (landed && dist(landed, target) > correctGatePx) {
    const m2 = await emitToward(client, landed, target, paceMs, scaleX, scaleY);
    await sleep(settleMs);
    emitted = { x: emitted.x + m2.x, y: emitted.y + m2.y };
    chunkCount += 1;
    const landed2 = await detect(client, minPresence);
    if (landed2) landed = landed2;
  }

  const finalShot = await client.screenshot({ quality: 80 });
  return {
    ...base,
    screenshot: finalShot.buffer,
    screenshotWidth: finalShot.screenshotWidth,
    screenshotHeight: finalShot.screenshotHeight,
    emittedMickeys: emitted,
    chunkCount,
    diagnostics: [],
    finalDetectedPosition: landed,
    finalResidualPx: landed ? dist(landed, target) : null,
    message: landed ? `curve-one-shot: landed ${dist(landed, target).toFixed(1)}px from target` : 'curve-one-shot: verify detection failed after move',
  };
}
