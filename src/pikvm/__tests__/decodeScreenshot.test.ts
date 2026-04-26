/**
 * Direct unit tests for decodeScreenshot / decodeToRgb. Used everywhere;
 * if either silently mis-decodes (wrong dimensions, missing alpha
 * removal, RGB channel order), every cursor-detection feature breaks
 * downstream with mysterious symptoms instead of a clear failure here.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { decodeScreenshot, decodeToRgb } from '../cursor-detect.js';

async function pngFromRgb(
  width: number,
  height: number,
  rgb: number[],
): Promise<Buffer> {
  return sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe('decodeToRgb', () => {
  it('decodes a PNG to raw RGB at the original dimensions', async () => {
    // 2×2 frame with distinct pixels.
    const png = await pngFromRgb(2, 2, [
      255, 0, 0,    // (0,0) red
      0, 255, 0,    // (1,0) green
      0, 0, 255,    // (0,1) blue
      255, 255, 255, // (1,1) white
    ]);
    const result = await decodeToRgb(png);
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.data).toHaveLength(2 * 2 * 3);
  });

  it('preserves RGB channel order (sharp returns RGB, not BGR)', async () => {
    const png = await pngFromRgb(1, 1, [123, 45, 67]);
    const result = await decodeToRgb(png);
    expect(result.data[0]).toBe(123);
    expect(result.data[1]).toBe(45);
    expect(result.data[2]).toBe(67);
  });

  it('strips alpha channel (returns 3 bytes per pixel even from RGBA input)', async () => {
    // Build a PNG with alpha channel.
    const rgba = sharp(Buffer.from([100, 150, 200, 128]), {
      raw: { width: 1, height: 1, channels: 4 },
    });
    const png = await rgba.png().toBuffer();
    const result = await decodeToRgb(png);
    // 1 pixel × 3 channels = 3 bytes (not 4).
    expect(result.data).toHaveLength(3);
    expect(result.data[0]).toBe(100);
    expect(result.data[1]).toBe(150);
    expect(result.data[2]).toBe(200);
  });

  it('rejects invalid input with a sharp error', async () => {
    await expect(decodeToRgb(Buffer.from('not-an-image'))).rejects.toThrow();
  });
});

describe('decodeScreenshot', () => {
  it('returns the original buffer alongside decoded pixels (no re-encode round-trip)', async () => {
    const png = await pngFromRgb(2, 2, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const result = await decodeScreenshot(png);
    // The buffer field must be the same Buffer reference passed in —
    // callers (e.g. saveCursorTemplate) re-use this for further sharp ops.
    expect(result.buffer).toBe(png);
  });

  it('exposes width / height / rgb consistent with decodeToRgb', async () => {
    const png = await pngFromRgb(4, 3, new Array(4 * 3 * 3).fill(128));
    const result = await decodeScreenshot(png);
    expect(result.width).toBe(4);
    expect(result.height).toBe(3);
    expect(result.rgb).toHaveLength(4 * 3 * 3);
  });

  it('decodes JPEG (the actual streamer format) not just PNG', async () => {
    // PiKVM's /streamer/snapshot returns JPEG, so this code path matters.
    const jpeg = await sharp(Buffer.from(new Array(10 * 10 * 3).fill(64)), {
      raw: { width: 10, height: 10, channels: 3 },
    })
      .jpeg()
      .toBuffer();
    const result = await decodeScreenshot(jpeg);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    expect(result.rgb).toHaveLength(10 * 10 * 3);
  });
});
