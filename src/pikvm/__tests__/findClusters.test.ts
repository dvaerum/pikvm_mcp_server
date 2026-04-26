/**
 * Direct unit tests for findClusters. Previously only exercised via
 * cluster-color.test.ts which focused on Phase 1 color tracking, so
 * the pure connectivity / size-filter / centroid mechanics weren't
 * pinned against future regressions.
 */

import { describe, expect, it } from 'vitest';
import { findClusters } from '../cursor-detect.js';

// Build a width×height boolean mask from a list of (x,y) true points.
function makeMask(width: number, height: number, points: Array<[number, number]>): boolean[] {
  const mask = new Array<boolean>(width * height).fill(false);
  for (const [x, y] of points) mask[y * width + x] = true;
  return mask;
}

describe('findClusters', () => {
  it('returns no clusters from an empty mask', () => {
    const mask = new Array<boolean>(10 * 10).fill(false);
    expect(findClusters(mask, 10, 10, 1, 1000)).toEqual([]);
  });

  it('returns one cluster for a single connected blob', () => {
    // 3×3 block of true at (5..7, 5..7).
    const points: Array<[number, number]> = [];
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) points.push([x, y]);
    const mask = makeMask(20, 20, points);
    const clusters = findClusters(mask, 20, 20, 1, 1000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].pixels).toBe(9);
    expect(clusters[0].centroidX).toBe(6); // mean of 5,6,7 = 6
    expect(clusters[0].centroidY).toBe(6);
  });

  it('respects minSize: cluster smaller than minSize is dropped', () => {
    // 3-pixel cluster, minSize 5 → dropped.
    const mask = makeMask(20, 20, [[5, 5], [5, 6], [6, 5]]);
    const clusters = findClusters(mask, 20, 20, 5, 1000);
    expect(clusters).toEqual([]);
  });

  it('respects maxSize: cluster larger than maxSize is dropped', () => {
    // 9-pixel block, maxSize 5 → dropped.
    const points: Array<[number, number]> = [];
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) points.push([x, y]);
    const mask = makeMask(20, 20, points);
    const clusters = findClusters(mask, 20, 20, 1, 5);
    expect(clusters).toEqual([]);
  });

  it('treats diagonally adjacent pixels as connected (8-connectivity)', () => {
    // Three pixels in a diagonal: (0,0), (1,1), (2,2). All connected.
    const mask = makeMask(20, 20, [[0, 0], [1, 1], [2, 2]]);
    const clusters = findClusters(mask, 20, 20, 1, 1000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].pixels).toBe(3);
  });

  it('separates two disjoint blobs into two clusters', () => {
    const mask = makeMask(40, 40, [
      [5, 5], [5, 6], [6, 5], [6, 6],     // 2×2 at (5,5)
      [30, 30], [30, 31], [31, 30], [31, 31], // 2×2 at (30,30)
    ]);
    const clusters = findClusters(mask, 40, 40, 1, 1000);
    expect(clusters).toHaveLength(2);
    const sortedX = clusters.map((c) => c.centroidX).sort((a, b) => a - b);
    expect(sortedX[0]).toBeLessThan(20);
    expect(sortedX[1]).toBeGreaterThan(20);
  });

  it('handles clusters at frame boundaries without crashing', () => {
    // Cluster touching all four edges.
    const w = 20, h = 20;
    const mask = makeMask(w, h, [
      [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    ]);
    const clusters = findClusters(mask, w, h, 1, 1000);
    // Each corner is isolated — 4 clusters of 1 pixel each.
    expect(clusters).toHaveLength(4);
    for (const c of clusters) expect(c.pixels).toBe(1);
  });

  it('does not double-count: a visited pixel is not revisited', () => {
    // L-shape: 5 pixels. Should be one cluster of 5, not 2 of 3+ each.
    const mask = makeMask(20, 20, [[5, 5], [5, 6], [5, 7], [6, 7], [7, 7]]);
    const clusters = findClusters(mask, 20, 20, 1, 1000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].pixels).toBe(5);
  });
});
