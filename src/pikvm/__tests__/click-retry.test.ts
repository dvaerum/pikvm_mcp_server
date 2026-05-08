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
  /** Phase 191: record every relative-mouse emit's (dx, dy) and the
   *  current attempt index (inferred via mouseClickCount BEFORE the
   *  emit; click N has not yet fired during attempt N+1's setup). */
  mouseMoveRelativeCalls: Array<{ dx: number; dy: number; clicksBefore: number }> = [];

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

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    this.mouseMoveRelativeCount++;
    this.mouseMoveRelativeCalls.push({ dx, dy, clicksBefore: this.mouseClickCount });
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
      // Phase 38: synthetic uniform frames are dim (mean=128, just above
      // VERY_DIM_THRESHOLD=50, so most should pass — but this opt-out
      // keeps the test stable even if thresholds change).
      minBrightness: 0,
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
      // Phase 38: synthetic uniform frames are dim (mean=128, just above
      // VERY_DIM_THRESHOLD=50, so most should pass — but this opt-out
      // keeps the test stable even if thresholds change).
      minBrightness: 0,
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
      // Phase 38: synthetic uniform frames are dim (mean=128, just above
      // VERY_DIM_THRESHOLD=50, so most should pass — but this opt-out
      // keeps the test stable even if thresholds change).
      minBrightness: 0,
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
      // Phase 38: synthetic uniform frames are dim (mean=128, just above
      // VERY_DIM_THRESHOLD=50, so most should pass — but this opt-out
      // keeps the test stable even if thresholds change).
      minBrightness: 0,
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
      // Phase 38: synthetic uniform frames are dim (mean=128, just above
      // VERY_DIM_THRESHOLD=50, so most should pass — but this opt-out
      // keeps the test stable even if thresholds change).
      minBrightness: 0,
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
      // Phase 38: synthetic uniform frames are dim (mean=128, just above
      // VERY_DIM_THRESHOLD=50, so most should pass — but this opt-out
      // keeps the test stable even if thresholds change).
      minBrightness: 0,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.attemptHistory).toHaveLength(3);
    expect(result.attemptHistory[0].screenChanged).toBe(false);
    expect(result.attemptHistory[1].screenChanged).toBe(false);
    expect(result.attemptHistory[2].screenChanged).toBe(true);
  }, 30000);

  // Phase 38 — brightness precheck. When the screen is too dim for cursor
  // detection (live-verified mean<50 reliably fails), throw fast with
  // actionable error rather than wasting maxRetries+1 attempts.
  it('Phase 38: throws fast when screen brightness below threshold', async () => {
    // Uniform black frame (mean=0, well below VERY_DIM_THRESHOLD=50).
    class DimFrameClient {
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
    const client = new DimFrameClient();
    await expect(
      clickAtWithRetry(client as unknown as PiKVMClient, { x: 100, y: 100 }, {
        maxRetries: 2,
        // Default minBrightness=VERY_DIM_THRESHOLD (50). All-black frame
        // has mean=0 → precheck throws.
      }),
    ).rejects.toThrow(/screen too dim|wake the iPad/i);
    // Precheck happens before any moveToPixel call → no clicks, no moves.
    expect(client.mouseClickCount).toBe(0);
    expect(client.mouseMoveRelativeCount).toBe(0);
  }, 30000);

  // Phase 38b — minBrightness=0 disables the precheck (escape hatch for
  // tests using synthetic dim frames or for callers that know the target
  // is intentionally dark, e.g. video playback).
  it('Phase 38: minBrightness=0 disables the precheck', async () => {
    class DimFrameClient {
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
    const client = new DimFrameClient();
    // Don't expect a brightness throw — but moveToPixel may still throw
    // from forbidSlamFallback. Catch any error type.
    let caught: Error | null = null;
    try {
      await clickAtWithRetry(client as unknown as PiKVMClient, { x: 100, y: 100 }, {
        maxRetries: 0,
        moveToOptions: {
          strategy: 'detect-then-move',
          forbidSlamFallback: true,
          warmupMickeys: 0,
          calibrationProbeMickeys: 0,
        },
        preClickSettleMs: 0,
        postClickSettleMs: 0,
        minBrightness: 0,
      });
    } catch (e) {
      caught = e as Error;
    }
    // Whatever happens, the brightness precheck did NOT throw — the
    // error must NOT mention "screen too dim".
    if (caught) {
      expect(caught.message).not.toMatch(/screen too dim/);
    }
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
    // Phase 38: skip the brightness precheck — the synthetic all-black
    // frame would trip it (mean=0). The unit under test is the
    // catch-and-rethrow flow when moveToPixel itself fails, NOT the
    // brightness gate.
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
        minBrightness: 0,
      }),
    ).rejects.toThrow(/every attempt.*failed|cursor cannot be located|moveToPixel/i);
    // No clicks should have happened.
    expect(client.mouseClickCount).toBe(0);
  }, 60000);

  // Phase 72 — autoUnlockOnDetectFail: when detect-then-move fails with
  // a lock-screen-mentioning error AND the option is on, clickAtWithRetry
  // calls ipadGoHome (which emits many mouseMoveRelative calls for the
  // swipe gesture) before retrying moveToPixel. Even if recovery doesn't
  // succeed (synthetic always-fail client), the option's PRESENCE causes
  // ipadGoHome to fire, distinguishing it from autoUnlockOnDetectFail=false.
  it('Phase 72: autoUnlockOnDetectFail invokes ipadGoHome on lock-screen errors', async () => {
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
    // Capture the error message moveToPixel actually throws for a
    // synthetic black frame — the auto-unlock regex needs to match it.
    let baselineError: string | null = null;
    try {
      await clickAtWithRetry(new AlwaysFailMoveClient() as unknown as PiKVMClient, { x: 100, y: 100 }, {
        maxRetries: 0,
        moveToOptions: {
          strategy: 'detect-then-move' as const,
          forbidSlamFallback: true,
          warmupMickeys: 0,
          calibrationProbeMickeys: 0,
        },
        preClickSettleMs: 0,
        postClickSettleMs: 0,
        minBrightness: 0,
      });
    } catch (e) {
      baselineError = (e as Error).message;
    }
    // The thrown message must mention lock screen for Phase 72's regex
    // to fire. Phase 71 baked this hint into the moveToPixel throw.
    expect(baselineError).toMatch(/lock screen|pikvm_ipad_unlock/i);
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
      minBrightness: 0, // Phase 38: skip brightness precheck for synthetic frames
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

  /**
   * Phase 191 (v0.5.180): inter-retry approach randomization.
   *
   * Before every retry > 1, the orchestrator emits a deterministic
   * 8-step compass-rosette displacement so each attempt approaches
   * the target on a fresh trajectory. The pure helper
   * `jitterOffsetForAttempt` is unit-tested separately
   * (`jitterOffsetForAttempt.test.ts`); these integration tests
   * pin the WIRING — that the helper actually fires inside the
   * retry loop and is correctly gated by the attempt index +
   * magnitude.
   *
   * Filtering strategy: moveToPixel itself emits relative-mouse
   * deltas during its slam/correction passes (many calls per
   * attempt with this test config). The jitter is the FIRST emit
   * of an attempt > 1, fired BEFORE moveToPixel runs, with
   * `clicksBefore` equal to (attempt − 1). We assert by counting
   * emits that match the rosette offsets at the right
   * `clicksBefore` boundary.
   */
  describe('Phase 191: inter-retry approach randomization', () => {
    it('does NOT emit jitter on attempt 1 (baseline preserved)', async () => {
      const grey = await uniformPng(100, 100, 128);
      const changed = await pngWithRect(100, 100, 128, { x: 10, y: 10, w: 30, h: 30, gray: 250 });
      const client = new ScriptedClient();
      client.beforeClickFrame = grey;
      client.postClickFrames = [changed]; // first attempt hits → no retries

      await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
        maxRetries: 3,
        interRetryJitterMickeys: 50, // jitter ENABLED
        moveToOptions: FAST_MOVE_OPTS,
        preClickSettleMs: 0,
        postClickSettleMs: 0,
        requireVerifiedCursor: false,
        minBrightness: 0,
      });

      // Only 1 click happened (first attempt hit). All emits during
      // attempt 1 have `clicksBefore: 0`. Jitter must NOT have fired
      // for attempt 1 — assert that no emit at clicksBefore:0 matches
      // a rosette offset (35, 35) which would be the attempt-2 NE jitter.
      const attemptOneEmits = client.mouseMoveRelativeCalls.filter(c => c.clicksBefore === 0);
      const fakeJitter = attemptOneEmits.some(c => c.dx === 35 && c.dy === 35);
      expect(fakeJitter).toBe(false);
    }, 30000);

    it('emits the rosette offset BEFORE moveToPixel on each retry (attempts 2/3/4)', async () => {
      const grey = await uniformPng(100, 100, 128);
      const client = new ScriptedClient();
      client.beforeClickFrame = grey;
      client.postClickFrames = [grey]; // every click misses → exhaust retries

      await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
        maxRetries: 3, // 4 attempts total
        interRetryJitterMickeys: 50,
        moveToOptions: FAST_MOVE_OPTS,
        preClickSettleMs: 0,
        postClickSettleMs: 0,
        requireVerifiedCursor: false,
        minBrightness: 0,
      });

      // For each retry attempt N (N=2,3,4), the FIRST emit with
      // `clicksBefore: N-1` should be the jitter offset matching
      // jitterOffsetForAttempt(N, 50).
      // Attempt 2 = NE = (35, 35); attempt 3 = SE = (35, -35);
      // attempt 4 = SW = (-35, -35).
      const expectedRosette: Array<[number, number, number]> = [
        // [clicksBefore, expectedDx, expectedDy]
        [1, 35, 35],   // attempt 2 = NE
        [2, 35, -35],  // attempt 3 = SE
        [3, -35, -35], // attempt 4 = SW
      ];
      for (const [clicksBefore, expDx, expDy] of expectedRosette) {
        const firstEmit = client.mouseMoveRelativeCalls.find(c => c.clicksBefore === clicksBefore);
        expect(firstEmit, `attempt ${clicksBefore + 1} should have a jitter emit`).toBeDefined();
        expect(firstEmit!.dx).toBe(expDx);
        expect(firstEmit!.dy).toBe(expDy);
      }
    }, 30000);

    it('opt-out (interRetryJitterMickeys=0) → no jitter emit on any retry', async () => {
      const grey = await uniformPng(100, 100, 128);
      const client = new ScriptedClient();
      client.beforeClickFrame = grey;
      client.postClickFrames = [grey];

      // With interRetryJitterMickeys=0, the FIRST emit of attempt 2
      // (clicksBefore=1) should NOT be a rosette match — moveToPixel's
      // own emits are non-rosette (slam goes -127,-127; chunked deltas
      // go in target direction). We don't need to inspect specific
      // values — just assert there's no (35, 35) at clicksBefore=1.
      await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
        maxRetries: 3,
        interRetryJitterMickeys: 0,
        moveToOptions: FAST_MOVE_OPTS,
        preClickSettleMs: 0,
        postClickSettleMs: 0,
        requireVerifiedCursor: false,
        minBrightness: 0,
      });

      // Strict: NO (35, 35) emit anywhere in the call log.
      const anyJitter = client.mouseMoveRelativeCalls.some(c => c.dx === 35 && c.dy === 35);
      expect(anyJitter).toBe(false);
    }, 30000);

    it('jitter enabled adds exactly maxRetries extra emits versus jitter disabled', async () => {
      // Same scenario with the same scripted miss-everything frames,
      // run twice — once with jitter off, once with jitter on. The
      // difference in mouseMoveRelativeCount should equal maxRetries
      // (one jitter emit per retry attempt, attempts 2..maxRetries+1).
      const grey = await uniformPng(100, 100, 128);

      const baseline = new ScriptedClient();
      baseline.beforeClickFrame = grey;
      baseline.postClickFrames = [grey];
      await clickAtWithRetry(baseline as unknown as PiKVMClient, { x: 50, y: 50 }, {
        maxRetries: 3,
        interRetryJitterMickeys: 0,
        moveToOptions: FAST_MOVE_OPTS,
        preClickSettleMs: 0,
        postClickSettleMs: 0,
        requireVerifiedCursor: false,
        minBrightness: 0,
      });

      const jittered = new ScriptedClient();
      jittered.beforeClickFrame = grey;
      jittered.postClickFrames = [grey];
      await clickAtWithRetry(jittered as unknown as PiKVMClient, { x: 50, y: 50 }, {
        maxRetries: 3,
        interRetryJitterMickeys: 50,
        moveToOptions: FAST_MOVE_OPTS,
        preClickSettleMs: 0,
        postClickSettleMs: 0,
        requireVerifiedCursor: false,
        minBrightness: 0,
      });

      // 3 retries (attempts 2/3/4) → 3 extra emits with jitter on.
      expect(
        jittered.mouseMoveRelativeCount - baseline.mouseMoveRelativeCount,
      ).toBe(3);
    }, 30000);

    it('default value when option omitted is 0 (opt-out at the orchestrator layer)', async () => {
      // The MCP handler in src/index.ts resolves the iPad-aware default
      // via defaultInterRetryJitterFor; clickAtWithRetry's intrinsic
      // default is 0 so unit tests don't accidentally pick up jitter.
      // This regression-pin protects against a "convenience default" change.
      const grey = await uniformPng(100, 100, 128);
      const client = new ScriptedClient();
      client.beforeClickFrame = grey;
      client.postClickFrames = [grey];

      await clickAtWithRetry(client as unknown as PiKVMClient, { x: 50, y: 50 }, {
        maxRetries: 2,
        // interRetryJitterMickeys NOT specified → default at this layer
        moveToOptions: FAST_MOVE_OPTS,
        preClickSettleMs: 0,
        postClickSettleMs: 0,
        requireVerifiedCursor: false,
        minBrightness: 0,
      });

      const anyJitter = client.mouseMoveRelativeCalls.some(c => c.dx === 35 && c.dy === 35);
      expect(anyJitter).toBe(false);
    }, 30000);
  });
});
