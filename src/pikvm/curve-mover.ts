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
 *  full ±127 reports for the bulk + one partial report for the remainder. */
export function planAxisEmits(d: number, full = FULL_REPORT_PX, curve = EMIT_CURVE_X): number[] {
  const sign = Math.sign(d), D = Math.abs(d);
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
  /** When set, run ONE correction shot if the post-shot residual exceeds this
   *  many px. Undefined = pure open-loop single shot (matches the validated
   *  N=80 A/B). */
  correctGatePx?: number;
}

async function detect(client: PiKVMClient, minPresence: number): Promise<{ x: number; y: number } | null> {
  const shot = await client.screenshot({ quality: 80 });
  const v8 = await findCursorByV8FullFrame(shot.buffer, shot.screenshotWidth, shot.screenshotHeight, { minPresence });
  return v8 ? { x: v8.x, y: v8.y } : null;
}

async function emitToward(client: PiKVMClient, from: { x: number; y: number }, target: { x: number; y: number }, paceMs: number): Promise<{ x: number; y: number }> {
  const ex = planAxisEmits(target.x - from.x, FULL_REPORT_PX, EMIT_CURVE_X);
  const ey = planAxisEmits(target.y - from.y, FULL_REPORT_PX * Y_SCALE, CURVE_Y as unknown as ReadonlyArray<readonly [number, number]>);
  let mx = 0, my = 0;
  for (const e of ex) { await client.mouseMoveRelative(e, 0); mx += e; await sleep(paceMs); }
  for (const e of ey) { await client.mouseMoveRelative(0, e); my += e; await sleep(paceMs); }
  return { x: mx, y: my };
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

  const m1 = await emitToward(client, start, target, paceMs);
  await sleep(settleMs);
  let emitted = { ...m1 };
  let chunkCount = 1;

  let landed = await detect(client, minPresence);

  // Optional single correction shot (opt-in via correctGatePx).
  if (options.correctGatePx !== undefined && landed && dist(landed, target) > options.correctGatePx) {
    const m2 = await emitToward(client, landed, target, paceMs);
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
