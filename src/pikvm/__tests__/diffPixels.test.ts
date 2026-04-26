/**
 * Direct unit tests for diffPixels. Previously only one call site in
 * cluster-color.test.ts; the threshold / brightness-floor / saturation-
 * filter logic was tested transitively via diffScreenshotsDecoded but
 * not at the pixel-level mechanics directly.
 */

import { describe, expect, it } from 'vitest';
import { diffPixels } from '../cursor-detect.js';

// Build width×height RGB buffers from an array of [r,g,b] tuples per pixel.
function rgb(width: number, height: number, pixels: Array<[number, number, number]>): Buffer {
  if (pixels.length !== width * height) {
    throw new Error(`expected ${width * height} pixels, got ${pixels.length}`);
  }
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    buf[i * 3] = pixels[i][0];
    buf[i * 3 + 1] = pixels[i][1];
    buf[i * 3 + 2] = pixels[i][2];
  }
  return buf;
}

// 2×1 frames: pixel 0 and pixel 1.
function pair(
  pre: [number, number, number],
  post: [number, number, number],
): { a: Buffer; b: Buffer; w: number; h: number } {
  return { a: rgb(2, 1, [pre, [0, 0, 0]]), b: rgb(2, 1, [post, [0, 0, 0]]), w: 2, h: 1 };
}

describe('diffPixels', () => {
  describe('threshold (channel-sum diff)', () => {
    it('marks the pixel as changed when dr+dg+db >= threshold', () => {
      // Pre (100,100,100) → post (130,130,130). diff = 90 ≥ 30.
      const { a, b, w, h } = pair([100, 100, 100], [130, 130, 130]);
      const mask = diffPixels(a, b, w, h, 30, 0, 0);
      expect(mask[0]).toBe(true);
      expect(mask[1]).toBe(false);
    });

    it('does not mark when channel-sum diff is below threshold', () => {
      // Pre (100,100,100) → post (109,100,100). diff = 9 < 30.
      const { a, b, w, h } = pair([100, 100, 100], [109, 100, 100]);
      const mask = diffPixels(a, b, w, h, 30, 0, 0);
      expect(mask[0]).toBe(false);
    });
  });

  describe('brightness floor', () => {
    it('passes when brightnessFloor is 0 regardless of frame brightness', () => {
      const { a, b, w, h } = pair([10, 10, 10], [50, 50, 50]);
      const mask = diffPixels(a, b, w, h, 30, 0, 0);
      expect(mask[0]).toBe(true);
    });

    it('Phase 8: passes when EITHER frame has bright RGB', () => {
      // a=bright (240,240,240), b=dim wallpaper (60,60,60). brightnessFloor=170.
      // Pre Phase 8 this would fail (b not bright). Phase 8 OR-across-frames
      // says EITHER frame bright → pass. a is bright → pass.
      const { a, b, w, h } = pair([240, 240, 240], [60, 60, 60]);
      const mask = diffPixels(a, b, w, h, 30, 170, 0);
      expect(mask[0]).toBe(true);
    });

    it('rejects when both frames are below brightness floor', () => {
      // Both dim. Difference exists but neither passes brightness floor.
      const { a, b, w, h } = pair([60, 60, 60], [100, 100, 100]);
      const mask = diffPixels(a, b, w, h, 30, 170, 0);
      expect(mask[0]).toBe(false);
    });

    it('rejects when only ONE channel of a frame is bright (need all three above floor)', () => {
      // a has R bright but G/B dim. Brightness floor 170 requires ALL channels bright.
      const { a, b, w, h } = pair([240, 50, 50], [60, 60, 60]);
      const mask = diffPixels(a, b, w, h, 30, 170, 0);
      expect(mask[0]).toBe(false);
    });
  });

  describe('maxChannelDelta saturation filter', () => {
    it('passes when maxChannelDelta is 0 (filter off)', () => {
      // Highly chromatic post (red). Without saturation filter, passes.
      const { a, b, w, h } = pair([100, 100, 100], [200, 50, 50]);
      const mask = diffPixels(a, b, w, h, 30, 0, 0);
      expect(mask[0]).toBe(true);
    });

    it('rejects when post-pixel saturation exceeds maxChannelDelta', () => {
      // Post pixel (200, 50, 50) — saturation = max-min = 200-50 = 150.
      // maxChannelDelta=20 rejects.
      const { a, b, w, h } = pair([100, 100, 100], [200, 50, 50]);
      const mask = diffPixels(a, b, w, h, 30, 0, 20);
      expect(mask[0]).toBe(false);
    });

    it('passes when post-pixel saturation is within maxChannelDelta (achromatic)', () => {
      // Post (220, 220, 220) — saturation = 0. Achromatic.
      const { a, b, w, h } = pair([100, 100, 100], [220, 220, 220]);
      const mask = diffPixels(a, b, w, h, 30, 0, 20);
      expect(mask[0]).toBe(true);
    });
  });

  describe('output shape', () => {
    it('returns a mask of length width*height', () => {
      const buf = rgb(4, 3, [
        [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
        [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
        [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
      ]);
      const mask = diffPixels(buf, buf, 4, 3, 30, 0, 0);
      expect(mask).toHaveLength(12);
      expect(mask.every((v) => v === false)).toBe(true);
    });
  });
});
