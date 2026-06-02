import { describe, it, expect, beforeEach } from 'vitest';
import {
  FEATURE_DIM,
  HISTORY_WINDOW_MS,
  buildFeatures,
  predictDisplacement,
  __resetPointerAccelSessionForTest,
  __setPointerAccelSessionForTest,
} from '../pointer-accel.js';

// Lightweight stub matching the shape predictDisplacement uses.
function makeStubSession(returnVec: [number, number]) {
  return {
    run: async (_feeds: Record<string, unknown>) => ({
      dxdy: {
        data: Float32Array.from(returnVec),
      },
    }),
  } as unknown as Parameters<typeof __setPointerAccelSessionForTest>[0];
}

describe('buildFeatures', () => {
  it('produces an 8-element vector', () => {
    const f = buildFeatures(
      [],
      { vxPxPerMs: 0, vyPxPerMs: 0 },
      { dx: 10, dy: 0, t: 1000 },
      0,
    );
    expect(f.length).toBe(FEATURE_DIM);
  });

  it('puts current emit dx/dy at indices 0/1', () => {
    const f = buildFeatures(
      [],
      { vxPxPerMs: 0, vyPxPerMs: 0 },
      { dx: 7, dy: -3, t: 1000 },
      0,
    );
    expect(f[0]).toBe(7);
    expect(f[1]).toBe(-3);
  });

  it('cold start with no history: sums = 0, count = 0', () => {
    const f = buildFeatures(
      [],
      { vxPxPerMs: 0, vyPxPerMs: 0 },
      { dx: 5, dy: 0, t: 1000 },
      0,
    );
    expect(f[2]).toBe(0);
    expect(f[3]).toBe(0);
    expect(f[4]).toBe(0);
  });

  it('sums and counts only emits within HISTORY_WINDOW_MS', () => {
    // current emit at t=1000, HISTORY_WINDOW_MS = 100 (trainer's <=
    // predicate). Inclusive boundary at t=900.
    const history = [
      { t: 800, dx: 100, dy: 0 }, // 1000 - 800 = 200 > 100, OUT
      { t: 850, dx: 2, dy: 0 },   // 1000 - 850 = 150 > 100, OUT
      { t: 900, dx: 3, dy: 1 },   // 1000 - 900 = 100 == window, IN
      { t: 950, dx: 5, dy: -2 },  // IN
      { t: 990, dx: 1, dy: 0 },   // IN
    ];
    const f = buildFeatures(
      history,
      { vxPxPerMs: 0, vyPxPerMs: 0 },
      { dx: 0, dy: 0, t: 1000 },
      10,
    );
    // The boundary (1000-900=100 == HISTORY_WINDOW_MS) is INCLUDED per the
    // trainer's `<=` predicate.
    expect(f[2]).toBe(3 + 5 + 1);
    expect(f[3]).toBe(1 + -2 + 0);
    expect(f[4]).toBe(3);
  });

  it('breaks the walk as soon as one entry is too old (chronological)', () => {
    // Emit history must be chronological for the rolling walk to stop
    // correctly when it crosses the window boundary.
    const history = [
      { t: 700, dx: 999, dy: 999 }, // very old; would skew totals if walked
      { t: 980, dx: 4, dy: 0 },
    ];
    const f = buildFeatures(
      history,
      { vxPxPerMs: 0, vyPxPerMs: 0 },
      { dx: 0, dy: 0, t: 1000 },
      20,
    );
    expect(f[2]).toBe(4);
    expect(f[3]).toBe(0);
    expect(f[4]).toBe(1);
  });

  it('plumbs dt_prev_emit_ms through unchanged at index 5', () => {
    const f = buildFeatures(
      [],
      { vxPxPerMs: 0, vyPxPerMs: 0 },
      { dx: 1, dy: 0, t: 5000 },
      42.5,
    );
    expect(f[5]).toBe(42.5);
  });

  it('places cursor velocity at indices 6/7', () => {
    const f = buildFeatures(
      [],
      { vxPxPerMs: 1.25, vyPxPerMs: -0.5 },
      { dx: 0, dy: 0, t: 1000 },
      0,
    );
    expect(f[6]).toBe(1.25);
    expect(f[7]).toBe(-0.5);
  });

  it('HISTORY_WINDOW_MS is the 100 ms value the trainer uses', () => {
    expect(HISTORY_WINDOW_MS).toBe(100);
  });
});

describe('predictDisplacement', () => {
  beforeEach(() => {
    __resetPointerAccelSessionForTest();
  });

  it('returns the stubbed (dx, dy)', async () => {
    __setPointerAccelSessionForTest(makeStubSession([7.5, -3.25]));
    const out = await predictDisplacement([
      10, 0, 10, 0, 0, 0, 0, 0,
    ]);
    expect(out).toEqual({ dx: 7.5, dy: -3.25 });
  });

  it('falls back to null when the session fails to load', async () => {
    __setPointerAccelSessionForTest(null);
    const out = await predictDisplacement([
      10, 0, 10, 0, 0, 0, 0, 0,
    ]);
    expect(out).toBeNull();
  });

  it('rejects features of the wrong length', async () => {
    __setPointerAccelSessionForTest(makeStubSession([0, 0]));
    await expect(
      predictDisplacement([1, 2, 3]),
    ).rejects.toThrow(/features\.length/);
  });

  it('chains buildFeatures into predictDisplacement', async () => {
    __setPointerAccelSessionForTest(makeStubSession([12.0, -1.0]));
    const features = buildFeatures(
      [{ t: 960, dx: 20, dy: 0 }],
      { vxPxPerMs: 0.05, vyPxPerMs: 0 },
      { dx: 20, dy: 0, t: 1000 },
      40,
    );
    expect(features.length).toBe(FEATURE_DIM);
    const out = await predictDisplacement(features);
    expect(out).toEqual({ dx: 12, dy: -1 });
  });
});

describe('resolveDefaultModelPath', () => {
  // Env-var-driven model selection lets the model swap without editing source.
  // Mirrors PIKVM_ML_V8_MODEL pattern in cursor-ml-detect.
  // 2026-06-02 (1.11): default flipped v1 → v2-wider after live A/B (v2-wider
  // HIT 16/20 vs v1 HIT 5/20, +55pp).
  it('returns v2-wider ONNX when PIKVM_POINTER_ACCEL_MODEL is unset', async () => {
    const prev = process.env.PIKVM_POINTER_ACCEL_MODEL;
    delete process.env.PIKVM_POINTER_ACCEL_MODEL;
    try {
      const { resolveDefaultModelPath } = await import('../pointer-accel.js');
      expect(resolveDefaultModelPath()).toMatch(/pointer-accel-v2-wider\.onnx$/);
    } finally {
      if (prev !== undefined) process.env.PIKVM_POINTER_ACCEL_MODEL = prev;
    }
  });

  it('returns the env-var path when PIKVM_POINTER_ACCEL_MODEL is set', async () => {
    const prev = process.env.PIKVM_POINTER_ACCEL_MODEL;
    process.env.PIKVM_POINTER_ACCEL_MODEL = '/tmp/pointer-accel-v2-experimental.onnx';
    try {
      const { resolveDefaultModelPath } = await import('../pointer-accel.js');
      expect(resolveDefaultModelPath()).toBe('/tmp/pointer-accel-v2-experimental.onnx');
    } finally {
      if (prev === undefined) delete process.env.PIKVM_POINTER_ACCEL_MODEL;
      else process.env.PIKVM_POINTER_ACCEL_MODEL = prev;
    }
  });
});
