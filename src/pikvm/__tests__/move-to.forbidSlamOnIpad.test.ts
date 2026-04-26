/**
 * Phase 32: explicit-strategy slam guard for iPad-portrait targets.
 *
 * Background: `forbidSlamFallback` (Phase 11+) only protects the
 * auto-fallback path inside detect-then-move. When a caller explicitly
 * passes `strategy='slam-then-move'` on an iPad-portrait target, the slam
 * still runs and triggers iPadOS hot-corner re-lock. This was live-verified
 * 2026-04-26 — a single explicit slam-then-move locked the iPad mid-session.
 *
 * `forbidSlamOnIpad` (default true) detects iPad bounds before the slam
 * and refuses with a clear error. Caller must opt out (forbidSlamOnIpad=false)
 * to allow the dangerous behaviour.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { moveToPixel } from '../move-to.js';
import { clearOrientationCache } from '../orientation.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

/** A 1920×1080 frame that LOOKS like an iPad in portrait letterbox:
 *  black bars on left/right, bright content in the middle. The bounds
 *  detector will read this as portrait orientation. */
async function makeIpadPortraitFrame(): Promise<Buffer> {
  const w = 1920;
  const h = 1080;
  const data = Buffer.alloc(w * h * 3, 0);
  // iPad letterbox: black 0..624, content 625..1295, black 1296..1919.
  const ipadX0 = 625;
  const ipadX1 = 1295;
  for (let y = 0; y < h; y++) {
    for (let x = ipadX0; x <= ipadX1; x++) {
      const i = (y * w + x) * 3;
      // Bright grey content well above the brightness floor.
      data[i] = 200;
      data[i + 1] = 200;
      data[i + 2] = 200;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

class IpadPortraitClient {
  resolution: ScreenResolution = { width: 1920, height: 1080 };
  slamCalls = 0;

  async getResolution(): Promise<ScreenResolution> {
    return this.resolution;
  }
  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    const buf = await makeIpadPortraitFrame();
    return { buffer: buf, screenshotWidth: 1920, screenshotHeight: 1080 };
  }
  async mouseMoveRelative(dx: number, _dy: number): Promise<void> {
    // Heuristic: a slam emits many large negative deltas in a row.
    if (dx <= -100) this.slamCalls++;
  }
}

describe('moveToPixel forbidSlamOnIpad', () => {
  it('refuses explicit slam-then-move when iPad-portrait letterbox is detected', async () => {
    clearOrientationCache();
    const client = new IpadPortraitClient();
    await expect(
      moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
        strategy: 'slam-then-move',
        warmupMickeys: 0,
        calibrationProbeMickeys: 0,
      }),
    ).rejects.toThrow(/iPad-portrait letterbox detected|hot-corner gesture/i);
    expect(client.slamCalls).toBe(0);
  }, 30000);

  it('allows slam-then-move on iPad when forbidSlamOnIpad=false (explicit opt-out)', async () => {
    clearOrientationCache();
    const client = new IpadPortraitClient();
    // No throw expected — caller has explicitly opted out of the safety guard.
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
      strategy: 'slam-then-move',
      forbidSlamOnIpad: false,
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    expect(result.strategy).toBe('slam-then-move');
    expect(client.slamCalls).toBeGreaterThan(0);
  }, 30000);
});
