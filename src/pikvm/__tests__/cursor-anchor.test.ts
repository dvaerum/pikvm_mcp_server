/**
 * Unit tests for anchorCursor — one describe per guard × recovery
 * combination. Guard behavior (bounds-guard's throw/refuse logic) is
 * tested directly here rather than only through moveToPixel, since the
 * primitive is now the single place that logic lives; see
 * move-to.forbidSlamOnIpad.test.ts / move-to.forbidSlam.test.ts for the
 * end-to-end pin through the real moveToPixel path.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { anchorCursor } from '../cursor-anchor.js';
import { clearOrientationCache } from '../orientation.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

/** Uniform-fill synthetic screenshot (same helper as slamToCorner.verifyMotion.test.ts). */
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

/** iPad-portrait letterbox frame (same construction as move-to.forbidSlamOnIpad.test.ts) —
 *  the bounds detector reads this as a detected portrait orientation. */
async function makeIpadPortraitFrame(): Promise<Buffer> {
  const w = 1920;
  const h = 1080;
  const data = Buffer.alloc(w * h * 3, 0);
  const ipadX0 = 625;
  const ipadX1 = 1295;
  for (let y = 0; y < h; y++) {
    for (let x = ipadX0; x <= ipadX1; x++) {
      const i = (y * w + x) * 3;
      data[i] = 200;
      data[i + 1] = 200;
      data[i + 2] = 200;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/** A landscape-ish "iPad content" frame — bright content the full frame width,
 *  which the bounds detector reads as landscape orientation (knownNonIpad). */
async function makeLandscapeFrame(): Promise<Buffer> {
  return makeScreenshot(1920, 1080, [200, 200, 200]);
}

interface MockOpts {
  resolution?: ScreenResolution;
  /** Frames client.screenshot() returns, in order (used by bounds detection). */
  boundsFrames?: Buffer[];
  /** Frames req.screenshot() returns, in order (used by verification). */
  verifyFrames?: Buffer[];
}

function mockClientAndScreenshot(opts: MockOpts = {}) {
  const resolution = opts.resolution ?? { width: 1920, height: 1080 };
  const boundsFrames = opts.boundsFrames ?? [];
  const verifyFrames = opts.verifyFrames ?? [];
  let boundsCall = 0;
  let verifyCall = 0;
  const moves: Array<{ dx: number; dy: number }> = [];
  const keys: string[] = [];
  const client = {
    async getResolution(): Promise<ScreenResolution> {
      return resolution;
    },
    async mouseMoveRelative(dx: number, dy: number): Promise<void> {
      moves.push({ dx, dy });
    },
    async sendKey(key: string): Promise<void> {
      keys.push(key);
    },
    async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
      const buf = boundsFrames[Math.min(boundsCall, boundsFrames.length - 1)];
      boundsCall++;
      return { buffer: buf, screenshotWidth: resolution.width, screenshotHeight: resolution.height };
    },
  } as unknown as PiKVMClient;

  let verifyCalled = false;
  const screenshot = async (): Promise<Buffer> => {
    verifyCalled = true;
    const buf = verifyFrames[Math.min(verifyCall, verifyFrames.length - 1)];
    verifyCall++;
    return buf;
  };

  return {
    client,
    screenshot,
    moves,
    keys,
    get verifyCallCount() { return verifyCall; },
    get verifyCalled() { return verifyCalled; },
  };
}

describe('anchorCursor guard: bounds-guard', () => {
  it('throws the byte-identical error when bounds detection fails (undetermined target)', async () => {
    clearOrientationCache();
    const blackFrame = await makeScreenshot(1920, 1080, [0, 0, 0]);
    const m = mockClientAndScreenshot({ boundsFrames: [blackFrame] });
    await expect(
      anchorCursor({
        client: m.client,
        guard: { kind: 'bounds-guard' },
        screenshot: m.screenshot,
        paceMs: 0,
      }),
    ).rejects.toThrow(
      'moveToPixel: refusing slam-then-move — target type undetermined ' +
      '(bounds detection failed — frame too dark or unrecognised) and ' +
      'slam-origin defaulted to LEGACY_PORTRAIT, which presumes iPad. ' +
      'Slam-to-corner on an iPad triggers the iPadOS hot-corner gesture and ' +
      're-locks the screen mid-session. Options: ' +
      '(1) use strategy=\'detect-then-move\' (recommended for iPad), ' +
      '(2) pass slamOriginPx explicitly if you know the target is non-iPad, ' +
      '(3) pass forbidSlamOnIpad=false to opt out (only safe if iPad ' +
      'hot-corners are disabled).',
    );
    expect(m.moves).toHaveLength(0);
  });

  it('throws when an iPad-portrait letterbox is detected', async () => {
    clearOrientationCache();
    const portrait = await makeIpadPortraitFrame();
    const m = mockClientAndScreenshot({ boundsFrames: [portrait] });
    await expect(
      anchorCursor({
        client: m.client,
        guard: { kind: 'bounds-guard' },
        screenshot: m.screenshot,
        paceMs: 0,
      }),
    ).rejects.toThrow(/iPad-portrait letterbox detected/);
    expect(m.moves).toHaveLength(0);
  });

  it('does not throw when bounds are detected as landscape (known non-iPad)', async () => {
    clearOrientationCache();
    const landscape = await makeLandscapeFrame();
    const m = mockClientAndScreenshot({ boundsFrames: [landscape] });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'bounds-guard' },
      screenshot: m.screenshot,
      paceMs: 0,
    });
    expect(m.moves.length).toBeGreaterThan(0);
    expect(result.bounds?.orientation).toBe('landscape');
  });

  it('does not throw when the caller passes an explicit slamOriginPx', async () => {
    clearOrientationCache();
    const blackFrame = await makeScreenshot(1920, 1080, [0, 0, 0]);
    const m = mockClientAndScreenshot({ boundsFrames: [blackFrame] });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'bounds-guard' },
      screenshot: m.screenshot,
      slamOriginPx: { x: 50, y: 50 },
      paceMs: 0,
    });
    expect(result.origin).toEqual({ x: 50, y: 50 });
    expect(m.moves.length).toBeGreaterThan(0);
  });

  it('allowOnUndetermined:true skips the refusal but keeps the same origin computation (forbidSlamOnIpad=false mapping)', async () => {
    clearOrientationCache();
    const blackFrame = await makeScreenshot(1920, 1080, [0, 0, 0]);
    const m = mockClientAndScreenshot({ boundsFrames: [blackFrame] });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'bounds-guard', allowOnUndetermined: true },
      screenshot: m.screenshot,
      paceMs: 0,
    });
    // Bounds detection failed → falls back to LEGACY_PORTRAIT_SLAM_ORIGIN,
    // same as the always-refuse path would have computed had it not thrown.
    expect(result.origin).toEqual({ x: 625, y: 65 });
    expect(m.moves.length).toBeGreaterThan(0);
  });

  it('captureVerification defaults false — zero verification screenshots taken (move-to.ts perf pin)', async () => {
    clearOrientationCache();
    const landscape = await makeLandscapeFrame();
    const m = mockClientAndScreenshot({ boundsFrames: [landscape] });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'bounds-guard' },
      screenshot: m.screenshot,
      paceMs: 0,
    });
    expect(m.verifyCalled).toBe(false);
    expect(result.verified).toBeNull();
    expect(result.recoveryAttempted).toBe(false);
  });
});

describe('anchorCursor guard: caller-asserted, recovery: none', () => {
  it('never throws even against an undetermined/black frame', async () => {
    clearOrientationCache();
    const blackFrame = await makeScreenshot(1920, 1080, [0, 0, 0]);
    const m = mockClientAndScreenshot({ boundsFrames: [blackFrame] });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'caller-asserted', reason: 'lock screen has no active hot corner' },
      screenshot: m.screenshot,
      paceMs: 0,
    });
    expect(result.verified).toBeNull();
    expect(m.moves.length).toBeGreaterThan(0);
  });
});

describe('anchorCursor guard: caller-asserted, recovery: key-sequence-retry', () => {
  it('verified:true on the first attempt — no recovery, no key presses', async () => {
    clearOrientationCache();
    const before = await makeScreenshot(400, 300, [50, 50, 50]);
    const after = await stampSquare(before, 5, 5, 10, [255, 255, 255]);
    const m = mockClientAndScreenshot({
      resolution: { width: 400, height: 300 },
      boundsFrames: [await makeScreenshot(400, 300, [0, 0, 0])],
      verifyFrames: [before, after],
    });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'caller-asserted', reason: 'test' },
      screenshot: m.screenshot,
      captureVerification: true,
      recovery: { kind: 'key-sequence-retry' },
      paceMs: 0,
    });
    expect(result.verified).toBe(true);
    expect(result.recoveryAttempted).toBe(false);
    expect(m.keys).toHaveLength(0);
  });

  it('recovers when the retry succeeds: Esc→Enter→Space, then re-slam+re-verify', async () => {
    clearOrientationCache();
    const frozen = await makeScreenshot(400, 300, [50, 50, 50]);
    const retryBefore = await makeScreenshot(400, 300, [60, 60, 60]);
    const retryAfter = await stampSquare(retryBefore, 5, 5, 10, [255, 255, 255]);
    const m = mockClientAndScreenshot({
      resolution: { width: 400, height: 300 },
      boundsFrames: [await makeScreenshot(400, 300, [0, 0, 0])],
      // First attempt: identical frames → not verified. Retry: motion registers.
      verifyFrames: [frozen, frozen, retryBefore, retryAfter],
    });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'caller-asserted', reason: 'test' },
      screenshot: m.screenshot,
      captureVerification: true,
      recovery: { kind: 'key-sequence-retry' },
      paceMs: 0,
    });
    expect(result.verified).toBe(true);
    expect(result.recoveryAttempted).toBe(true);
    expect(m.keys).toEqual(['Escape', 'Enter', 'Space']);
  });

  it('does not throw even when the retry also fails to verify', async () => {
    clearOrientationCache();
    const frozen = await makeScreenshot(400, 300, [50, 50, 50]);
    const m = mockClientAndScreenshot({
      resolution: { width: 400, height: 300 },
      boundsFrames: [await makeScreenshot(400, 300, [0, 0, 0])],
      verifyFrames: [frozen, frozen, frozen, frozen],
    });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'caller-asserted', reason: 'test' },
      screenshot: m.screenshot,
      captureVerification: true,
      recovery: { kind: 'key-sequence-retry' },
      paceMs: 0,
    });
    expect(result.verified).toBe(false);
    expect(result.recoveryAttempted).toBe(true);
    expect(m.keys).toEqual(['Escape', 'Enter', 'Space']);
  });
});

describe('anchorCursor guard: caller-asserted, recovery: defensive-keys', () => {
  it('sends Esc+Enter once on a failed verification — no re-slam, no throw', async () => {
    clearOrientationCache();
    const frozen = await makeScreenshot(400, 300, [50, 50, 50]);
    const m = mockClientAndScreenshot({
      resolution: { width: 400, height: 300 },
      boundsFrames: [await makeScreenshot(400, 300, [0, 0, 0])],
      verifyFrames: [frozen, frozen],
    });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'caller-asserted', reason: 'test' },
      screenshot: m.screenshot,
      captureVerification: true,
      recovery: { kind: 'defensive-keys' },
      paceMs: 0,
    });
    expect(result.verified).toBe(false);
    expect(result.recoveryAttempted).toBe(true);
    expect(m.keys).toEqual(['Escape', 'Enter']);
    // No re-attempt: exactly one before/after pair (2 calls) was consumed.
    expect(m.verifyCallCount).toBe(2);
  });

  it('does not run recovery when verification succeeds', async () => {
    clearOrientationCache();
    const before = await makeScreenshot(400, 300, [50, 50, 50]);
    const after = await stampSquare(before, 5, 5, 10, [255, 255, 255]);
    const m = mockClientAndScreenshot({
      resolution: { width: 400, height: 300 },
      boundsFrames: [await makeScreenshot(400, 300, [0, 0, 0])],
      verifyFrames: [before, after],
    });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'caller-asserted', reason: 'test' },
      screenshot: m.screenshot,
      captureVerification: true,
      recovery: { kind: 'defensive-keys' },
      paceMs: 0,
    });
    expect(result.verified).toBe(true);
    expect(result.recoveryAttempted).toBe(false);
    expect(m.keys).toHaveLength(0);
  });
});

describe('anchorCursor selfGate:false — computes but never gates', () => {
  it('verified is still populated on failure, but no recovery runs and no throw', async () => {
    clearOrientationCache();
    const frozen = await makeScreenshot(400, 300, [50, 50, 50]);
    const m = mockClientAndScreenshot({
      resolution: { width: 400, height: 300 },
      boundsFrames: [await makeScreenshot(400, 300, [0, 0, 0])],
      verifyFrames: [frozen, frozen],
    });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'caller-asserted', reason: 'test' },
      screenshot: m.screenshot,
      captureVerification: true,
      selfGate: false,
      recovery: { kind: 'key-sequence-retry' }, // present but must not fire
      paceMs: 0,
    });
    expect(result.verified).toBe(false);
    expect(result.recoveryAttempted).toBe(false);
    expect(m.keys).toHaveLength(0);
  });
});

describe('anchorCursor guard: none-calibration', () => {
  it('never screenshots for verification when captureVerification is unset (default false)', async () => {
    clearOrientationCache();
    const m = mockClientAndScreenshot({ resolution: { width: 400, height: 300 } });
    const result = await anchorCursor({
      client: m.client,
      guard: { kind: 'none-calibration' },
      screenshot: m.screenshot,
      paceMs: 0,
    });
    expect(m.verifyCalled).toBe(false);
    expect(result.verified).toBeNull();
    expect(result.bounds).toBeNull();
    // No bounds-detection screenshot either — none-calibration skips
    // detection entirely (measureCell's synthetic scene has no iPad to find).
    expect(m.moves.length).toBeGreaterThan(0); // the bare slam still ran
  });

  it('never throws regardless of what a screenshot fn would show', async () => {
    clearOrientationCache();
    const m = mockClientAndScreenshot({ resolution: { width: 400, height: 300 } });
    await expect(
      anchorCursor({
        client: m.client,
        guard: { kind: 'none-calibration' },
        screenshot: m.screenshot,
        paceMs: 0,
      }),
    ).resolves.toBeDefined();
  });

  it('runs the post-slam nudge when requested', async () => {
    clearOrientationCache();
    const m = mockClientAndScreenshot({ resolution: { width: 400, height: 300 } });
    await anchorCursor({
      client: m.client,
      guard: { kind: 'none-calibration' },
      screenshot: m.screenshot,
      paceMs: 0,
      nudge: { away: 'top-left', onlyAxis: 'y' },
    });
    // nudgeFromEdge's default 5 calls, all in +y (away from top-left,
    // onlyAxis:'y' zeroes dx) — on top of the slam's own moves.
    const nudgeMoves = m.moves.filter((mv) => mv.dx === 0 && mv.dy > 0);
    expect(nudgeMoves.length).toBe(5);
  });

  it('skips the nudge when omitted', async () => {
    clearOrientationCache();
    const m = mockClientAndScreenshot({ resolution: { width: 400, height: 300 } });
    await anchorCursor({
      client: m.client,
      guard: { kind: 'none-calibration' },
      screenshot: m.screenshot,
      paceMs: 0,
    });
    const nudgeMoves = m.moves.filter((mv) => mv.dx === 0 && mv.dy > 0);
    expect(nudgeMoves.length).toBe(0);
  });
});
