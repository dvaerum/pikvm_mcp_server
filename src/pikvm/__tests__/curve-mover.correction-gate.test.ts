import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveCorrectionGatePx,
  DEFAULT_ACCEPT_GATE_PX,
  CORRECTION_GATE_FLOOR_PX,
  moveByCurveOneShot,
} from '../curve-mover.js';
import { defaultMaxResidualPxFor } from '../click-verify.js';
import type { PiKVMClient } from '../client.js';

// Root cause (measured 2026-07-31): the curve one-shot has a systematic ~18px
// open-loop error per geometry (~25.3px at one gate geometry). The mover's
// correction gate defaulted to 30, ABOVE the clicker's acceptance gate 25, so a
// residual in the [25,30) DEAD BAND was rejected by the clicker yet never re-shot.
// Fix: derive correctGatePx FROM the acceptance gate (threaded), f=1.0 ⇒ gate ==
// accept ⇒ "correct IFF the shot would otherwise skip" — one visible tolerance knob
// (maxResidualPx), no wasted 1.37s correction cycles on shots that already pass.
// maxResidualPx and the correctMaxPx=80 FP cap stay untouched.

describe('deriveCorrectionGatePx — the gate-ordering invariant (f=1.0)', () => {
  it('equals the acceptance gate for the production default (correct iff would-skip)', () => {
    expect(deriveCorrectionGatePx(25)).toBe(25);
  });

  it('INVARIANT: derived gate NEVER exceeds the acceptance gate (no dead band) for any sane gate', () => {
    for (const accept of [8, 10, 12, 15, 20, 25, 30, 40, 50, 80, 100]) {
      expect(deriveCorrectionGatePx(accept)).toBeLessThanOrEqual(accept);
    }
  });

  it('floors at the ~8px achievable precision (a sub-floor acceptance gets one correction then honest skip)', () => {
    expect(deriveCorrectionGatePx(6)).toBe(CORRECTION_GATE_FLOOR_PX); // 8, above the unmeetable 6
    expect(deriveCorrectionGatePx(8)).toBe(CORRECTION_GATE_FLOOR_PX);
  });

  it('falls back to the canonical acceptance default when the gate is absent or disabled', () => {
    expect(deriveCorrectionGatePx(undefined)).toBe(deriveCorrectionGatePx(DEFAULT_ACCEPT_GATE_PX));
    expect(deriveCorrectionGatePx(0)).toBe(deriveCorrectionGatePx(DEFAULT_ACCEPT_GATE_PX));
  });

  // georgs's regression: the two DEFAULTS must stay tied — this is exactly how the
  // mover's hardcoded 30 silently drifted above the clicker's 25.
  it('the fallback acceptance default matches index.ts\'s real maxResidualPx default (iPad)', () => {
    expect(DEFAULT_ACCEPT_GATE_PX).toBe(defaultMaxResidualPxFor(false)); // false = relative-mouse (iPad)
  });

  it('the derived default correction gate is NEVER above the acceptance default (the dead-band the bug had)', () => {
    expect(deriveCorrectionGatePx(DEFAULT_ACCEPT_GATE_PX)).toBeLessThanOrEqual(DEFAULT_ACCEPT_GATE_PX);
  });

  it('the correction gate FOLLOWS the acceptance gate (task #38: 15 ⇒ gate 15, one knob via f=1.0)', () => {
    expect(DEFAULT_ACCEPT_GATE_PX).toBe(15); // tightened from 25
    expect(deriveCorrectionGatePx(15)).toBe(15); // f=1.0 ⇒ gate tracks accept, no manual second constant
  });
});

// ── Integration: drive moveByCurveOneShot with an injected detect seam + a recording
//    stub client (no onnxruntime). Prove the dead-band residual now gets ONE
//    correction, that an already-accepted shot does NOT (no wasted 1.37s cycle under
//    f=1.0), that above-FP-cap doesn't, and that an over-gate override is capped.

class RecordingClient {
  emits: Array<[number, number]> = [];
  belief = {} as unknown;
  async getResolution(): Promise<{ width: number; height: number }> {
    return { width: 1920, height: 1080 };
  }
  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    return { buffer: Buffer.from('frame'), screenshotWidth: 1920, screenshotHeight: 1080 };
  }
  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    this.emits.push([dx, dy]);
  }
}

const TARGET = { x: 800, y: 600 };
const START = { x: 100, y: 100 };
/** A detected landing `px` pixels from TARGET (offset along +x). */
const landedAt = (px: number) => ({ x: TARGET.x + px, y: TARGET.y });

describe('moveByCurveOneShot — correction fires iff the shot would otherwise skip (f=1.0)', () => {
  afterEach(() => vi.useRealTimers());

  async function run(detectSeq: Array<{ x: number; y: number } | null>, options: Record<string, unknown>) {
    const client = new RecordingClient();
    vi.useFakeTimers();
    let i = 0;
    const detect = async () => detectSeq[Math.min(i++, detectSeq.length - 1)];
    const p = moveByCurveOneShot(client as unknown as PiKVMClient, TARGET, options, { detect });
    await vi.runAllTimersAsync();
    return p;
  }

  it('a 25.3px residual (> accept 25, the failing case) takes ONE correction ⇒ lands clean', async () => {
    const r = await run([START, landedAt(25.3), landedAt(0.2)], { acceptGatePx: 25 });
    expect(r.chunkCount).toBe(2); // the correction shot ran
    expect(r.finalResidualPx).toBeLessThan(1);
  });

  it('an already-ACCEPTED 18px residual (< accept 25) does NOT correct — no wasted 1.37s cycle', async () => {
    const r = await run([START, landedAt(18)], { acceptGatePx: 25 });
    expect(r.chunkCount).toBe(1); // 18 ≤ 25 passes; f=1.0 does not secretly tighten it
    expect(r.finalResidualPx).toBeCloseTo(18, 0);
  });

  it('lowering the acceptance gate AUTO-tightens via the same knob: 18px now corrects when accept=15', async () => {
    const r = await run([START, landedAt(18), landedAt(0.3)], { acceptGatePx: 15 });
    expect(r.chunkCount).toBe(2); // 18 > 15 ⇒ would skip ⇒ corrects — maxResidualPx is the single knob
    expect(r.finalResidualPx).toBeLessThan(1);
  });

  it('a residual ABOVE the FP cap (100px) does NOT correct — the correctMaxPx guard stands', async () => {
    const r = await run([START, landedAt(100)], { acceptGatePx: 25 });
    expect(r.chunkCount).toBe(1); // V8 false-positive territory — trust the first shot
    expect(r.finalResidualPx).toBeCloseTo(100, 0);
  });

  it('correctGatePx: Infinity DISABLES the correction (pure open-loop shot for calibration) even at 28px', async () => {
    // The cap must NOT clamp a non-finite override down to the acceptance gate —
    // that silently corrupts open-loop measurement (georgs 2026-07-31: a 28px
    // "control" got corrected to 5px, invalidating a Y-scale calibration run).
    const r = await run([START, landedAt(28)], { acceptGatePx: 25, correctGatePx: Infinity });
    expect(r.chunkCount).toBe(1); // no correction fired — raw open-loop residual preserved
    expect(r.finalResidualPx).toBeCloseTo(28, 0);
  });

  it('a NaN correctGatePx (e.g. Number(unset env)) does NOT silently disable the correction — falls back to derived', async () => {
    // Only Infinity is the disable sentinel; a garbage knob must not quietly drop the
    // safety net (the silent-knob class this change closes). NaN ⇒ derived gate 25 ⇒
    // a 25.3px dead-band shot still corrects.
    const r = await run([START, landedAt(25.3), landedAt(0.2)], { acceptGatePx: 25, correctGatePx: NaN });
    expect(r.chunkCount).toBe(2);
    expect(r.finalResidualPx).toBeLessThan(1);
  });

  it('floor-collision: a sub-floor acceptance (5px) takes ONE correction, lands at the ~8px floor, does NOT spin', async () => {
    // acceptance below the achievable precision ⇒ derived gate = 8 (floor). An 18px
    // shot corrects once → ~8px; the mover allows exactly ONE correction (no loop),
    // and 8 > 5 so the click_at handler then skips truthfully (not-landed) downstream.
    const r = await run([START, landedAt(18), landedAt(8.0), landedAt(8.0)], { acceptGatePx: 5 });
    expect(r.chunkCount).toBe(2); // exactly one correction — never a spin
    expect(r.finalResidualPx).toBeCloseTo(8, 0);
  });

  it('an explicit over-gate correctGatePx is CAPPED at the acceptance gate (invariant holds vs override)', async () => {
    // correctGatePx=30 would reopen the [25,30) dead band; capped to accept=25, so a
    // 25.3px shot still corrects.
    const r = await run([START, landedAt(25.3), landedAt(0.2)], { acceptGatePx: 25, correctGatePx: 30 });
    expect(r.chunkCount).toBe(2);
    expect(r.finalResidualPx).toBeLessThan(1);
  });
});
