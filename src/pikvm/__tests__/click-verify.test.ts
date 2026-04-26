/**
 * Tests for verifyClickByDiff — Phase 23 click verification helper.
 *
 * Pins the contract that pikvm_mouse_click_at uses to give callers a
 * machine-verifiable signal "did the click land on something". The
 * troubleshooting doc identifies this as the long-term fix path: the
 * detection layer cannot reach single-digit residuals on a busy iPad
 * home screen, so reliability has to come from a higher abstraction
 * layer that detects whether a click had its intended effect.
 *
 * Red-then-green: this file is written before click-verify.ts exists.
 *
 * Decoded-frame variant takes already-decoded RGB buffers so tests can
 * synthesize frames pixel-by-pixel without going through sharp/JPEG.
 */

import { describe, expect, it } from 'vitest';
import { verifyClickByDecodedFrames } from '../click-verify.js';
import type { DecodedScreenshot } from '../cursor-detect.js';

function makeFrame(width: number, height: number, fillRgb: [number, number, number]): DecodedScreenshot {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = fillRgb[0];
    rgb[i * 3 + 1] = fillRgb[1];
    rgb[i * 3 + 2] = fillRgb[2];
  }
  return { buffer: Buffer.alloc(0), rgb, width, height };
}

function paintRect(
  frame: DecodedScreenshot,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const idx = (y * frame.width + x) * 3;
      frame.rgb[idx] = rgb[0];
      frame.rgb[idx + 1] = rgb[1];
      frame.rgb[idx + 2] = rgb[2];
    }
  }
}

describe('verifyClickByDecodedFrames', () => {
  it('reports zero change when pre and post are identical', () => {
    const pre = makeFrame(100, 100, [128, 128, 128]);
    const post = makeFrame(100, 100, [128, 128, 128]);
    const result = verifyClickByDecodedFrames(pre, post);
    expect(result.changedPixels).toBe(0);
    expect(result.changedFraction).toBe(0);
    expect(result.screenChanged).toBe(false);
  });

  it('reports screen changed when a large region differs (>0.5% default threshold)', () => {
    const pre = makeFrame(100, 100, [0, 0, 0]);
    const post = makeFrame(100, 100, [0, 0, 0]);
    // 20×20 = 400 pixels = 4% of the 100×100 frame. Well above 0.5%.
    paintRect(post, 10, 10, 20, 20, [255, 255, 255]);
    const result = verifyClickByDecodedFrames(pre, post);
    expect(result.changedPixels).toBeGreaterThanOrEqual(400);
    expect(result.changedFraction).toBeGreaterThan(0.005);
    expect(result.screenChanged).toBe(true);
  });

  it('reports screen NOT changed when only a tiny patch differs (< default threshold)', () => {
    const pre = makeFrame(100, 100, [0, 0, 0]);
    const post = makeFrame(100, 100, [0, 0, 0]);
    // 5×5 = 25 pixels = 0.25% of the frame. Below 0.5% default.
    paintRect(post, 10, 10, 5, 5, [255, 255, 255]);
    const result = verifyClickByDecodedFrames(pre, post);
    expect(result.screenChanged).toBe(false);
  });

  it('honours a custom minChangedFraction', () => {
    const pre = makeFrame(100, 100, [0, 0, 0]);
    const post = makeFrame(100, 100, [0, 0, 0]);
    paintRect(post, 10, 10, 5, 5, [255, 255, 255]); // 0.25% changed
    const result = verifyClickByDecodedFrames(pre, post, { minChangedFraction: 0.001 });
    expect(result.screenChanged).toBe(true);
  });

  it('honours a custom pixelThreshold (sum of |R|+|G|+|B| deltas)', () => {
    const pre = makeFrame(100, 100, [100, 100, 100]);
    const post = makeFrame(100, 100, [100, 100, 100]);
    // Tiny per-channel delta: each pixel sums to 9 (3+3+3) — below default 60.
    paintRect(post, 0, 0, 100, 100, [103, 103, 103]);
    const lowThreshold = verifyClickByDecodedFrames(pre, post, { pixelThreshold: 5 });
    const highThreshold = verifyClickByDecodedFrames(pre, post, { pixelThreshold: 30 });
    expect(lowThreshold.changedPixels).toBeGreaterThan(0);
    expect(highThreshold.changedPixels).toBe(0);
  });

  it('region option scopes the diff to the area around the click target', () => {
    const pre = makeFrame(100, 100, [0, 0, 0]);
    const post = makeFrame(100, 100, [0, 0, 0]);
    // Big change far from the click target (90, 90).
    paintRect(post, 0, 0, 30, 30, [255, 255, 255]);
    // No change near the click target (90, 90).
    const fullDiff = verifyClickByDecodedFrames(pre, post);
    const regionDiff = verifyClickByDecodedFrames(pre, post, {
      region: { x: 90, y: 90, halfWidth: 5, halfHeight: 5 },
    });
    expect(fullDiff.changedFraction).toBeGreaterThan(0.05);
    expect(regionDiff.changedPixels).toBe(0);
    expect(regionDiff.screenChanged).toBe(false);
  });

  it('region option clamps to frame bounds when click target is near the edge', () => {
    const pre = makeFrame(100, 100, [0, 0, 0]);
    const post = makeFrame(100, 100, [0, 0, 0]);
    paintRect(post, 95, 95, 5, 5, [255, 255, 255]);
    const result = verifyClickByDecodedFrames(pre, post, {
      region: { x: 99, y: 99, halfWidth: 50, halfHeight: 50 },
    });
    // Region extends past frame bounds — should clamp, not crash, and
    // the totalPixels should reflect the clamped area, not the unclamped 101×101.
    expect(result.totalPixels).toBeLessThanOrEqual(100 * 100);
    expect(result.changedPixels).toBeGreaterThan(0);
  });

  it('throws when pre and post screenshots have mismatched dimensions', () => {
    const pre = makeFrame(100, 100, [0, 0, 0]);
    const post = makeFrame(200, 100, [0, 0, 0]);
    expect(() => verifyClickByDecodedFrames(pre, post)).toThrow(/size|dimension|mismatch/i);
  });

  it('message text is informative for screen-changed=true', () => {
    const pre = makeFrame(100, 100, [0, 0, 0]);
    const post = makeFrame(100, 100, [0, 0, 0]);
    paintRect(post, 0, 0, 50, 50, [255, 255, 255]); // 25% changed
    const result = verifyClickByDecodedFrames(pre, post);
    expect(result.screenChanged).toBe(true);
    expect(result.message).toMatch(/changed|landed|triggered/i);
  });

  it('message text flags suspected miss for screen-changed=false', () => {
    const pre = makeFrame(100, 100, [0, 0, 0]);
    const post = makeFrame(100, 100, [0, 0, 0]);
    const result = verifyClickByDecodedFrames(pre, post);
    expect(result.screenChanged).toBe(false);
    expect(result.message).toMatch(/miss|no.*change|may have missed/i);
  });
});
