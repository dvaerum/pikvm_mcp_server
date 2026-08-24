/**
 * Unit tests for slamToCorner's optional verifyMotion check (SlamOptions),
 * added 2026-08-24 as the shared-root mitigation for the unguarded-slam
 * lock-risk: unlockIpad()'s pre-swipe slam is reachable with zero special
 * args (pikvm_ipad_launch_app's default unlockFirst=true) and a controlled
 * retest found the lock-screen risk present at a non-trivial rate
 * regardless of pace, so the pace fix alone (see measureBallistics.slamPace
 * .test.ts) isn't sufficient on its own.
 *
 * verifyMotion screenshots before and after the slam and checks whether a
 * cursor-sized cluster appeared within cornerTolerance px of the expected
 * corner, reusing the same diff/cluster-detection primitives measureCell
 * already relies on. It deliberately does NOT classify "is this a lock
 * screen" (see ipad-unlock.ts's Phase 321 history for why a general
 * classifier was rejected) — only "did the expected motion register".
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { slamToCorner } from '../ballistics.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

/** Build a synthetic uniform-fill screenshot (same helper as cursor-detect.test.ts). */
async function makeScreenshot(width: number, height: number, fill: [number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Stamp a filled square of `colour` into an existing screenshot at (cx, cy). */
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

function mockClient(opts: { resolution?: ScreenResolution; screenshots?: Buffer[] } = {}) {
  const resolution = opts.resolution ?? { width: 400, height: 300 };
  const shots = opts.screenshots ?? [];
  let shotCall = 0;
  let screenshotCalled = false;
  const moves: Array<{ dx: number; dy: number }> = [];
  const client = {
    async getResolution(): Promise<ScreenResolution> {
      return resolution;
    },
    async mouseMoveRelative(dx: number, dy: number): Promise<void> {
      moves.push({ dx, dy });
    },
    async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
      screenshotCalled = true;
      const buf = shots[Math.min(shotCall, shots.length - 1)];
      shotCall++;
      return { buffer: buf, screenshotWidth: resolution.width, screenshotHeight: resolution.height };
    },
  } as unknown as PiKVMClient;
  return { client, moves, get screenshotCalled() { return screenshotCalled; } };
}

describe('slamToCorner verifyMotion', () => {
  it('unset (default false) — no screenshots taken, returns undefined (no behavior change for existing callers)', async () => {
    const m = mockClient();
    const result = await slamToCorner(m.client, { paceMs: 0 });
    expect(result).toBeUndefined();
    expect(m.screenshotCalled).toBe(false);
  });

  it('verified:true when a cursor-sized cluster appears near the expected corner (top-left)', async () => {
    const before = await makeScreenshot(400, 300, [50, 50, 50]);
    const after = await stampSquare(before, 5, 5, 10, [255, 255, 255]);
    const m = mockClient({ screenshots: [before, after] });
    const result = await slamToCorner(m.client, { paceMs: 0, verifyMotion: true });
    expect(result).toBeDefined();
    expect(result!.verified).toBe(true);
    expect(result!.matchedClusters.length).toBeGreaterThan(0);
    expect(m.screenshotCalled).toBe(true);
  });

  it('verified:false when nothing changed between before/after (frozen screen)', async () => {
    const before = await makeScreenshot(400, 300, [50, 50, 50]);
    const m = mockClient({ screenshots: [before, before] });
    const result = await slamToCorner(m.client, { paceMs: 0, verifyMotion: true });
    expect(result).toBeDefined();
    expect(result!.verified).toBe(false);
    expect(result!.matchedClusters).toHaveLength(0);
  });

  it('verified:false when a cluster appears far from the expected corner (outside cornerTolerance)', async () => {
    const before = await makeScreenshot(400, 300, [50, 50, 50]);
    const after = await stampSquare(before, 350, 250, 10, [255, 255, 255]); // near bottom-right
    const m = mockClient({ screenshots: [before, after] });
    const result = await slamToCorner(m.client, { paceMs: 0, verifyMotion: true, corner: 'top-left' });
    expect(result!.verified).toBe(false);
  });

  it('respects a custom corner when computing the expected target', async () => {
    const before = await makeScreenshot(400, 300, [50, 50, 50]);
    // Near bottom-right (400,300) — matches corner:'bottom-right', not top-left.
    const after = await stampSquare(before, 395, 295, 10, [255, 255, 255]);
    const m = mockClient({ screenshots: [before, after] });
    const result = await slamToCorner(m.client, { paceMs: 0, verifyMotion: true, corner: 'bottom-right' });
    expect(result!.verified).toBe(true);
  });

  it('respects a custom cornerTolerance', async () => {
    const before = await makeScreenshot(400, 300, [50, 50, 50]);
    const after = await stampSquare(before, 50, 50, 10, [255, 255, 255]); // ~70px from (0,0)
    const m = mockClient({ screenshots: [before, after] });
    const tight = await slamToCorner(m.client, { paceMs: 0, verifyMotion: true, cornerTolerance: 10 });
    expect(tight!.verified).toBe(false);
    const m2 = mockClient({ screenshots: [before, after] });
    const loose = await slamToCorner(m2.client, { paceMs: 0, verifyMotion: true, cornerTolerance: 100 });
    expect(loose!.verified).toBe(true);
  });
});
