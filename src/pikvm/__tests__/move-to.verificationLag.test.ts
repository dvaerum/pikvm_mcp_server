/**
 * Phase 24 (partial Direction 3) — verification-lag tracking.
 *
 * Today MoveToResult.finalResidualPx is computed from the last verified
 * detection's position. If subsequent correction passes fall through to
 * predicted mode (motion-diff and template-match both blind), the
 * algorithm keeps emitting small corrections but never re-confirms the
 * cursor's actual position. The reported residual still reads as
 * "verified" in the message because finalDetectedPosition is non-null,
 * even though that position is from many passes ago.
 *
 * This test pins a new field, `passesSinceLastVerification`, that
 * exposes how many predicted passes have run after the most recent
 * verified detection. Callers (and the MCP-tool message) can use this
 * to flag stale verifications honestly without changing the correction
 * loop's exit semantics (that's a larger Direction 3 change deferred
 * for now).
 *
 * Mocked PiKVMClient with a uniform-black frame so detect-then-move
 * cannot find any clusters → every pass falls through to predicted mode.
 */

import { describe, expect, it } from 'vitest';
import { moveToPixel } from '../move-to.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';
import sharp from 'sharp';

class BlackFrameClient {
  resolution: ScreenResolution = { width: 1920, height: 1080 };

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }
  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    const buf = await sharp(
      Buffer.alloc(this.resolution.width * this.resolution.height * 3),
      { raw: { width: this.resolution.width, height: this.resolution.height, channels: 3 } },
    )
      .png()
      .toBuffer();
    return { buffer: buf, screenshotWidth: this.resolution.width, screenshotHeight: this.resolution.height };
  }
  async mouseMoveRelative(_dx: number, _dy: number): Promise<void> {
    /* no-op */
  }
}

describe('moveToPixel verification lag', () => {
  it('exposes passesSinceLastVerification on MoveToResult', async () => {
    const client = new BlackFrameClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
      strategy: 'slam-then-move', // skip detect-origin; we want the open-loop + corrections path
      forbidSlamFallback: false,
      forbidSlamOnIpad: false, // Phase 32a: synthetic black frame is ambiguous; opt out
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    // Black frame → motion-diff yields no clusters → predicted mode all the
    // way through. Field must be defined and ≥ 0.
    expect(typeof result.passesSinceLastVerification).toBe('number');
    expect(result.passesSinceLastVerification).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('reports passesSinceLastVerification > 0 when no verification ever succeeds', async () => {
    const client = new BlackFrameClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
      strategy: 'slam-then-move',
      forbidSlamFallback: false,
      forbidSlamOnIpad: false, // Phase 32a: synthetic black frame is ambiguous; opt out
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    // No verification ever happened on a black frame → finalDetectedPosition
    // is null AND passesSinceLastVerification reflects that the last update
    // mode is predicted (≥ 1, since the open-loop verification failed).
    expect(result.finalDetectedPosition).toBeNull();
    expect(result.passesSinceLastVerification).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('message flags stale verification when passesSinceLastVerification > 0', async () => {
    const client = new BlackFrameClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
      strategy: 'slam-then-move',
      forbidSlamFallback: false,
      forbidSlamOnIpad: false, // Phase 32a: synthetic black frame is ambiguous; opt out
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    // Pinning the message contract: when the residual was last verified
    // some passes ago, the operator-facing message must say so. Catches
    // a regression where the message claimed a verified residual without
    // qualification.
    if (result.passesSinceLastVerification > 0) {
      expect(result.message).toMatch(/uncertain|unverified|predicted|not detected|not.*verif/i);
    }
  }, 30000);
});
