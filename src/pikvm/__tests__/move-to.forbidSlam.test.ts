/**
 * On iPad (mouse.absolute=false), slam-to-top-left triggers the hot-corner
 * gesture and re-locks the screen. Move-to's silent fallback to slam
 * after detect-then-move fails is therefore catastrophic on iPad — every
 * failed locate destroys the test environment.
 *
 * This test pins the new `forbidSlamFallback` MoveToOptions: when set,
 * a failed detect-then-move throws with a useful message instead of
 * slamming. Caller (typically the MCP tool layer) sets it based on
 * the target's mouse.absolute flag.
 *
 * Mocked PiKVMClient because we only care about which path the option
 * picks, not real HID I/O.
 */

import { describe, expect, it } from 'vitest';
import { moveToPixel } from '../move-to.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

class FakeClient {
  screenshotCount = 0;
  mouseMoveCount = 0;
  slamWasCalled = false;
  resolution: ScreenResolution = { width: 1920, height: 1080 };

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }
  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    this.screenshotCount++;
    // Return a tiny valid JPEG so decodeScreenshot doesn't crash.
    const sharp = (await import('sharp')).default;
    const buf = await sharp(
      Buffer.alloc(this.resolution.width * this.resolution.height * 3),
      { raw: { width: this.resolution.width, height: this.resolution.height, channels: 3 } },
    ).png().toBuffer();
    return { buffer: buf, screenshotWidth: this.resolution.width, screenshotHeight: this.resolution.height };
  }
  async mouseMoveRelative(_dx: number, _dy: number): Promise<void> {
    this.mouseMoveCount++;
    // If we ever issue 27+ rapid -127 moves, that's slam-to-corner.
    // Detection here is approximate: count moves and infer from total.
  }
}

describe('moveToPixel forbidSlamFallback', () => {
  it('throws on detect-then-move failure when forbidSlamFallback=true', async () => {
    const client = new FakeClient();
    // detect-then-move will fail on a uniform black frame (no clusters).
    // With forbidSlamFallback=true, expect a throw.
    //
    // Phase 68 added 3 progressive-wake retries (300+400+500 ms settles)
    // to the template-match fallback before giving up. Plus locateCursor's
    // own probe retries and settles. The overall failure path now takes
    // up to ~5 seconds in a normal run, but v8 coverage instrumentation
    // adds 2-3× overhead — bumped timeout to 30 s so coverage runs are
    // not flaky.
    await expect(
      moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
        strategy: 'detect-then-move',
        forbidSlamFallback: true,
        warmupMickeys: 0,
        calibrationProbeMickeys: 0,
      }),
    ).rejects.toThrow(/slam fallback forbidden|cursor cannot be located|detect-then-move failed/i);
  }, 30000);

  it('default (forbidSlamFallback=false) falls back to slam silently', async () => {
    const client = new FakeClient();
    // Default behaviour preserved: detect-then-move failure → slam fallback,
    // which on a uniform-black frame still proceeds (slam emits but the
    // diff produces no clusters, so we land at predicted). No throw.
    // Phase 32a: explicitly opt out of forbidSlamOnIpad — the all-black
    // synthetic frame gives ambiguous bounds, which the strengthened guard
    // would refuse by default. The unit under test here is the slam
    // FALLBACK path, not the iPad safety guard.
    const r = await moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
      strategy: 'detect-then-move',
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      forbidSlamOnIpad: false,
      // Reduce settle/sleep so test isn't slow.
      postMoveSettleMs: 0,
    });
    // Either slam-then-move was used or detect-then-move recovered. Either
    // way, we DON'T throw.
    expect(['slam-then-move', 'detect-then-move']).toContain(r.strategy);
  }, 60000);
});
