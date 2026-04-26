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
import sharp from 'sharp';
import { verifyClickByDecodedFrames, verifyClickByDiff } from '../click-verify.js';
import type { DecodedScreenshot } from '../cursor-detect.js';

async function pngFromRgb(width: number, height: number, fillRgb: [number, number, number]): Promise<Buffer> {
  const total = width * height;
  const raw = Buffer.alloc(total * 3);
  for (let i = 0; i < total; i++) {
    raw[i * 3] = fillRgb[0];
    raw[i * 3 + 1] = fillRgb[1];
    raw[i * 3 + 2] = fillRgb[2];
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function pngWithRect(
  width: number,
  height: number,
  baseRgb: [number, number, number],
  rect: { x: number; y: number; w: number; h: number; rgb: [number, number, number] },
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    raw[i * 3] = baseRgb[0];
    raw[i * 3 + 1] = baseRgb[1];
    raw[i * 3 + 2] = baseRgb[2];
  }
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const idx = (y * width + x) * 3;
      raw[idx] = rect.rgb[0];
      raw[idx + 1] = rect.rgb[1];
      raw[idx + 2] = rect.rgb[2];
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

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

describe('verifyClickByDiff (async, end-to-end via PNG decode)', () => {
  it('decodes PNG buffers and reports zero change for identical frames', async () => {
    const pre = await pngFromRgb(50, 50, [128, 128, 128]);
    const post = await pngFromRgb(50, 50, [128, 128, 128]);
    const result = await verifyClickByDiff(pre, post);
    expect(result.changedPixels).toBe(0);
    expect(result.screenChanged).toBe(false);
  });

  it('decodes PNG buffers and detects screen change when post differs significantly', async () => {
    const pre = await pngFromRgb(50, 50, [0, 0, 0]);
    const post = await pngWithRect(50, 50, [0, 0, 0], {
      x: 5,
      y: 5,
      w: 20,
      h: 20,
      rgb: [255, 255, 255],
    });
    const result = await verifyClickByDiff(pre, post);
    expect(result.changedPixels).toBeGreaterThanOrEqual(400);
    expect(result.screenChanged).toBe(true);
  });

  it('rejects mismatched PNG dimensions with a clear error', async () => {
    const pre = await pngFromRgb(50, 50, [0, 0, 0]);
    const post = await pngFromRgb(60, 50, [0, 0, 0]);
    await expect(verifyClickByDiff(pre, post)).rejects.toThrow(/size|dimension|mismatch/i);
  });

  it('passes options through to the decoded-frame variant (region scoping)', async () => {
    const pre = await pngFromRgb(50, 50, [0, 0, 0]);
    const post = await pngWithRect(50, 50, [0, 0, 0], {
      x: 0,
      y: 0,
      w: 20,
      h: 20,
      rgb: [255, 255, 255],
    });
    // Region centred far from the changed area — should not see any change.
    const result = await verifyClickByDiff(pre, post, {
      region: { x: 45, y: 45, halfWidth: 4, halfHeight: 4 },
    });
    expect(result.changedPixels).toBe(0);
    expect(result.screenChanged).toBe(false);
  });
});
