/**
 * Unit tests for the desktop-e2e harness metrics (src/pikvm/desktop-e2e-metrics.ts).
 * These pin the target-grid, residual, landed-cluster, and pass/fail math so the
 * live harness's verdict logic is trustworthy without needing a PiKVM.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTargetGrid,
  residualPx,
  pickLandedCluster,
  percentile,
  summarizeResiduals,
  type TrialResult,
} from '../desktop-e2e-metrics.js';

describe('buildTargetGrid', () => {
  it('insets targets from the edges by marginFrac and spans corner-to-corner', () => {
    const g = buildTargetGrid(1000, 1000, 2, 2, 0.1);
    // 0.1 margin on a 1000px frame → span [100, 900] in both axes.
    expect(g).toEqual([
      { x: 100, y: 100 },
      { x: 900, y: 100 },
      { x: 100, y: 900 },
      { x: 900, y: 900 },
    ]);
  });

  it('places a 1×1 grid at the frame centre', () => {
    expect(buildTargetGrid(1920, 1080, 1, 1, 0.15)).toEqual([{ x: 960, y: 540 }]);
  });

  it('is row-major and stays within the frame for a 3×2 grid', () => {
    const g = buildTargetGrid(1920, 1080, 3, 2, 0.15);
    expect(g).toHaveLength(6);
    for (const p of g) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1920);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1080);
    }
    // Row-major: first three share the top row's y, last three the bottom row's.
    expect(g[0].y).toBe(g[1].y);
    expect(g[1].y).toBe(g[2].y);
    expect(g[3].y).toBe(g[4].y);
    expect(g[0].y).toBeLessThan(g[3].y);
  });

  it('rejects invalid dimensions and margins', () => {
    expect(() => buildTargetGrid(100, 100, 0, 2)).toThrow(/>= 1/);
    expect(() => buildTargetGrid(100, 100, 2, 2, 0.5)).toThrow(/marginFrac/);
    expect(() => buildTargetGrid(100, 100, 2, 2, -0.1)).toThrow(/marginFrac/);
  });
});

describe('residualPx', () => {
  it('is the euclidean distance', () => {
    expect(residualPx({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(residualPx({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
  });
});

describe('pickLandedCluster', () => {
  it('picks the cluster centroid nearest the target (rejecting unrelated churn)', () => {
    const clusters = [
      { centroidX: 500, centroidY: 500, pixels: 40 }, // unrelated churn, far
      { centroidX: 103, centroidY: 98, pixels: 12 }, // the cursor, near target
    ];
    const r = pickLandedCluster(clusters, { x: 100, y: 100 });
    expect(r?.landed).toEqual({ x: 103, y: 98 });
    expect(r?.residualPx).toBeCloseTo(Math.hypot(3, 2), 5);
  });

  it('returns null when there are no clusters (cursor not located)', () => {
    expect(pickLandedCluster([], { x: 100, y: 100 })).toBeNull();
  });
});

describe('percentile', () => {
  it('uses nearest-rank and handles empties', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 90)).toBe(5);
  });
});

describe('summarizeResiduals', () => {
  const located = (target: { x: number; y: number }, residual: number): TrialResult => ({
    target,
    landed: { x: target.x + residual, y: target.y },
    residualPx: residual,
  });
  const missed = (target: { x: number; y: number }): TrialResult => ({
    target,
    landed: null,
    residualPx: null,
  });

  it('passes when all targets located and p90 within threshold', () => {
    const s = summarizeResiduals(
      [located({ x: 1, y: 1 }, 2), located({ x: 2, y: 2 }, 3), located({ x: 3, y: 3 }, 4)],
      10,
    );
    expect(s.n).toBe(3);
    expect(s.located).toBe(3);
    expect(s.locateRate).toBe(1);
    expect(s.residualP50).toBe(3);
    expect(s.worstResidualPx).toBe(4);
    expect(s.passed).toBe(true);
  });

  it('fails when a target was not located (a blind miss), even if others are tight', () => {
    const s = summarizeResiduals([located({ x: 1, y: 1 }, 1), missed({ x: 2, y: 2 })], 50);
    expect(s.locateRate).toBe(0.5);
    expect(s.passed).toBe(false);
  });

  it('fails when the p90 residual exceeds the threshold', () => {
    const s = summarizeResiduals(
      [located({ x: 1, y: 1 }, 2), located({ x: 2, y: 2 }, 3), located({ x: 3, y: 3 }, 99)],
      10,
    );
    expect(s.located).toBe(3);
    expect(s.residualP90).toBe(99);
    expect(s.passed).toBe(false);
  });

  it('reports an empty run as not passed', () => {
    const s = summarizeResiduals([], 10);
    expect(s.n).toBe(0);
    expect(s.locateRate).toBe(0);
    expect(s.passed).toBe(false);
  });
});
