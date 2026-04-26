/**
 * Direct unit tests for mergeClusters. Previously covered only
 * transitively via diffScreenshotsDecoded — but the weighted-merge
 * logic for color preservation (Phase 1) and the union-find
 * grouping have edge cases worth pinning explicitly.
 */

import { describe, expect, it } from 'vitest';
import { mergeClusters, type Cluster } from '../cursor-detect.js';

const c = (
  centroidX: number,
  centroidY: number,
  pixels: number,
  color?: { r: number; g: number; b: number },
): Cluster => {
  const cluster: Cluster = { centroidX, centroidY, pixels };
  if (color) {
    cluster.meanR = color.r;
    cluster.meanG = color.g;
    cluster.meanB = color.b;
  }
  return cluster;
};

describe('mergeClusters', () => {
  it('returns the input unchanged when there is one cluster', () => {
    const input = [c(50, 50, 10)];
    expect(mergeClusters(input, 18)).toEqual(input);
  });

  it('returns the input unchanged when there are zero clusters', () => {
    expect(mergeClusters([], 18)).toEqual([]);
  });

  it('does not merge clusters farther apart than mergeRadius', () => {
    const r = mergeClusters([c(0, 0, 5), c(100, 100, 5)], 18);
    expect(r).toHaveLength(2);
  });

  it('merges two close clusters into one with pixel-weighted centroid', () => {
    // Cluster A at (0, 0) with 10 pixels and B at (10, 0) with 30 pixels.
    // Distance = 10, within mergeRadius 18. Merge.
    // Expected centroid: (0*10 + 10*30) / (10+30) = 300/40 = 7.5 → rounded 8.
    const r = mergeClusters([c(0, 0, 10), c(10, 0, 30)], 18);
    expect(r).toHaveLength(1);
    expect(r[0].centroidX).toBe(8);
    expect(r[0].centroidY).toBe(0);
    expect(r[0].pixels).toBe(40);
  });

  it('preserves color (weighted by pixels) when all merged clusters have color', () => {
    // Cluster A: 10 px gray (200, 200, 200). B: 30 px white (240, 240, 240).
    // Weighted: (200*10 + 240*30) / 40 = (2000 + 7200) / 40 = 230.
    const r = mergeClusters(
      [
        c(0, 0, 10, { r: 200, g: 200, b: 200 }),
        c(10, 0, 30, { r: 240, g: 240, b: 240 }),
      ],
      18,
    );
    expect(r).toHaveLength(1);
    expect(r[0].meanR).toBe(230);
    expect(r[0].meanG).toBe(230);
    expect(r[0].meanB).toBe(230);
  });

  it('drops color when ANY merged cluster lacks color (avoid mixing partial data)', () => {
    // Cluster A has color, B doesn't. Merge result: no color.
    const r = mergeClusters(
      [
        c(0, 0, 10, { r: 200, g: 200, b: 200 }),
        c(10, 0, 30), // no color
      ],
      18,
    );
    expect(r).toHaveLength(1);
    expect(r[0].meanR).toBeUndefined();
    expect(r[0].meanG).toBeUndefined();
    expect(r[0].meanB).toBeUndefined();
  });

  it('merges a chain of three clusters within radius transitively', () => {
    // A-B distance 10, B-C distance 10, A-C distance 20.
    // mergeRadius 15: A-B merge, B-C merge, hence A-B-C merge transitively.
    const r = mergeClusters(
      [c(0, 0, 5), c(10, 0, 5), c(20, 0, 5)],
      15,
    );
    expect(r).toHaveLength(1);
    expect(r[0].pixels).toBe(15);
    // Pixel-weighted centroid: (0*5 + 10*5 + 20*5) / 15 = 10.
    expect(r[0].centroidX).toBe(10);
  });

  it('keeps two distant pairs as two merged clusters (not one big one)', () => {
    // Pair A: (0,0) and (5,0), 5 px apart.
    // Pair B: (100,0) and (105,0), 5 px apart.
    // mergeRadius 10: A-pair merges, B-pair merges, but A-pair and B-pair
    // remain distinct (95 px apart).
    const r = mergeClusters(
      [c(0, 0, 10), c(5, 0, 10), c(100, 0, 10), c(105, 0, 10)],
      10,
    );
    expect(r).toHaveLength(2);
    const sortedX = r.map((cl) => cl.centroidX).sort((a, b) => a - b);
    expect(sortedX[0]).toBeLessThan(50);
    expect(sortedX[1]).toBeGreaterThan(50);
  });
});
