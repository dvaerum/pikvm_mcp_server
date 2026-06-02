import { describe, it, expect } from 'vitest';
import { planOpenLoopEmits, type PlanOpts } from '../open-loop-planner.js';

/** Default opts close to what move-to.ts will pass in production.
 *  Tests override the `predict` stub and any field they care about. */
function baseOpts(overrides: Partial<PlanOpts>): PlanOpts {
  return {
    chunkMag: 20,
    chunkPaceMs: 30,
    horizonMs: 50,
    tolPx: 5,
    maxEmits: 50,
    predict: async () => ({ dx: 0, dy: 0 }),
    hdmiPerLogicalScale: { x: 1, y: 1 },
    ...overrides,
  };
}

/** Constant 0.5 px-per-mickey forward model: each emit moves the
 *  cursor 0.5 logical px in each axis. With scale=1 that's 0.5 HDMI px
 *  per emit, so a 100-px target needs ~200 emits at mag=1, ~10 at mag=20. */
function stubProportional(perMickey: number) {
  return async (features: number[]) => ({
    dx: features[0] * perMickey,
    dy: features[1] * perMickey,
  });
}

describe('planOpenLoopEmits', () => {
  it('converges within tolPx for a pure-x target with a known stub model', async () => {
    // Stub: each emit moves cursor 0.5 px per mickey. chunkMag=20 →
    // 10 px per emit. 100-px target needs 10 emits.
    const result = await planOpenLoopEmits(
      { dxPx: 100, dyPx: 0 },
      baseOpts({ predict: stubProportional(0.5) }),
    );
    expect(result.predictorFailed).toBe(false);
    expect(result.hitMaxEmits).toBe(false);
    expect(Math.abs(result.residualPx.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(result.residualPx.y)).toBeLessThanOrEqual(5);
    expect(result.emits.length).toBe(10);
    // All emits should be on the +x axis at chunkMag.
    expect(result.emits.every(e => e.dx === 20 && e.dy === 0)).toBe(true);
  });

  it('converges for a pure -y target (sign handled correctly)', async () => {
    const result = await planOpenLoopEmits(
      { dxPx: 0, dyPx: -80 },
      baseOpts({ predict: stubProportional(0.5) }),
    );
    expect(result.predictorFailed).toBe(false);
    expect(result.hitMaxEmits).toBe(false);
    expect(Math.abs(result.residualPx.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(result.residualPx.y)).toBeLessThanOrEqual(5);
    expect(result.emits.every(e => e.dx === 0 && e.dy === -20)).toBe(true);
  });

  it('alternates between axes for a diagonal target (greedy zig-zag)', async () => {
    const result = await planOpenLoopEmits(
      { dxPx: 100, dyPx: 100 },
      baseOpts({ predict: stubProportional(0.5) }),
    );
    expect(result.predictorFailed).toBe(false);
    expect(Math.abs(result.residualPx.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(result.residualPx.y)).toBeLessThanOrEqual(5);
    // Cardinal-only invariant: never both axes nonzero in the same emit.
    expect(result.emits.every(e => e.dx === 0 || e.dy === 0)).toBe(true);
    // Both axes covered (zig-zag, not stuck on one).
    expect(result.emits.some(e => e.dx !== 0)).toBe(true);
    expect(result.emits.some(e => e.dy !== 0)).toBe(true);
  });

  it('respects maxEmits and reports hitMaxEmits=true on a degenerate predictor', async () => {
    // Stub predicts 0 displacement always — planner can never converge.
    const result = await planOpenLoopEmits(
      { dxPx: 100, dyPx: 0 },
      baseOpts({
        predict: async () => ({ dx: 0, dy: 0 }),
        maxEmits: 7,
      }),
    );
    expect(result.hitMaxEmits).toBe(true);
    expect(result.emits.length).toBe(7);
    // Residual unchanged because the stub never moves the cursor.
    expect(result.residualPx.x).toBe(100);
  });

  it('returns no emits when target is already inside tolPx', async () => {
    const result = await planOpenLoopEmits(
      { dxPx: 3, dyPx: -2 },
      baseOpts({ predict: stubProportional(0.5), tolPx: 5 }),
    );
    expect(result.emits).toHaveLength(0);
    expect(result.hitMaxEmits).toBe(false);
    expect(result.predictorFailed).toBe(false);
  });

  it('handles predictor returning null mid-plan: stops and reports predictorFailed=true', async () => {
    let callCount = 0;
    const failingPredict = async (features: number[]) => {
      callCount++;
      if (callCount > 3) return null;
      return { dx: features[0] * 0.5, dy: features[1] * 0.5 };
    };
    const result = await planOpenLoopEmits(
      { dxPx: 100, dyPx: 0 },
      baseOpts({ predict: failingPredict }),
    );
    expect(result.predictorFailed).toBe(true);
    expect(result.emits.length).toBe(3);
  });

  it('scales logical → HDMI via hdmiPerLogicalScale (non-unit case)', async () => {
    // Stub returns 0.5 logical px per mickey; scale 2× → 1 HDMI px per
    // mickey. chunkMag=20 → 20 HDMI px per emit. 100 px target → 5 emits.
    const result = await planOpenLoopEmits(
      { dxPx: 100, dyPx: 0 },
      baseOpts({
        predict: stubProportional(0.5),
        hdmiPerLogicalScale: { x: 2, y: 2 },
      }),
    );
    expect(result.predictorFailed).toBe(false);
    expect(result.hitMaxEmits).toBe(false);
    expect(result.emits.length).toBe(5);
    expect(Math.abs(result.residualPx.x)).toBeLessThanOrEqual(5);
  });

  it('uses the previous emit history when calling predict (feature plumbing)', async () => {
    // The predictor inspects sum_dx_100ms (features[2]). After two
    // chunks of dx=20 within 100ms, sum_dx_100ms should be 40.
    const observed: number[][] = [];
    const recordingPredict = async (features: number[]) => {
      observed.push([...features]);
      return { dx: 10, dy: 0 };
    };
    await planOpenLoopEmits(
      { dxPx: 50, dyPx: 0 },
      baseOpts({
        predict: recordingPredict,
        chunkPaceMs: 30,
        maxEmits: 3,
      }),
    );
    // Call 1: no prior history.
    expect(observed[0][2]).toBe(0);
    expect(observed[0][4]).toBe(0);
    // Call 2: one prior emit dx=20 at t=30, current emit at t=60.
    //         100-ms window covers it: sum_dx=20, count=1.
    expect(observed[1][2]).toBe(20);
    expect(observed[1][4]).toBe(1);
    // Call 3: two prior emits dx=20 at t=30,60; current at t=90.
    //         Both in 100-ms window: sum_dx=40, count=2.
    expect(observed[2][2]).toBe(40);
    expect(observed[2][4]).toBe(2);
  });

  it('terminates with the documented MAX_EMITS=50 bound by default', async () => {
    // Stub moves cursor only 0.01 px/mickey → 0.2 HDMI/emit, would
    // need 500 emits for 100 px. With maxEmits=50 we stop early.
    const result = await planOpenLoopEmits(
      { dxPx: 100, dyPx: 0 },
      baseOpts({ predict: stubProportional(0.01) }),
    );
    expect(result.hitMaxEmits).toBe(true);
    expect(result.emits.length).toBe(50);
  });
});
