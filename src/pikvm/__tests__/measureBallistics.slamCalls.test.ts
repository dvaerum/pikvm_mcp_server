/**
 * Regression test for the slamCalls sibling of the slamPace bug (see
 * measureBallistics.slamPace.test.ts): measureBallistics used to default
 * slamCalls to the literal 0 as an "auto" sentinel, but slamToCorner
 * resolves it via `options.calls ?? auto`, and `0 ?? auto` is `0` — 0 is
 * not nullish — so under default options the slam-to-corner loop ran ZERO
 * times, always. Not intermittent: every real production call (the MCP
 * tool handler never exposes slamCalls) hit this, so measureBallistics's
 * documented "Reset: slam to top-left" step was a complete no-op.
 *
 * Fix: measureBallistics now threads userOptions.slamCalls through as
 * `undefined` when unset, instead of substituting the literal 0, so
 * slamToCorner's own auto-computed call count (based on screen resolution)
 * is the single source of truth.
 *
 * `mouseMoveRelative` calls are recorded directly (no need to mock sleep
 * here — paceMs:0-equivalent isn't set, but call COUNT doesn't depend on
 * timing, so the real sleep is fine to let run at pace 0 via explicit
 * override in one case, and the resolution-derived default in the other).
 * Both tests use a small resolution and slamPaceMs:0 so real sleeps don't
 * slow the test down.
 */
import { describe, expect, it } from 'vitest';
import { measureBallistics } from '../ballistics.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

class FakeClient {
  resolution: ScreenResolution = { width: 400, height: 300 };
  moveCalls: Array<{ dx: number; dy: number }> = [];

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    this.moveCalls.push({ dx, dy });
  }

  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    // Uniform blank frame: no cursor cluster will ever be detected, so
    // every cell is rejected. Fine here — we only care about the slam
    // call count, not whether a sample is accepted.
    const sharp = (await import('sharp')).default;
    const buf = await sharp(
      Buffer.alloc(this.resolution.width * this.resolution.height * 3),
      { raw: { width: this.resolution.width, height: this.resolution.height, channels: 3 } },
    ).png().toBuffer();
    return { buffer: buf, screenshotWidth: this.resolution.width, screenshotHeight: this.resolution.height };
  }
}

/** Count the leading run of 127-mickey top-left slam moves (-127,-127). */
function countLeadingSlamMoves(moves: Array<{ dx: number; dy: number }>): number {
  let n = 0;
  for (const m of moves) {
    if (m.dx === -127 && m.dy === -127) n++;
    else break;
  }
  return n;
}

describe('measureBallistics slam calls default', () => {
  it('default options produce a real, non-zero slam count (was silently 0)', async () => {
    const client = new FakeClient();

    await measureBallistics(client as unknown as PiKVMClient, {
      magnitudes: [5],
      paces: ['fast'],
      axes: ['x'],
      reps: 1,
      noiseFrames: 1,
      slamPaceMs: 0, // keep the test fast; unrelated to the slamCalls bug
    });

    // 400x300 resolution → ceil(400/100) + 8 = 12 (slamToCorner's own
    // auto-computed default, per the previously-fixed sentinel below).
    const slamCalls = countLeadingSlamMoves(client.moveCalls);
    expect(slamCalls).toBe(12);
  });

  it('an explicit slamCalls override still reaches slamToCorner', async () => {
    const client = new FakeClient();

    await measureBallistics(client as unknown as PiKVMClient, {
      magnitudes: [5],
      paces: ['fast'],
      axes: ['x'],
      reps: 1,
      noiseFrames: 1,
      slamPaceMs: 0,
      slamCalls: 5,
    });

    const slamCalls = countLeadingSlamMoves(client.moveCalls);
    expect(slamCalls).toBe(5);
  });
});
