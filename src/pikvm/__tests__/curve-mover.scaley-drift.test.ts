import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_CURVE_SCALE_Y, moveByCurveOneShot } from '../curve-mover.js';
import type { PiKVMClient } from '../client.js';

// Point-in-time Y drift compensation (2026-07-31). curveScaleY defaults to the
// BEHAVIORALLY-validated 1.0364 (held-out N=80/arm: 63% → 1% would-skip). These
// tests pin the value + provenance so a future reader can't silently "simplify" it to
// the geometric ratio, and guard the default wiring against a silent revert to `?? 1`.

describe('DEFAULT_CURVE_SCALE_Y — point-in-time drift compensation, provenance pinned', () => {
  it('is the BEHAVIORAL value 1.0364, NOT the geometric ratio compensation', () => {
    expect(DEFAULT_CURVE_SCALE_Y).toBe(1.0364);
    // The getCursor/V8-measured true Y:X ratio today is 0.9892 → a geometric
    // compensation of ~1/0.9892 = 1.0109. Behavior needs 3.64%, ~1pp more, because of
    // the mickeysForReport curve-interpolation term. Assert we did NOT simplify to
    // the geometric value (that would leave ~a third of the error in).
    const geometricCompensation = 1 / 0.9892;
    expect(Math.abs(DEFAULT_CURVE_SCALE_Y - geometricCompensation)).toBeGreaterThan(0.02);
    expect(DEFAULT_CURVE_SCALE_Y).toBeGreaterThan(1.03); // compensates a real +~3.6% Y overshoot
  });
});

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

describe('moveByCurveOneShot — the Y drift compensation is applied BY DEFAULT', () => {
  afterEach(() => vi.useRealTimers());

  const START = { x: 100, y: 100 };
  const TARGET = { x: 100, y: 800 }; // pure-Y long move (dy=700)

  async function yMickeys(options: Record<string, unknown>): Promise<number> {
    const client = new RecordingClient();
    vi.useFakeTimers();
    // land exactly on target so no correction fires — isolate the first shot's plan.
    const detect = async () => TARGET;
    let first = true;
    const detectSeq = async () => (first ? ((first = false), START) : TARGET);
    void detect;
    const p = moveByCurveOneShot(client as unknown as PiKVMClient, TARGET, options, { detect: detectSeq });
    await vi.runAllTimersAsync();
    await p;
    // emitToward emits X (dy=0) then Y (dx=0); sum the Y-emit magnitude.
    return client.emits.filter(([, dy]) => dy !== 0).reduce((s, [, dy]) => s + Math.abs(dy), 0);
  }

  it('the default plan emits FEWER Y mickeys than an uncompensated (curveScaleY:1) plan', async () => {
    const withDefault = await yMickeys({}); // uses DEFAULT_CURVE_SCALE_Y
    const uncompensated = await yMickeys({ curveScaleY: 1 });
    // scale > 1 ⇒ D = |dy| / scale is smaller ⇒ shorter plan ⇒ compensates the Y
    // overshoot. If someone reverts the default to `?? 1`, these go equal and this fails.
    expect(withDefault).toBeLessThan(uncompensated);
  });
});
