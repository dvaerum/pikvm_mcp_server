/**
 * Direct unit tests for unlockIpad. The function is complex —
 * slam to corner, position cursor, mouse-down, rapid drag, mouse-up,
 * settle, screenshot. The load-bearing contract is the mouse-down /
 * drag / mouse-up sandwich: if the button isn't held during the
 * drag, iPadOS treats it as a hover gesture (App Switcher) instead
 * of a touch drag (unlock).
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { unlockIpad } from '../ipad-unlock.js';
import type { PiKVMClient } from '../client.js';

interface CallRecord {
  type: 'shortcut' | 'move' | 'mouseDown' | 'mouseUp' | 'screenshot' | 'getResolution' | 'sendKey';
  detail: string;
  dx?: number;
  dy?: number;
}

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

function mockClient(opts: { screenshots?: Buffer[] } = {}) {
  const calls: CallRecord[] = [];
  const fakeShot = {
    buffer: Buffer.from('fake-jpeg'),
    screenshotWidth: 1920,
    screenshotHeight: 1080,
    actualWidth: 1920,
    actualHeight: 1080,
    scaleX: 1,
    scaleY: 1,
  };
  let shotCall = 0;
  const client = {
    async mouseMoveRelative(dx: number, dy: number): Promise<void> {
      calls.push({ type: 'move', detail: `${dx},${dy}`, dx, dy });
    },
    async mouseClick(_button: string, options?: { state?: boolean }): Promise<void> {
      // state===true: button down; state===false: button up; undefined: tap.
      if (options?.state === true) calls.push({ type: 'mouseDown', detail: '' });
      else if (options?.state === false) calls.push({ type: 'mouseUp', detail: '' });
      else calls.push({ type: 'mouseDown', detail: 'tap' });
    },
    async sendKey(key: string): Promise<void> {
      calls.push({ type: 'sendKey', detail: key });
    },
    async getResolution() {
      calls.push({ type: 'getResolution', detail: '' });
      return { width: 1920, height: 1080 };
    },
    async screenshot() {
      calls.push({ type: 'screenshot', detail: '' });
      if (opts.screenshots && opts.screenshots.length > 0) {
        const buf = opts.screenshots[Math.min(shotCall, opts.screenshots.length - 1)];
        shotCall++;
        return { buffer: buf, screenshotWidth: 1920, screenshotHeight: 1080, actualWidth: 1920, actualHeight: 1080, scaleX: 1, scaleY: 1 };
      }
      return fakeShot;
    },
  } as unknown as PiKVMClient;
  return { client, calls };
}

describe('unlockIpad', () => {
  it('issues mouse-down BEFORE the drag and mouse-up AFTER (sandwich invariant)', async () => {
    const m = mockClient();
    await unlockIpad(m.client, {
      // Phase 219: tryKeyPressFirst false to bypass the
      // skip-swipe-on-key-success branch, so the swipe mechanics
      // run and can be inspected.
      tryKeyPressFirst: false,
      slamFirst: false,        // skip slam so we don't generate noise
      startX: 960,
      startY: 800,
      dragPx: 100,
      chunkMickeys: 25,
      slamPaceMs: 0,
      postSettleMs: 0,
    });

    const downIdx = m.calls.findIndex((c) => c.type === 'mouseDown');
    const upIdx = m.calls.findIndex((c) => c.type === 'mouseUp');
    expect(downIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(downIdx);

    // Every drag move (negative dy) must be between down and up.
    const dragMoveIndices = m.calls
      .map((c, i) => (c.type === 'move' && (c.dy ?? 0) < 0 ? i : -1))
      .filter((i) => i >= 0);
    expect(dragMoveIndices.length).toBeGreaterThan(0);
    for (const i of dragMoveIndices) {
      expect(i).toBeGreaterThan(downIdx);
      expect(i).toBeLessThan(upIdx);
    }
  });

  it('drag direction is upward (negative Y)', async () => {
    const m = mockClient();
    await unlockIpad(m.client, {
      tryKeyPressFirst: false,
      slamFirst: false,
      startX: 960,
      startY: 800,
      dragPx: 100,
      chunkMickeys: 25,
      slamPaceMs: 0,
      postSettleMs: 0,
    });

    // Find drag moves (those issued between mouseDown and mouseUp).
    const downIdx = m.calls.findIndex((c) => c.type === 'mouseDown');
    const upIdx = m.calls.findIndex((c) => c.type === 'mouseUp');
    const dragMoves = m.calls.slice(downIdx + 1, upIdx).filter((c) => c.type === 'move');

    // All drag moves must have dy < 0 (upward) and dx === 0.
    for (const move of dragMoves) {
      expect(move.dx).toBe(0);
      expect(move.dy).toBeLessThan(0);
    }
  });

  it('total drag distance equals dragPx', async () => {
    const m = mockClient();
    await unlockIpad(m.client, {
      tryKeyPressFirst: false,
      slamFirst: false,
      startX: 960,
      startY: 800,
      dragPx: 800,
      chunkMickeys: 30,
      slamPaceMs: 0,
      postSettleMs: 0,
    });

    const downIdx = m.calls.findIndex((c) => c.type === 'mouseDown');
    const upIdx = m.calls.findIndex((c) => c.type === 'mouseUp');
    const dragMoves = m.calls.slice(downIdx + 1, upIdx).filter((c) => c.type === 'move');

    const totalDy = dragMoves.reduce((sum, m) => sum + (m.dy ?? 0), 0);
    expect(Math.abs(totalDy)).toBe(800);
  });

  it('each drag chunk is at most chunkMickeys', async () => {
    const m = mockClient();
    await unlockIpad(m.client, {
      tryKeyPressFirst: false,
      slamFirst: false,
      startX: 960,
      startY: 800,
      dragPx: 200,
      chunkMickeys: 25,
      slamPaceMs: 0,
      postSettleMs: 0,
    });

    const downIdx = m.calls.findIndex((c) => c.type === 'mouseDown');
    const upIdx = m.calls.findIndex((c) => c.type === 'mouseUp');
    const dragMoves = m.calls.slice(downIdx + 1, upIdx).filter((c) => c.type === 'move');
    for (const move of dragMoves) {
      expect(Math.abs(move.dy ?? 0)).toBeLessThanOrEqual(25);
    }
  });

  it('chunkMickeys=30 over 800 px → ~27 chunks', async () => {
    const m = mockClient();
    const result = await unlockIpad(m.client, {
      tryKeyPressFirst: false,
      slamFirst: false,
      startX: 960,
      startY: 800,
      dragPx: 800,
      chunkMickeys: 30,
      slamPaceMs: 0,
      postSettleMs: 0,
    });
    // 800 / 30 = 26.67 → 27 chunks.
    expect(result.chunkCount).toBe(27);
  });

  it('slamFirst:true slams to top-left before swipe (many 127-mickey deltas)', async () => {
    // Give the mock a decodable before/after frame pair with a cluster near
    // the expected corner, so the verifyMotion check added for the
    // unguarded-slam lock-risk fix reports verified:true cleanly instead of
    // tripping the retry path on the default mock's non-decodable
    // 'fake-jpeg' buffer. This test is about slam mechanics, not the retry
    // path — see the 'slam verifyMotion retry' describe block below for that.
    //
    // 30000ms timeout: this test also exercises verifyMotion, which (since
    // 2026-08-24's P0 cornerTargetFromBounds fix, #69) pays a real
    // bounds-detection round trip — same convention as the timeout bumps
    // in the 'slam verifyMotion retry' describe block below.
    const before = await makeScreenshot(1920, 1080, [50, 50, 50]);
    const after = await stampSquare(before, 5, 5, 10, [255, 255, 255]);
    const m = mockClient({ screenshots: [before, after] });
    await unlockIpad(m.client, {
      tryKeyPressFirst: false,
      slamFirst: true,
      startX: 960,
      startY: 800,
      dragPx: 100,
      chunkMickeys: 25,
      slamPaceMs: 0,
      postSettleMs: 0,
    });

    // Slam emits many (-127, -127) calls before any other move.
    const firstNonSlamIdx = m.calls.findIndex(
      (c) => c.type === 'move' && (c.dx !== -127 || c.dy !== -127),
    );
    // At least a few slam calls must precede the first non-slam move
    // (which is the position-emit toward (startX, startY) or the drag).
    expect(firstNonSlamIdx).toBeGreaterThan(5);
    for (let i = 0; i < firstNonSlamIdx; i++) {
      const c = m.calls[i];
      if (c.type === 'move') {
        expect(c.dx).toBe(-127);
        expect(c.dy).toBe(-127);
      }
    }
  }, 30000);

  it('slamFirst:false skips slam (no -127, -127 calls)', async () => {
    const m = mockClient();
    await unlockIpad(m.client, {
      tryKeyPressFirst: false,
      slamFirst: false,
      startX: 960,
      startY: 800,
      dragPx: 100,
      chunkMickeys: 25,
      slamPaceMs: 0,
      postSettleMs: 0,
    });
    const slamMoves = m.calls.filter(
      (c) => c.type === 'move' && c.dx === -127 && c.dy === -127,
    );
    expect(slamMoves).toHaveLength(0);
  });

  it('returns chunkCount, dragPx, swipeDurationMs in the result', async () => {
    const m = mockClient();
    const r = await unlockIpad(m.client, {
      tryKeyPressFirst: false,
      slamFirst: false,
      startX: 960,
      startY: 800,
      dragPx: 200,
      chunkMickeys: 25,
      slamPaceMs: 0,
      postSettleMs: 0,
    });
    expect(r.dragPx).toBe(200);
    expect(r.chunkCount).toBe(8); // 200 / 25 = 8
    expect(typeof r.swipeDurationMs).toBe('number');
  });

  describe('Phase 210/217: tryKeyPressFirst', () => {
    it('emits Escape, Enter, and Space key presses BEFORE the swipe (legacy behavior with swipeOnKeyPressFailure=false)', async () => {
      const m = mockClient();
      // Phase 219: with swipeOnKeyPressFailure=false, the swipe runs
      // even after the keys. Lets us pin the keys-then-swipe ordering.
      await unlockIpad(m.client, {
        swipeOnKeyPressFailure: false,
        slamFirst: false,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        slamPaceMs: 0,
        postSettleMs: 0,
      });
      const keyCalls = m.calls.filter(c => c.type === 'sendKey');
      const firstSwipeIdx = m.calls.findIndex(c => c.type === 'mouseDown');
      const keyDetails = keyCalls.map(c => c.detail);
      expect(keyDetails).toContain('Escape');
      expect(keyDetails).toContain('Enter');
      expect(keyDetails).toContain('Space');
      const enterIdx = m.calls.findIndex(c => c.type === 'sendKey' && c.detail === 'Enter');
      expect(enterIdx).toBeGreaterThanOrEqual(0);
      expect(firstSwipeIdx).toBeGreaterThan(0);
      expect(enterIdx).toBeLessThan(firstSwipeIdx);
    });

    it('Enter precedes Space (the documented Phase 217 ordering)', async () => {
      const m = mockClient();
      await unlockIpad(m.client, {
        slamFirst: false,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        slamPaceMs: 0,
        postSettleMs: 0,
      });
      const enterIdx = m.calls.findIndex(c => c.type === 'sendKey' && c.detail === 'Enter');
      const spaceIdx = m.calls.findIndex(c => c.type === 'sendKey' && c.detail === 'Space');
      expect(enterIdx).toBeGreaterThanOrEqual(0);
      expect(spaceIdx).toBeGreaterThanOrEqual(0);
      expect(enterIdx).toBeLessThan(spaceIdx);
    });

    // Phase 219: by default, when keys ran, the swipe is SKIPPED to
    // avoid the home-screen-to-lock-screen artifact.
    it('Phase 219: by default, swipe is SKIPPED after successful key press', async () => {
      const m = mockClient();
      await unlockIpad(m.client, {
        slamFirst: false,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        slamPaceMs: 0,
        postSettleMs: 0,
      });
      // Keys ran...
      const keyCalls = m.calls.filter(c => c.type === 'sendKey');
      expect(keyCalls.length).toBeGreaterThan(0);
      // ...but no swipe (no mouseDown for the drag).
      const mouseDowns = m.calls.filter(c => c.type === 'mouseDown');
      expect(mouseDowns).toHaveLength(0);
    });

    it('Phase 219: swipeOnKeyPressFailure=false forces swipe even after keys', async () => {
      const m = mockClient();
      await unlockIpad(m.client, {
        swipeOnKeyPressFailure: false,
        slamFirst: false,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        slamPaceMs: 0,
        postSettleMs: 0,
      });
      // Both keys AND swipe ran.
      const keyCalls = m.calls.filter(c => c.type === 'sendKey');
      const mouseDowns = m.calls.filter(c => c.type === 'mouseDown');
      expect(keyCalls.length).toBeGreaterThan(0);
      expect(mouseDowns).toHaveLength(1);
    });

    it('skips the key press when tryKeyPressFirst=false', async () => {
      const m = mockClient();
      await unlockIpad(m.client, {
        tryKeyPressFirst: false,
        slamFirst: false,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        slamPaceMs: 0,
        postSettleMs: 0,
      });
      const keyCalls = m.calls.filter(c => c.type === 'sendKey');
      expect(keyCalls).toHaveLength(0);
    });
  });

  // 2026-08-24: unlockIpad's pre-swipe slam is the one slamToCorner call
  // site that's both unguarded and reachable with zero special args
  // (pikvm_ipad_launch_app's default unlockFirst=true calls unlockIpad()
  // by default) — a controlled retest found the lock-screen risk present
  // at a non-trivial rate regardless of pace. Since unlockIpad can't call
  // itself to recover, the fallback is a bounded one-shot key-sequence
  // retry + re-slam.
  // Tests below that exercise verifyMotion use 30000ms timeouts (not the
  // 5000ms default): 2026-08-24's P0 cornerTargetFromBounds fix added a
  // real bounds-detection round trip inside verifyMotion's corner check
  // (cache-first, but the FIRST call in a test still pays it) — same
  // convention move-to.ts's/ipadGoHome's other slam-adjacent tests use.
  describe('slam verifyMotion retry (unguarded-slam lock-risk mitigation)', () => {
    it('retries the key sequence once and re-slams when the first slam does not verify', async () => {
      // Two IDENTICAL frames for the first slamToCorner(verifyMotion) call:
      // a diff of identical frames finds zero clusters, so verified:false.
      const before = await makeScreenshot(1920, 1080, [50, 50, 50]);
      const m = mockClient({ screenshots: [before, before] });
      const result = await unlockIpad(m.client, {
        tryKeyPressFirst: false, // isolate: only the retry logic sends keys here
        slamFirst: true,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        slamPaceMs: 0,
        postSettleMs: 0,
      });

      const keyCalls = m.calls.filter((c) => c.type === 'sendKey').map((c) => c.detail);
      expect(keyCalls).toEqual(['Escape', 'Enter', 'Space']);

      // Two full slam batches (28 calls each for 1920x1080) means the
      // second batch's first move is still (-127,-127) at index 28.
      const slamMoves = m.calls.filter((c) => c.type === 'move' && c.dx === -127 && c.dy === -127);
      expect(slamMoves.length).toBeGreaterThanOrEqual(56); // 2 × 28

      expect(result.slamVerified).toBe(false);
      expect(result.message).toContain('WARNING');
      // Execution still completes the swipe rather than aborting.
      expect(m.calls.some((c) => c.type === 'mouseDown')).toBe(true);
      expect(m.calls.some((c) => c.type === 'mouseUp')).toBe(true);
    }, 30000);

    it('does not retry when the first slam verifies', async () => {
      const before = await makeScreenshot(1920, 1080, [50, 50, 50]);
      const after = await stampSquare(before, 5, 5, 10, [255, 255, 255]);
      const m = mockClient({ screenshots: [before, after] });
      const result = await unlockIpad(m.client, {
        tryKeyPressFirst: false,
        slamFirst: true,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        slamPaceMs: 0,
        postSettleMs: 0,
      });

      expect(m.calls.filter((c) => c.type === 'sendKey')).toHaveLength(0);
      expect(result.slamVerified).toBe(true);
      expect(result.message).not.toContain('WARNING');
    }, 30000);

    it('recovers when the retry succeeds — only one key-retry, no second retry', async () => {
      const before1 = await makeScreenshot(1920, 1080, [50, 50, 50]);
      // First attempt: identical frames → not verified.
      // Second attempt: cluster near the corner → verified.
      const before2 = await makeScreenshot(1920, 1080, [50, 50, 50]);
      const after2 = await stampSquare(before2, 5, 5, 10, [255, 255, 255]);
      const m = mockClient({ screenshots: [before1, before1, before2, after2] });
      const result = await unlockIpad(m.client, {
        tryKeyPressFirst: false,
        slamFirst: true,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        slamPaceMs: 0,
        postSettleMs: 0,
      });

      const keyCalls = m.calls.filter((c) => c.type === 'sendKey').map((c) => c.detail);
      expect(keyCalls).toEqual(['Escape', 'Enter', 'Space']); // exactly one retry, not looping
      expect(result.slamVerified).toBe(true);
      expect(result.message).not.toContain('WARNING');
    }, 30000);

    it('slamFirst:false never performs the verifyMotion check (slamVerified: null)', async () => {
      const m = mockClient();
      const result = await unlockIpad(m.client, {
        tryKeyPressFirst: false,
        slamFirst: false,
        startX: 960,
        startY: 800,
        dragPx: 100,
        chunkMickeys: 25,
        postSettleMs: 0,
      });
      expect(result.slamVerified).toBeNull();
    });
  });
});
