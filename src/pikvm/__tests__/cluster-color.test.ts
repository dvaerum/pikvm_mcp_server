/**
 * Cluster-level color tracking — pins the contract that findClusters
 * accumulates mean R/G/B over a cluster's pixels when given a source
 * frame, used by detectMotion's requireAchromatic filter to reject
 * colored-widget noise without harming anti-aliased cursor edges.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { decodeScreenshot, findClusters, diffPixels } from '../cursor-detect.js';

async function frame(
  w: number,
  h: number,
  fill: (i: number) => [number, number, number],
): Promise<Buffer> {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = fill(i);
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe('findClusters — cluster-level color', () => {
  it('returns no color info when source frame is omitted (backward compat)', async () => {
    // 30×30 frame with a single 7×7 cluster at the centre.
    const w = 30, h = 30;
    const f = await frame(w, h, (i) => {
      const x = i % w, y = Math.floor(i / w);
      const inCluster = Math.abs(x - 15) <= 3 && Math.abs(y - 15) <= 3;
      return inCluster ? [255, 255, 255] : [0, 0, 0];
    });
    // Build a mask over the white cluster.
    const dec = await decodeScreenshot(f);
    const mask = new Array<boolean>(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = dec.rgb[i * 3];
      mask[i] = r > 128;
    }
    // Backward-compat call: no source frame.
    const clusters = findClusters(mask, w, h, 4, 1000);
    expect(clusters.length).toBe(1);
    expect(clusters[0].meanR).toBeUndefined();
    expect(clusters[0].meanG).toBeUndefined();
    expect(clusters[0].meanB).toBeUndefined();
  });

  it('populates mean color when source frame is passed', async () => {
    const w = 30, h = 30;
    // Build a uniform RED region as the cluster body.
    const f = await frame(w, h, (i) => {
      const x = i % w, y = Math.floor(i / w);
      const inCluster = Math.abs(x - 15) <= 3 && Math.abs(y - 15) <= 3;
      return inCluster ? [220, 60, 60] : [0, 0, 0];
    });
    const dec = await decodeScreenshot(f);
    const mask = new Array<boolean>(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = dec.rgb[i * 3] > 128;

    // New signature: pass source frame to accumulate color.
    const clusters = findClusters(mask, w, h, 4, 1000, dec.rgb);
    expect(clusters.length).toBe(1);
    expect(clusters[0].meanR).toBeGreaterThan(200);
    expect(clusters[0].meanG).toBeLessThan(80);
    expect(clusters[0].meanB).toBeLessThan(80);
  });

  it('REGRESSION: gray cursor cluster has R ≈ G ≈ B', async () => {
    const w = 30, h = 30;
    const f = await frame(w, h, (i) => {
      const x = i % w, y = Math.floor(i / w);
      const inCluster = Math.abs(x - 15) <= 3 && Math.abs(y - 15) <= 3;
      return inCluster ? [220, 220, 220] : [0, 0, 0];
    });
    const dec = await decodeScreenshot(f);
    const mask = new Array<boolean>(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = dec.rgb[i * 3] > 128;

    const clusters = findClusters(mask, w, h, 4, 1000, dec.rgb);
    expect(clusters.length).toBe(1);
    const c = clusters[0];
    const sat = Math.max(c.meanR!, c.meanG!, c.meanB!) -
      Math.min(c.meanR!, c.meanG!, c.meanB!);
    expect(sat).toBeLessThan(20); // gray
  });

  it('Phase 8: brightness floor passes pixels bright in EITHER frame (pre+post both form)', async () => {
    // Cursor (240,240,240) at (10,10) in frame A; same cursor at (40,40)
    // in frame B. Wallpaper is dim (40,60,80) — at the OLD cursor
    // position (10,10), B has wallpaper which fails brightnessFloor=170.
    // Without the OR-across-frames check, only the post cluster (40,40)
    // would form. The fix is to pass a pixel if EITHER frame has bright
    // RGB at that location, so the pre cluster forms too.
    const w = 60, h = 60;
    const wallpaper: [number, number, number] = [40, 60, 80];
    const cursor: [number, number, number] = [240, 240, 240];
    const inSquare = (x: number, y: number, cx: number, cy: number, half: number) =>
      Math.abs(x - cx) <= half && Math.abs(y - cy) <= half;

    const aBuf = await frame(w, h, (i) => {
      const x = i % w, y = Math.floor(i / w);
      return inSquare(x, y, 10, 10, 3) ? cursor : wallpaper;
    });
    const bBuf = await frame(w, h, (i) => {
      const x = i % w, y = Math.floor(i / w);
      return inSquare(x, y, 40, 40, 3) ? cursor : wallpaper;
    });

    const a = await decodeScreenshot(aBuf);
    const b = await decodeScreenshot(bBuf);
    const mask = diffPixels(a.rgb, b.rgb, w, h, 30, 170, 0);
    const clusters = findClusters(mask, w, h, 4, 1000);
    // We want BOTH pre (~10,10) and post (~40,40) clusters.
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    const positions = clusters.map((c) => `${c.centroidX},${c.centroidY}`).sort();
    // Loose check that one cluster centroid is near (10,10) and the other near (40,40).
    const hasNear = (cx: number, cy: number) =>
      clusters.some((c) =>
        Math.abs(c.centroidX - cx) <= 4 && Math.abs(c.centroidY - cy) <= 4,
      );
    expect(hasNear(10, 10)).toBe(true);
    expect(hasNear(40, 40)).toBe(true);
  });

  it('mean color reflects actual pixel values (sanity)', async () => {
    const w = 20, h = 20;
    // 4×4 BLUE cluster.
    const f = await frame(w, h, (i) => {
      const x = i % w, y = Math.floor(i / w);
      const inCluster = Math.abs(x - 10) <= 1 && Math.abs(y - 10) <= 1;
      return inCluster ? [50, 80, 200] : [0, 0, 0];
    });
    const dec = await decodeScreenshot(f);
    const mask = new Array<boolean>(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = dec.rgb[i * 3 + 2] > 100;
    const clusters = findClusters(mask, w, h, 4, 1000, dec.rgb);
    expect(clusters.length).toBe(1);
    expect(clusters[0].meanR! < clusters[0].meanB!).toBe(true);
    expect(clusters[0].meanG! < clusters[0].meanB!).toBe(true);
  });
});
