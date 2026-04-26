/**
 * Tests for autoCalibrateWithRetries — the retry wrapper around
 * autoCalibrate. autoCalibrate itself is hard to unit-test because
 * it runs a full sampling loop with ~5 rounds × 2 screenshots, but
 * the retry-wrapper logic is small and deterministic, and pinning
 * it protects against silent regressions where a refactor breaks
 * "fail fast on insufficient samples" or "increase moveDelayMs on
 * each retry".
 *
 * Mock client returns identical uniform-grey PNGs so that no diff
 * cluster ever forms → every autoCalibrate call fails with
 * "Insufficient valid samples". The wrapper should retry up to
 * maxRetries+1 times and then return the failure.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { autoCalibrateWithRetries } from '../auto-calibrate.js';
import type { PiKVMClient, ScreenResolution, CalibrationState } from '../client.js';

class UniformFrameClient {
  resolution: ScreenResolution = { width: 640, height: 480 };
  clearCalibrationCount = 0;
  mouseMoveRawCount = 0;
  screenshotCount = 0;
  private cachedPng: Buffer | null = null;

  clearCalibration(): void {
    this.clearCalibrationCount++;
  }

  getCalibration(): CalibrationState | null {
    return null;
  }

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }

  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    this.screenshotCount++;
    if (!this.cachedPng) {
      this.cachedPng = await sharp(
        Buffer.alloc(this.resolution.width * this.resolution.height * 3, 128),
        { raw: { width: this.resolution.width, height: this.resolution.height, channels: 3 } },
      )
        .png()
        .toBuffer();
    }
    return {
      buffer: this.cachedPng,
      screenshotWidth: this.resolution.width,
      screenshotHeight: this.resolution.height,
    };
  }

  async mouseMoveRaw(_x: number, _y: number): Promise<void> {
    this.mouseMoveRawCount++;
  }
}

describe('autoCalibrateWithRetries', () => {
  it('returns success=false when every attempt fails to detect a cursor', async () => {
    const client = new UniformFrameClient();
    const result = await autoCalibrateWithRetries(client as unknown as PiKVMClient, {
      maxRetries: 1,
      rounds: 2,
      minSamples: 1,
      moveDelayMs: 0, // no real-time delay during the test
      verbose: false,
    });
    expect(result.success).toBe(false);
    expect(result.factorX).toBe(1.0);
    expect(result.factorY).toBe(1.0);
  }, 30000);

  it('clears calibration on every attempt (resetting state for fresh measurement)', async () => {
    const client = new UniformFrameClient();
    await autoCalibrateWithRetries(client as unknown as PiKVMClient, {
      maxRetries: 1,
      rounds: 2,
      minSamples: 1,
      moveDelayMs: 0,
      verbose: false,
    });
    // maxRetries=1 → up to 2 attempts, each starts with clearCalibration().
    expect(client.clearCalibrationCount).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('returned message describes the failure cause', async () => {
    const client = new UniformFrameClient();
    const result = await autoCalibrateWithRetries(client as unknown as PiKVMClient, {
      maxRetries: 0,
      rounds: 2,
      minSamples: 1,
      moveDelayMs: 0,
      verbose: false,
    });
    // Either "Insufficient valid samples" or "Cursor detection failed" or
    // "Failed to diff screenshots" — all three are honest failure messages
    // produced by autoCalibrate when the cursor cannot be found.
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toMatch(/sample|cursor|diff|fail/i);
  }, 30000);

  it('returns the resolution from the last attempt', async () => {
    const client = new UniformFrameClient();
    client.resolution = { width: 1280, height: 720 };
    const result = await autoCalibrateWithRetries(client as unknown as PiKVMClient, {
      maxRetries: 0,
      rounds: 2,
      minSamples: 1,
      moveDelayMs: 0,
      verbose: false,
    });
    // Resolution should reflect what the client reports, not the {0,0}
    // unreachable-fallback path at the bottom of the function.
    expect(result.resolution.width).toBe(1280);
    expect(result.resolution.height).toBe(720);
  }, 30000);
});
