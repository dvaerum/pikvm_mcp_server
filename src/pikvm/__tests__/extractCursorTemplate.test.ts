/**
 * Direct unit tests for extractCursorTemplateDecoded. The function
 * crops a fixed-size square region centred on a known position and
 * clamps the crop window to stay within the screenshot's bounds.
 * Used for capturing cursor templates after a successful motion-diff,
 * so the bounds-clamping behaviour is load-bearing for templates
 * captured near screen edges.
 */

import { describe, expect, it } from 'vitest';
import { extractCursorTemplateDecoded } from '../cursor-detect.js';
import type { DecodedScreenshot } from '../cursor-detect.js';

// Build a screenshot whose pixel at (x, y) has R=x, G=y, B=0.
// This makes it easy to verify which screenshot region was cropped.
function gradientScreenshot(width: number, height: number): DecodedScreenshot {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      buf[o] = x & 0xff;
      buf[o + 1] = y & 0xff;
      buf[o + 2] = 0;
    }
  }
  return { buffer: Buffer.alloc(0), rgb: buf, width, height };
}

describe('extractCursorTemplateDecoded', () => {
  it('returns a square template of the requested size', () => {
    const shot = gradientScreenshot(200, 200);
    const t = extractCursorTemplateDecoded(shot, { x: 100, y: 100 }, 24);
    expect(t.width).toBe(24);
    expect(t.height).toBe(24);
    expect(t.rgb).toHaveLength(24 * 24 * 3);
  });

  it('crops centred on the requested position when far from edges', () => {
    const shot = gradientScreenshot(200, 200);
    // Centre at (100, 100) with size 24 → half=12 → top-left at (88, 88).
    // First pixel of template should match shot[88, 88] = R=88, G=88, B=0.
    const t = extractCursorTemplateDecoded(shot, { x: 100, y: 100 }, 24);
    expect(t.rgb[0]).toBe(88);
    expect(t.rgb[1]).toBe(88);
    expect(t.rgb[2]).toBe(0);
  });

  it('clamps the crop window to the left edge when centre is too far left', () => {
    const shot = gradientScreenshot(200, 200);
    // Centre at (5, 100) with size 24 — would want top-left (-7, 88).
    // Clamped to (0, 88). First pixel matches shot[0, 88] = R=0, G=88.
    const t = extractCursorTemplateDecoded(shot, { x: 5, y: 100 }, 24);
    expect(t.rgb[0]).toBe(0);
    expect(t.rgb[1]).toBe(88);
  });

  it('clamps the crop window to the right edge when centre is too far right', () => {
    const shot = gradientScreenshot(200, 200);
    // Centre at (195, 100) with size 24 — wants top-left (183, 88).
    // Right edge: 200-24 = 176. Clamped to (176, 88).
    // First pixel matches shot[176, 88] = R=176, G=88.
    const t = extractCursorTemplateDecoded(shot, { x: 195, y: 100 }, 24);
    expect(t.rgb[0]).toBe(176);
    expect(t.rgb[1]).toBe(88);
  });

  it('clamps the crop window to the top edge', () => {
    const shot = gradientScreenshot(200, 200);
    // Centre at (100, 5) — wants top-left (88, -7), clamped to (88, 0).
    const t = extractCursorTemplateDecoded(shot, { x: 100, y: 5 }, 24);
    expect(t.rgb[0]).toBe(88);
    expect(t.rgb[1]).toBe(0);
  });

  it('clamps the crop window to the bottom edge', () => {
    const shot = gradientScreenshot(200, 200);
    // Centre at (100, 195) — wants top-left (88, 183), clamped to (88, 176).
    const t = extractCursorTemplateDecoded(shot, { x: 100, y: 195 }, 24);
    expect(t.rgb[0]).toBe(88);
    expect(t.rgb[1]).toBe(176);
  });

  it('respects a custom size argument', () => {
    const shot = gradientScreenshot(200, 200);
    const t = extractCursorTemplateDecoded(shot, { x: 100, y: 100 }, 32);
    expect(t.width).toBe(32);
    expect(t.height).toBe(32);
    expect(t.rgb).toHaveLength(32 * 32 * 3);
  });

  it('preserves row order — last row of template matches expected screenshot row', () => {
    const shot = gradientScreenshot(200, 200);
    // Size 24 centred at (100, 100). Top-left at (88, 88).
    // Last row of template = screenshot row 88+23 = 111. First pixel of
    // last template row = shot[88, 111] = R=88, G=111.
    const t = extractCursorTemplateDecoded(shot, { x: 100, y: 100 }, 24);
    const lastRowStart = 23 * 24 * 3;
    expect(t.rgb[lastRowStart]).toBe(88);
    expect(t.rgb[lastRowStart + 1]).toBe(111);
  });
});
