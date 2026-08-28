/**
 * End-to-end pin: measureBallistics's "reset: slam to top-left" step still
 * fires a real, non-zero slam after the 2026-08-24 cursor-anchor.ts
 * migration (Phase 3 PR 3/3).
 *
 * Replaces measureBallistics.slamPace.test.ts and
 * measureBallistics.slamCalls.test.ts, both deleted in this migration:
 * their entire premise was pinning MeasureBallisticsOptions.slamPaceMs/
 * slamCalls not drifting from slamToCorner's own default — fields that no
 * longer exist on the interface at all (anchorCursor owns them now,
 * unconditionally; there's nothing left to drift). The bug those tests
 * guarded (measureBallistics silently defaulting the slam to zero calls,
 * or to a pace that competed with slamToCorner's own) is now structurally
 * impossible rather than merely fixed. This file instead pins the thing
 * that's still a real regression risk after the migration: that the slam
 * happens at all, with the same resolution-derived call count
 * slamToCorner has always auto-computed. cursor-anchor.test.ts covers the
 * anchorCursor primitive itself in isolation; this covers the real
 * measureBallistics → measureCell → anchorCursor → slamToCorner wiring
 * end-to-end.
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

describe('measureBallistics slam (post cursor-anchor.ts migration)', () => {
  it('default options still produce a real, non-zero slam count matching slamToCorner\'s resolution-derived default', async () => {
    const client = new FakeClient();

    await measureBallistics(client as unknown as PiKVMClient, {
      magnitudes: [5],
      paces: ['fast'],
      axes: ['x'],
      reps: 1,
      noiseFrames: 1,
    });

    // 400x300 resolution → ceil(400/100) + 8 = 12 (slamToCorner's own
    // auto-computed default — unchanged by the migration, just now reached
    // via anchorCursor instead of a direct call).
    expect(countLeadingSlamMoves(client.moveCalls)).toBe(12);
  });
});
