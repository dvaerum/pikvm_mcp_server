/**
 * Regression test for a live-confirmed gap (2026-08-24, iPad node's #60 gate):
 * the very first production-shape measureBallistics run (default options,
 * real slam motion now happening thanks to #58/#60) hit a genuine iPad lock
 * screen mid-sweep. Root cause: measureCell's own slamToCorner call didn't
 * pass verifyMotion:true — #59's guard only covered unlockIpad. A locked
 * screen read as ordinary near-zero-displacement noise, silently poisoning
 * the cell instead of failing loudly.
 *
 * Fix: measureCell now passes verifyMotion:true and rejects the cell
 * OUTRIGHT (no retry — unlike unlockIpad, which can't call itself to
 * recover) when the slam's expected motion doesn't register. Ballistics
 * already resamples via `reps`, so a rejected cell is cheap and low-risk —
 * no need to reintroduce a retry loop.
 *
 * These tests distinguish "rejected early, before wasting any HID calls on
 * a doomed measurement" from "proceeded to measure normally" by counting
 * total mouseMoveRelative calls: an early slam-check rejection stops right
 * after the slam (+ verifyMotion's own confirmation nudge), skipping
 * nudgeFromEdge / the warm-up probe / the callsPerCell measurement loop
 * entirely.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { measureBallistics } from '../ballistics.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

async function makeScreenshot(width: number, height: number, fill: [number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function stampSquare(base: Buffer, cx: number, cy: number, size: number, colour: [number, number, number]): Promise<Buffer> {
  const decoded = await sharp(base).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(decoded.data);
  const w = decoded.info.width;
  const h = decoded.info.height;
  const half = Math.floor(size / 2);
  for (let y = cy - half; y <= cy + half; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || x >= w) continue;
      const i = (y * w + x) * 3;
      data[i] = colour[0];
      data[i + 1] = colour[1];
      data[i + 2] = colour[2];
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

class FakeClient {
  resolution: ScreenResolution = { width: 400, height: 300 };
  moveCalls: Array<{ dx: number; dy: number }> = [];
  private shots: Buffer[];
  private shotCall = 0;

  constructor(shots: Buffer[]) {
    this.shots = shots;
  }

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    this.moveCalls.push({ dx, dy });
  }

  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    const buf = this.shots[Math.min(this.shotCall, this.shots.length - 1)];
    this.shotCall++;
    return { buffer: buf, screenshotWidth: this.resolution.width, screenshotHeight: this.resolution.height };
  }
}

const SINGLE_CELL_OPTS = {
  magnitudes: [5],
  paces: ['fast' as const],
  axes: ['x' as const],
  reps: 1,
  noiseFrames: 1,
  slamPaceMs: 0,
  slamCalls: 5,
  nudgeCalls: 5,
  callsPerCell: 3,
};

describe('measureCell slam verifyMotion', () => {
  it('rejects the cell WITHOUT measuring when slam motion does not verify (frozen/all-blank frames)', async () => {
    const blank = await makeScreenshot(400, 300, [50, 50, 50]);
    // Every screenshot() call returns the identical frame — diffScreenshots
    // never finds a cluster anywhere, so the slam-verify check always fails.
    const client = new FakeClient([blank]);

    const result = await measureBallistics(client as unknown as PiKVMClient, SINGLE_CELL_OPTS);

    expect(result.samplesAccepted).toBe(0);
    expect(result.samplesRejected).toBe(1);
    // Early exit: slamCalls(5) + verifyMotion's own confirmation nudge(1) = 6.
    // nudgeFromEdge(5) + warm-up probe(1) + callsPerCell(3) must NOT have run.
    expect(client.moveCalls).toHaveLength(6);
  });

  it('proceeds to measure normally when slam motion DOES verify (cluster appears near the corner)', async () => {
    const blank = await makeScreenshot(400, 300, [50, 50, 50]);
    const slamVerified = await stampSquare(blank, 5, 5, 10, [255, 255, 255]);
    // shots[0] = slam "before" (blank), shots[1] = slam "after" (cluster near
    // top-left → verified:true), everything after (measureCell's own
    // before/after pair) stays blank — that pair still finds no clusters, so
    // the cell is STILL ultimately rejected, but via the measurement-diff
    // path, only reachable if the slam-check did NOT early-exit first.
    const client = new FakeClient([blank, slamVerified, blank]);

    const result = await measureBallistics(client as unknown as PiKVMClient, SINGLE_CELL_OPTS);

    expect(result.samplesRejected).toBe(1); // still rejected (blank measurement frames), just later
    // Full pipeline ran: slam(5) + verify-nudge(1) + nudgeFromEdge(5) +
    // warm-up probe(1) + callsPerCell(3) = 15. Strictly more than the
    // early-exit case's 6 — proves the slam-check did not reject early.
    expect(client.moveCalls.length).toBeGreaterThan(6);
    expect(client.moveCalls).toHaveLength(15);
  });
});
