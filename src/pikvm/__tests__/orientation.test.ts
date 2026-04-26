/**
 * Tests for orientation.ts — bounds detection, sanity check, and the
 * module-level cache used as a fallback when current-frame detection
 * yields suspect bounds.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  detectIpadBoundsFromBuffer,
  clearOrientationCache,
  getLastGoodBounds,
  slamOriginFromBounds,
  unlockStartFromBounds,
  LEGACY_PORTRAIT_SLAM_ORIGIN,
  LEGACY_PORTRAIT_UNLOCK_START,
} from '../orientation.js';

/** Build a synthetic HDMI frame: black background with a non-black
 *  rectangle representing the iPad content. */
async function makeFrame(
  hdmiW: number,
  hdmiH: number,
  ipadX: number,
  ipadY: number,
  ipadW: number,
  ipadH: number,
  ipadFill: [number, number, number] = [120, 120, 120],
): Promise<Buffer> {
  const buf = Buffer.alloc(hdmiW * hdmiH * 3);
  for (let y = 0; y < hdmiH; y++) {
    for (let x = 0; x < hdmiW; x++) {
      const inside =
        x >= ipadX && x < ipadX + ipadW && y >= ipadY && y < ipadY + ipadH;
      const i = (y * hdmiW + x) * 3;
      if (inside) {
        buf[i] = ipadFill[0];
        buf[i + 1] = ipadFill[1];
        buf[i + 2] = ipadFill[2];
      }
    }
  }
  return sharp(buf, { raw: { width: hdmiW, height: hdmiH, channels: 3 } }).png().toBuffer();
}

describe('detectIpadBoundsFromBuffer', () => {
  it('finds portrait iPad letterboxed in 1920×1080', async () => {
    clearOrientationCache();
    const frame = await makeFrame(1920, 1080, 616, 48, 688, 984);
    const bounds = await detectIpadBoundsFromBuffer(frame);
    expect(bounds.x).toBeGreaterThanOrEqual(615);
    expect(bounds.x).toBeLessThanOrEqual(617);
    expect(bounds.y).toBeGreaterThanOrEqual(47);
    expect(bounds.y).toBeLessThanOrEqual(49);
    expect(bounds.width).toBeGreaterThanOrEqual(686);
    expect(bounds.width).toBeLessThanOrEqual(690);
    expect(bounds.height).toBeGreaterThanOrEqual(982);
    expect(bounds.height).toBeLessThanOrEqual(986);
    expect(bounds.orientation).toBe('portrait');
  });

  it('finds landscape iPad', async () => {
    clearOrientationCache();
    // Landscape: wider than tall, fills more of HDMI.
    const frame = await makeFrame(1920, 1080, 240, 80, 1440, 920);
    const bounds = await detectIpadBoundsFromBuffer(frame);
    expect(bounds.orientation).toBe('landscape');
  });

  it('throws when entire frame is below brightness threshold', async () => {
    clearOrientationCache();
    const frame = await makeFrame(640, 480, 0, 0, 0, 0); // no iPad content at all
    await expect(detectIpadBoundsFromBuffer(frame)).rejects.toThrow(/black|disconnected/i);
  });

  it('falls back to cache when current bounds aspect-ratio is suspect', async () => {
    clearOrientationCache();
    // Prime cache with a sane portrait reading.
    const sane = await makeFrame(1920, 1080, 616, 48, 688, 984);
    const saneBounds = await detectIpadBoundsFromBuffer(sane);
    expect(saneBounds.orientation).toBe('portrait');
    expect(getLastGoodBounds()).not.toBeNull();

    // Build an aspect-suspect frame: tiny strip, ratio 0.1 — well outside
    // 0.55–0.85 iPad range. Should return cached bounds, not the new ones.
    const suspect = await makeFrame(1920, 1080, 800, 500, 400, 40);
    const result = await detectIpadBoundsFromBuffer(suspect);
    expect(result.width).toBe(saneBounds.width);
    expect(result.height).toBe(saneBounds.height);
  });

  it('updates cache when current bounds aspect-ratio is sane', async () => {
    clearOrientationCache();
    const first = await makeFrame(1920, 1080, 616, 48, 688, 984);
    await detectIpadBoundsFromBuffer(first);
    const cached1 = getLastGoodBounds();

    // Different but still iPad-shaped — landscape.
    const second = await makeFrame(1920, 1080, 240, 80, 1440, 920);
    const result = await detectIpadBoundsFromBuffer(second);
    const cached2 = getLastGoodBounds();
    expect(result.orientation).toBe('landscape');
    expect(cached2!.orientation).toBe('landscape');
    expect(cached2!.width).not.toBe(cached1!.width);
  });
});

describe('slam/unlock origin helpers', () => {
  it('slamOriginFromBounds insets 8 px from top-left', () => {
    const origin = slamOriginFromBounds({
      x: 100, y: 50, width: 600, height: 800,
      centerX: 400, centerY: 450, orientation: 'portrait',
      resolution: { width: 1920, height: 1080 },
    });
    expect(origin.x).toBe(108);
    expect(origin.y).toBe(58);
  });

  it('unlockStartFromBounds places start ~45 px above bottom centre', () => {
    const start = unlockStartFromBounds({
      x: 100, y: 50, width: 600, height: 800,
      centerX: 400, centerY: 450, orientation: 'portrait',
      resolution: { width: 1920, height: 1080 },
    });
    expect(start.x).toBe(400);
    expect(start.y).toBe(50 + 800 - 45); // bottom - 45
  });
});

describe('legacy fallback constants', () => {
  it('LEGACY_PORTRAIT_SLAM_ORIGIN is the reference iPad inset', () => {
    expect(LEGACY_PORTRAIT_SLAM_ORIGIN).toEqual({ x: 625, y: 65 });
  });

  it('LEGACY_PORTRAIT_UNLOCK_START is the reference iPad swipe origin', () => {
    expect(LEGACY_PORTRAIT_UNLOCK_START).toEqual({ x: 955, y: 1035 });
  });
});

describe('orientation cache lifecycle', () => {
  it('getLastGoodBounds is null on a fresh process (cache cleared)', () => {
    clearOrientationCache();
    expect(getLastGoodBounds()).toBeNull();
  });

  it('successful detection populates the cache', async () => {
    clearOrientationCache();
    const frame = await makeFrame(1920, 1080, 600, 0, 720, 1080);
    await detectIpadBoundsFromBuffer(frame);
    const cached = getLastGoodBounds();
    expect(cached).not.toBeNull();
    expect(cached!.width).toBe(720);
    expect(cached!.height).toBe(1080);
  });

  it('clearOrientationCache resets to null after a successful detection', async () => {
    const frame = await makeFrame(1920, 1080, 600, 0, 720, 1080);
    await detectIpadBoundsFromBuffer(frame);
    expect(getLastGoodBounds()).not.toBeNull();
    clearOrientationCache();
    expect(getLastGoodBounds()).toBeNull();
  });

  it('cache value comes from a successful detection (not legacy constants)', async () => {
    clearOrientationCache();
    await detectIpadBoundsFromBuffer(await makeFrame(1920, 1080, 600, 0, 720, 1080));
    const cached = getLastGoodBounds();
    // The legacy constants would say origin (625, 65); a real detection
    // would set origin near (600+8, 0+8) = (608, 8). Cache must reflect
    // the detected, not the legacy fallback.
    expect(cached).not.toBeNull();
    expect(cached!.x).toBe(600);
    expect(cached!.y).toBe(0);
  });
});
