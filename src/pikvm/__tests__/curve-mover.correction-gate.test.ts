import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveCorrectionGatePx,
  DEFAULT_ACCEPT_GATE_PX,
  CORRECTION_GATE_FLOOR_PX,
  moveByCurveOneShot,
} from '../curve-mover.js';
import type { PiKVMClient } from '../client.js';

// Root cause (measured 2026-07-31): the curve one-shot has a systematic ~18px
// open-loop error per geometry (~25.3px at one gate geometry). The mover's
// correction gate defaulted to 30, ABOVE the clicker's acceptance gate 25, so a
// residual in the [25,30) DEAD BAND was rejected by the clicker yet never re-shot.
// Fix: derive the correction gate strictly BELOW the acceptance gate, threaded from
// the caller so the two can't drift. maxResidualPx and the correctMaxPx=80 FP cap
// stay untouched.

describe('deriveCorrectionGatePx — the gate-ordering invariant', () => {
  it('derives strictly BELOW the acceptance gate, with margin, for the production default', () => {
    const g = deriveCorrectionGatePx(25);
    expect(g).toBeLessThan(25); // the invariant
    expect(g).toBeGreaterThanOrEqual(CORRECTION_GATE_FLOOR_PX);
    expect(g).toBe(12); // floor(25*0.5)=12 — in the manager's 10-12 range
  });

  it('INVARIANT holds across every acceptance gate: derived gate < acceptance gate', () => {
    for (const accept of [10, 12, 15, 20, 25, 30, 40, 50, 80, 100]) {
      expect(deriveCorrectionGatePx(accept)).toBeLessThan(accept);
    }
  });

  it('never drops below the ~8px correction floor for sane gates', () => {
    expect(deriveCorrectionGatePx(20)).toBeGreaterThanOrEqual(CORRECTION_GATE_FLOOR_PX);
    expect(deriveCorrectionGatePx(25)).toBeGreaterThanOrEqual(CORRECTION_GATE_FLOOR_PX);
  });

  it('falls back to the canonical acceptance default when the gate is absent or disabled', () => {
    expect(deriveCorrectionGatePx(undefined)).toBe(deriveCorrectionGatePx(DEFAULT_ACCEPT_GATE_PX));
    expect(deriveCorrectionGatePx(0)).toBe(deriveCorrectionGatePx(DEFAULT_ACCEPT_GATE_PX));
  });

  it('stays strictly below even for tiny/pathological acceptance gates', () => {
    expect(deriveCorrectionGatePx(6)).toBeLessThan(6);
    expect(deriveCorrectionGatePx(9)).toBeLessThan(9);
  });
});

// ── Integration: drive moveByCurveOneShot with an injected detect seam + a recording
//    stub client (no onnxruntime). Prove the dead-band residual now gets ONE
//    correction, that sub-gate and above-FP-cap residuals don't, and that an explicit
//    over-gate override is still clamped below the acceptance gate.

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

describe('moveByCurveOneShot — correction fires for dead-band residuals (fix)', () => {
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

  it('a 25.3px dead-band residual (the failing case) now takes ONE correction ⇒ lands clean', async () => {
    // start → first shot lands 25.3px (dead band: > derived gate 12, < FP cap 80) →
    // correction → lands ~0. accept gate 25 (production default).
    const r = await run([START, landedAt(25.3), landedAt(0.2)], { acceptGatePx: 25 });
    expect(r.chunkCount).toBe(2); // the correction shot ran
    expect(r.finalResidualPx).toBeLessThan(1);
  });

  it('a mid-band 18px residual also corrects (systematic open-loop error) ⇒ tightens to ~0', async () => {
    const r = await run([START, landedAt(18), landedAt(0.3)], { acceptGatePx: 25 });
    expect(r.chunkCount).toBe(2);
    expect(r.finalResidualPx).toBeLessThan(1);
  });

  it('a residual BELOW the derived gate (5px) does NOT correct — no wasted shot', async () => {
    const r = await run([START, landedAt(5)], { acceptGatePx: 25 });
    expect(r.chunkCount).toBe(1);
    expect(r.finalResidualPx).toBeCloseTo(5, 0);
  });

  it('a residual ABOVE the FP cap (100px) does NOT correct — the correctMaxPx guard stands', async () => {
    const r = await run([START, landedAt(100)], { acceptGatePx: 25 });
    expect(r.chunkCount).toBe(1); // V8 false-positive territory — trust the first shot
    expect(r.finalResidualPx).toBeCloseTo(100, 0);
  });

  it('an explicit over-gate correctGatePx is CLAMPED below the acceptance gate (invariant holds vs override)', async () => {
    // correctGatePx=30 would reopen the [25,30) dead band; clamped to accept-1=24, so
    // a 25.3px shot still corrects.
    const r = await run([START, landedAt(25.3), landedAt(0.2)], { acceptGatePx: 25, correctGatePx: 30 });
    expect(r.chunkCount).toBe(2);
    expect(r.finalResidualPx).toBeLessThan(1);
  });
});
