/**
 * Phase 25 — server-side retry-on-miss in clickAtWithRetry.
 *
 * The unit tests use a fake client that can return different post-click
 * screenshots on different calls, simulating miss-then-hit. The
 * orchestrator should: try once; on no-screen-change, take a fresh
 * probe via moveToPixel (detect-then-move) and re-aim; click; verify;
 * up to maxRetries times.
 *
 * On hit, return immediately with attempts=N. On exhausted retries,
 * return success=false with the final state.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { clickAtWithRetry } from '../click-verify.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

async function uniformPng(width: number, height: number, gray: number): Promise<Buffer> {
  return sharp(Buffer.alloc(width * height * 3, gray), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
}

async function pngWithRect(
  width: number,
  height: number,
  baseGray: number,
  rect: { x: number; y: number; w: number; h: number; gray: number },
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3, baseGray);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const idx = (y * width + x) * 3;
      raw[idx] = rect.gray;
      raw[idx + 1] = rect.gray;
      raw[idx + 2] = rect.gray;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

class ScriptedClient {
  resolution: ScreenResolution = { width: 100, height: 100 };
  /** Frame returned for any screenshot before the first mouseClick. */
  beforeClickFrame: Buffer = Buffer.alloc(0);
  /** postClickFrames[N-1] is returned after the Nth mouseClick.
   *  If the script runs out, the last entry is reused. */
  postClickFrames: Buffer[] = [];
  mouseClickCount = 0;
  mouseMoveRelativeCount = 0;

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }

  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    const buf =
      this.mouseClickCount === 0
        ? this.beforeClickFrame
        : (this.postClickFrames[this.mouseClickCount - 1] ??
           this.postClickFrames[this.postClickFrames.length - 1] ??
           this.beforeClickFrame);
    return {
      buffer: buf,
      screenshotWidth: this.resolution.width,
      screenshotHeight: this.resolution.height,
    };
  }

  async mouseClick(_button: string): Promise<void> {
    this.mouseClickCount++;
  }

  async mouseMoveRelative(_dx: number, _dy: number): Promise<void> {
    this.mouseMoveRelativeCount++;
  }
}

const FAST_MOVE_OPTS = {
  strategy: 'slam-then-move' as const,
  forbidSlamFallback: false,
  // Phase 32: tiny synthetic 100×100 grey frames trip the iPad-portrait
  // detector (centre column is brighter than letterbox edges). Opt out
  // of the new guard for these unit tests — the slam path is the unit
  // under test, not the iPad safety guard.
  forbidSlamOnIpad: false,
  warmupMickeys: 0,
  calibrationProbeMickeys: 0,
  postMoveSettleMs: 0,
  correct: false,
};

describe('clickAtWithRetry', () => {
  it('returns success=true with attempts=1 when first attempt hits', async () => {
    const grey = await uniformPng(100, 100, 128);
    const changed = await pngWithRect(100, 100, 128, { x: 10, y: 10, w: 30, h: 30, gray: 250 });
    const client = new ScriptedClient();
    client.beforeClickFrame = grey;
    client.postClickFrames = [changed]; // first click → screen changed

    const result = await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
      maxRetries: 2,
      moveToOptions: FAST_MOVE_OPTS,
      preClickSettleMs: 0,
      postClickSettleMs: 0,
      // Phase 35: synthetic grey frames give moveToPixel no cursor pair to
      // verify, so finalDetectedPosition is null. The unit under test is
      // the retry orchestration, not the cursor-verification gate, so opt
      // out of requireVerifiedCursor.
      requireVerifiedCursor: false,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(client.mouseClickCount).toBe(1);
  }, 30000);

  it('retries on screen-not-changed and returns success=true with attempts=2 if second hits', async () => {
    const grey = await uniformPng(100, 100, 128);
    const changed = await pngWithRect(100, 100, 128, { x: 10, y: 10, w: 30, h: 30, gray: 250 });
    const client = new ScriptedClient();
    client.beforeClickFrame = grey;
    // After click 1: still grey (no change → retry).
    // After click 2: changed (success).
    client.postClickFrames = [grey, changed];

    const result = await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
      maxRetries: 3,
      moveToOptions: FAST_MOVE_OPTS,
      preClickSettleMs: 0,
      postClickSettleMs: 0,
      // Phase 35: synthetic frames give moveToPixel no cursor pair to
      // verify, so finalDetectedPosition is null. The unit under test is
      // retry orchestration, not the cursor-verification gate.
      requireVerifiedCursor: false,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(client.mouseClickCount).toBe(2);
  }, 30000);

  it('returns success=false with attempts=maxRetries+1 when all attempts miss', async () => {
    const grey = await uniformPng(100, 100, 128);
    const client = new ScriptedClient();
    client.beforeClickFrame = grey;
    client.postClickFrames = [grey]; // every click → no change

    const result = await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
      maxRetries: 1,
      moveToOptions: FAST_MOVE_OPTS,
      preClickSettleMs: 0,
      postClickSettleMs: 0,
      // Phase 35: synthetic frames give moveToPixel no cursor pair to
      // verify, so finalDetectedPosition is null. The unit under test is
      // retry orchestration, not the cursor-verification gate.
      requireVerifiedCursor: false,
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(client.mouseClickCount).toBe(2);
  }, 30000);

  it('with maxRetries=0 reduces to single-shot behavior (no retry)', async () => {
    const grey = await uniformPng(100, 100, 128);
    const client = new ScriptedClient();
    client.beforeClickFrame = grey;
    client.postClickFrames = [grey];

    const result = await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
      maxRetries: 0,
      moveToOptions: FAST_MOVE_OPTS,
      preClickSettleMs: 0,
      postClickSettleMs: 0,
      // Phase 35: synthetic frames give moveToPixel no cursor pair to
      // verify, so finalDetectedPosition is null. The unit under test is
      // retry orchestration, not the cursor-verification gate.
      requireVerifiedCursor: false,
    });

    expect(result.attempts).toBe(1);
    expect(client.mouseClickCount).toBe(1);
  }, 30000);

  it('returns the final post-click screenshot regardless of success', async () => {
    const grey = await uniformPng(100, 100, 128);
    const client = new ScriptedClient();
    client.beforeClickFrame = grey;
    client.postClickFrames = [grey];

    const result = await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
      maxRetries: 0,
      moveToOptions: FAST_MOVE_OPTS,
      preClickSettleMs: 0,
      postClickSettleMs: 0,
      // Phase 35: synthetic frames give moveToPixel no cursor pair to
      // verify, so finalDetectedPosition is null. The unit under test is
      // retry orchestration, not the cursor-verification gate.
      requireVerifiedCursor: false,
    });

    expect(result.postClickScreenshot).toBeInstanceOf(Buffer);
    expect(result.postClickScreenshot.length).toBeGreaterThan(0);
  }, 30000);

  it('attemptHistory records each attempt in order', async () => {
    const grey = await uniformPng(100, 100, 128);
    const changed = await pngWithRect(100, 100, 128, { x: 10, y: 10, w: 30, h: 30, gray: 250 });
    const client = new ScriptedClient();
    client.beforeClickFrame = grey;
    client.postClickFrames = [grey, grey, changed]; // succeed on 3rd attempt

    const result = await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
      maxRetries: 5,
      moveToOptions: FAST_MOVE_OPTS,
      preClickSettleMs: 0,
      postClickSettleMs: 0,
      // Phase 35: synthetic frames give moveToPixel no cursor pair to
      // verify, so finalDetectedPosition is null. The unit under test is
      // retry orchestration, not the cursor-verification gate.
      requireVerifiedCursor: false,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.attemptHistory).toHaveLength(3);
    expect(result.attemptHistory[0].screenChanged).toBe(false);
    expect(result.attemptHistory[1].screenChanged).toBe(false);
    expect(result.attemptHistory[2].screenChanged).toBe(true);
  }, 30000);

  // Phase 36 — moveToPixel throws (e.g. forbidSlamFallback when cursor
  // can't be located) are caught and treated as a failed attempt rather
  // than aborting the whole retry sequence. If every attempt throws, the
  // final error is re-thrown so the caller sees the root cause.
  it('Phase 36: catches moveToPixel throws and continues retrying', async () => {
    // Construct a client whose screenshot ALWAYS yields a uniform black
    // frame too tiny for the iPad-bounds detector. moveToPixel's
    // detect-then-move with forbidSlamFallback=true will throw on every
    // attempt (no cursor can be found, no fallback allowed).
    class AlwaysFailMoveClient {
      resolution: ScreenResolution = { width: 200, height: 200 };
      mouseClickCount = 0;
      mouseMoveRelativeCount = 0;
      async getResolution() { return this.resolution; }
      async screenshot() {
        const buf = await sharp(
          Buffer.alloc(200 * 200 * 3, 0),
          { raw: { width: 200, height: 200, channels: 3 } },
        ).jpeg().toBuffer();
        return { buffer: buf, screenshotWidth: 200, screenshotHeight: 200 };
      }
      async mouseClick(_button: string) { this.mouseClickCount++; }
      async mouseMoveRelative(_dx: number, _dy: number) { this.mouseMoveRelativeCount++; }
    }
    const client = new AlwaysFailMoveClient();

    // Every attempt throws (cursor cannot be located + forbidSlamFallback).
    await expect(
      clickAtWithRetry(client as unknown as PiKVMClient, { x: 100, y: 100 }, {
        maxRetries: 2,
        moveToOptions: {
          strategy: 'detect-then-move',
          forbidSlamFallback: true,
          warmupMickeys: 0,
          calibrationProbeMickeys: 0,
        },
        preClickSettleMs: 0,
        postClickSettleMs: 0,
      }),
    ).rejects.toThrow(/every attempt.*failed|cursor cannot be located|moveToPixel/i);
    // No clicks should have happened.
    expect(client.mouseClickCount).toBe(0);
  }, 60000);

  // Phase 35 — requireVerifiedCursor (default true): when moveToPixel
  // can't verify cursor position post-move (finalDetectedPosition === null),
  // skip the click. The retry loop tries afresh; if every attempt is
  // unverified, no click is ever issued.
  it('Phase 35: skips click when cursor not verified (default behaviour)', async () => {
    const grey = await uniformPng(100, 100, 128);
    const client = new ScriptedClient();
    client.beforeClickFrame = grey;
    client.postClickFrames = [grey];

    const result = await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
      maxRetries: 2,
      moveToOptions: FAST_MOVE_OPTS,
      preClickSettleMs: 0,
      postClickSettleMs: 0,
      // requireVerifiedCursor defaults to true — the synthetic grey frame
      // gives no verifiable cursor position, so every attempt should be
      // skipped without ever clicking.
    });

    // No clicks should have been issued.
    expect(client.mouseClickCount).toBe(0);
    // Result reports failure with all attempts marked as skipped.
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3); // maxRetries+1 attempts, all skipped
    expect(result.attemptHistory.every((a) => a.cursorVerified === false)).toBe(true);
    expect(result.attemptHistory.every((a) => a.skippedClickReason !== undefined)).toBe(true);
    // Final verification message must indicate the click was skipped.
    expect(result.finalVerification.message).toMatch(/skipped|not verified/i);
    // Stand-in screenshot is provided so callers always have an image.
    expect(result.postClickScreenshot).toBeInstanceOf(Buffer);
    expect(result.postClickScreenshot.length).toBeGreaterThan(0);
  }, 30000);
});
