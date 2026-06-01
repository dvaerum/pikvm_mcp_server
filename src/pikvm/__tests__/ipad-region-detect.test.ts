/**
 * Pin the contract for `detectIpadRegion` + `buildTransform`:
 *
 *  - The transform is the affine map that bench-collect-synthetic uses
 *    to project iPad-logical click coordinates into PiKVM screenshot
 *    pixels. If the math drifts, every label position drifts with it.
 *  - The detector's letterbox-bar scan is the only thing standing
 *    between us and a tautological "iPad fills the frame" assumption.
 *    Regression-test the synthetic case + the all-black fallback.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  detectIpadRegion,
  buildTransform,
  NATIVE_MARGIN,
  type IpadRegion,
} from '../ipad-region-detect.js';

async function rawToJpeg(
  data: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Build a 1920×1080 frame with bright content in [x0,x1)×[y0,y1) and black
 *  letterbox bars everywhere else. */
async function letterboxJpeg(
  frameW: number,
  frameH: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  bright = 200,
): Promise<Buffer> {
  const data = Buffer.alloc(frameW * frameH * 3, 0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * frameW + x) * 3;
      data[i] = bright;
      data[i + 1] = bright;
      data[i + 2] = bright;
    }
  }
  return rawToJpeg(data, frameW, frameH);
}

describe('buildTransform', () => {
  it('identity-ish: full-frame region with matching logical size maps corners 1:1', () => {
    const region: IpadRegion = {
      x: 0,
      y: 0,
      w: 1920,
      h: 1080,
      frameW: 1920,
      frameH: 1080,
    };
    const t = buildTransform(region, 1920, 1080);

    const origin = t.toScreenshotPx(0, 0);
    expect(origin.x).toBe(0);
    expect(origin.y).toBe(0);

    const corner = t.toScreenshotPx(1920, 1080);
    expect(corner.x).toBe(1920);
    expect(corner.y).toBe(1080);

    const mid = t.toScreenshotPx(960, 540);
    expect(mid.x).toBe(960);
    expect(mid.y).toBe(540);
  });

  it('letterboxed region scales logical → screenshot by region/logical ratio', () => {
    const region: IpadRegion = {
      x: 610,
      y: 50,
      w: 692,
      h: 980,
      frameW: 1920,
      frameH: 1080,
    };
    const logicalW = 820;
    const logicalH = 1180;
    const t = buildTransform(region, logicalW, logicalH);

    // (0,0) logical lands on the region origin.
    const origin = t.toScreenshotPx(0, 0);
    expect(origin.x).toBe(region.x);
    expect(origin.y).toBe(region.y);

    // A point one logical unit in scales by region.w/logicalW.
    const scaleX = region.w / logicalW;
    const scaleY = region.h / logicalH;
    const oneOne = t.toScreenshotPx(1, 1);
    expect(oneOne.x).toBeCloseTo(region.x + scaleX, 6);
    expect(oneOne.y).toBeCloseTo(region.y + scaleY, 6);

    // The logical center maps to the region center.
    const center = t.toScreenshotPx(logicalW / 2, logicalH / 2);
    expect(center.x).toBeCloseTo(region.x + region.w / 2, 6);
    expect(center.y).toBeCloseTo(region.y + region.h / 2, 6);

    // The far logical corner maps to the region far corner.
    const far = t.toScreenshotPx(logicalW, logicalH);
    expect(far.x).toBeCloseTo(region.x + region.w, 6);
    expect(far.y).toBeCloseTo(region.y + region.h, 6);
  });

  it('throws on logicalW <= 0', () => {
    const region: IpadRegion = {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      frameW: 100,
      frameH: 100,
    };
    expect(() => buildTransform(region, 0, 100)).toThrow(/logical/i);
    expect(() => buildTransform(region, -1, 100)).toThrow(/logical/i);
  });

  it('throws on logicalH <= 0', () => {
    const region: IpadRegion = {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      frameW: 100,
      frameH: 100,
    };
    expect(() => buildTransform(region, 100, 0)).toThrow(/logical/i);
    expect(() => buildTransform(region, 100, -1)).toThrow(/logical/i);
  });
});

describe('detectIpadRegion', () => {
  it('locates content rectangle inside black letterbox bars', async () => {
    // Bright content in [500,1400) × [100,980); black bars elsewhere.
    const jpeg = await letterboxJpeg(1920, 1080, 500, 1400, 100, 980);
    const region = await detectIpadRegion(jpeg);

    expect(region.frameW).toBe(1920);
    expect(region.frameH).toBe(1080);

    // Detector inflates by NATIVE_MARGIN on each side, then rounds via a
    // 240-wide downscaled scan, so allow a few px of slop. Use
    // toBeCloseTo(_, -1) → within ±5 of the rounded value.
    expect(region.x).toBeCloseTo(500 - NATIVE_MARGIN, -1);
    expect(region.x + region.w).toBeCloseTo(1400 + NATIVE_MARGIN, -1);
    expect(region.y).toBeCloseTo(100 - NATIVE_MARGIN, -1);
    expect(region.y + region.h).toBeCloseTo(980 + NATIVE_MARGIN, -1);
  });

  it('falls back to full frame on a uniformly black image', async () => {
    const data = Buffer.alloc(1920 * 1080 * 3, 0);
    const jpeg = await rawToJpeg(data, 1920, 1080);
    const region = await detectIpadRegion(jpeg);

    expect(region).toEqual({
      x: 0,
      y: 0,
      w: 1920,
      h: 1080,
      frameW: 1920,
      frameH: 1080,
    });
  });
});

describe('NATIVE_MARGIN', () => {
  it('is 6 px — regression guard against silent retunes', () => {
    // Callers that need the *tight* content rect subtract this on each
    // side; changing it without updating those callers will silently
    // shift every label coordinate.
    expect(NATIVE_MARGIN).toBe(6);
  });
});
