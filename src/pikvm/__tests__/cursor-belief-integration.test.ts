/**
 * Phase 192-A: end-to-end integration tests for CursorBelief.
 *
 * These tests simulate emit/observe sequences against synthetic
 * "ground truth" trajectories and verify that the belief converges
 * to the truth and inflates variance correctly when observations
 * are sparse or absent.
 *
 * The synthetic environment models:
 *   - A "true" cursor position that updates by `emit · trueRatio`
 *     per emit, clipped to bounds.
 *   - Observations that are the truth + Gaussian noise.
 *
 * The belief never sees the truth directly — only emits and noisy
 * observations. We verify it converges anyway.
 */

import { describe, expect, it } from 'vitest';
import { CursorBelief } from '../cursor-belief.js';

// Box-Muller-ish noise — deterministic with seed for reproducibility.
function makeNoise(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    const u = s / 233280;
    s = (s * 9301 + 49297) % 233280;
    const v = s / 233280;
    return Math.sqrt(-2 * Math.log(u + 1e-9)) * Math.cos(2 * Math.PI * v);
  };
}

interface Bounds { x: number; y: number; width: number; height: number }

class SyntheticGroundTruth {
  position: { x: number; y: number };
  trueRatio: { x: number; y: number };
  bounds: Bounds | null;

  constructor(start: { x: number; y: number }, ratio: { x: number; y: number }, bounds: Bounds | null = null) {
    this.position = { ...start };
    this.trueRatio = { ...ratio };
    this.bounds = bounds;
  }

  emit(dx: number, dy: number): void {
    this.position.x += dx * this.trueRatio.x;
    this.position.y += dy * this.trueRatio.y;
    if (this.bounds) {
      this.position.x = Math.max(this.bounds.x, Math.min(this.bounds.x + this.bounds.width, this.position.x));
      this.position.y = Math.max(this.bounds.y, Math.min(this.bounds.y + this.bounds.height, this.position.y));
    }
  }

  observe(noiseStd = 2, noise: () => number = makeNoise()): { x: number; y: number } {
    return {
      x: this.position.x + noise() * noiseStd,
      y: this.position.y + noise() * noiseStd,
    };
  }
}

describe('CursorBelief integration', () => {
  it('converges to ground truth across 20 emit/observe cycles with noisy observations', () => {
    const truth = new SyntheticGroundTruth({ x: 100, y: 100 }, { x: 1.5, y: 1.5 });
    const belief = new CursorBelief({
      initialPosition: { x: 100, y: 100 },
      initialPositionVariance: 25,
      ratioPrior: { x: 1.3, y: 1.3 }, // wrong on purpose — should learn the truth
      ratioVariancePrior: { x: 0.3, y: 0.3 },
    });
    const noise = makeNoise(42);
    for (let i = 0; i < 20; i++) {
      const dx = (i % 2 === 0) ? 30 : -20;
      const dy = (i % 3 === 0) ? 20 : -10;
      truth.emit(dx, dy);
      belief.predict({ dx, dy });
      const obs = truth.observe(2, noise);
      belief.observe(obs, 0.9);
    }
    // Belief position should be within ~3 px of ground truth.
    expect(Math.abs(belief.position.x - truth.position.x)).toBeLessThan(5);
    expect(Math.abs(belief.position.y - truth.position.y)).toBeLessThan(5);
    // Belief ratio should have moved toward 1.5 from the wrong 1.3 prior.
    expect(belief.ratio.x).toBeGreaterThan(1.4);
    expect(belief.ratio.x).toBeLessThan(1.6);
  });

  it('emit-into-edge inflates clipped-axis variance without diverging the perpendicular axis', () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 800 };
    const truth = new SyntheticGroundTruth({ x: 990, y: 400 }, { x: 1.5, y: 1.5 }, bounds);
    const belief = new CursorBelief({
      initialPosition: { x: 990, y: 400 },
      initialPositionVariance: 4, // start tight
      bounds,
    });
    const yVarBaseline = belief.variance.y;
    // Push hard against the right edge 10 times.
    for (let i = 0; i < 10; i++) {
      truth.emit(50, 0); // truth clamps at x=1000
      belief.predict({ dx: 50, dy: 0 }); // belief should clamp + inflate X variance
      // No observation — we want to see how belief evolves with predict-only.
    }
    // Belief X should be at the right edge.
    expect(belief.position.x).toBe(1000);
    // X variance should have grown massively from accumulated edge-clip
    // inflation across 10 predicts.
    expect(belief.variance.x).toBeGreaterThan(100);
    // Y variance should be roughly unchanged (no Y emit, no clipping).
    expect(belief.variance.y).toBeLessThan(yVarBaseline * 5);
  });

  it('after a long predict-only run, an observation collapses the wide belief tight again', () => {
    const belief = new CursorBelief({
      initialPosition: { x: 0, y: 0 },
      initialPositionVariance: 4,
    });
    // Predict-only — variance grows.
    for (let i = 0; i < 20; i++) belief.predict({ dx: 30, dy: 30 });
    expect(belief.variance.x).toBeGreaterThan(50);
    // One high-confidence observation should pull variance back down.
    belief.observe({ x: belief.position.x, y: belief.position.y }, 1.0);
    expect(belief.variance.x).toBeLessThan(10);
  });

  it('Phase 192 trajectory replay: cursor pinned at right edge, then unstuck via opposite-direction emits', () => {
    // Replay the live trajectory observation: cursor was pinned at
    // ~(1118, 1010) on a 1170×1010 iPad area. Pushing east does
    // nothing; pushing west should unclamp with predicted ratio.
    const bounds = { x: 510, y: 50, width: 660, height: 960 }; // iPad letterbox
    const truth = new SyntheticGroundTruth({ x: 1118, y: 1010 }, { x: 1.5, y: 1.5 }, bounds);
    const belief = new CursorBelief({
      initialPosition: { x: 1118, y: 1010 },
      initialPositionVariance: 4,
      bounds,
    });
    // 6 chunks of (+15, 0): truth stays clamped, belief should know.
    for (let i = 0; i < 6; i++) {
      truth.emit(15, 0);
      belief.predict({ dx: 15, dy: 0 });
    }
    expect(truth.position.x).toBe(1170); // truth clamped at right edge
    expect(belief.position.x).toBe(1170); // belief clamped too
    expect(belief.variance.x).toBeGreaterThan(50); // belief knows it's uncertain
    // Now unstick: 4 chunks of (-50, -50). Truth moves; belief should move.
    for (let i = 0; i < 4; i++) {
      truth.emit(-50, -50);
      belief.predict({ dx: -50, dy: -50 });
    }
    // Truth has moved away from right edge.
    expect(truth.position.x).toBeLessThan(1170);
    expect(belief.position.x).toBeLessThan(1170);
  });
});
