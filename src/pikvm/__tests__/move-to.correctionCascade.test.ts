/**
 * N1 (Round 2 Phase 5) — the mover correction-loop bug.
 *
 * The ML-recovery branch inside moveToPixel's correction-pass fallback
 * cascade (motion-diff → template-match → ML → shape) set
 * `templated = true` on a successful ML recovery, then immediately
 * `break`. That `break` was a direct child of the outer `while (true)`
 * correction loop, not scoped to any inner loop — it exited the ENTIRE
 * correction process right there, before the pass-completion bookkeeping
 * (corrections.push, diagnostics.push, totalPasses++, the blind-pass
 * circuit breaker, the oscillation guard) ever ran for that pass. The
 * sibling shape-success branch ~45 lines later handles the identical
 * situation correctly: its own `break` is scoped to the INNER
 * `for (const c of cands)` candidate loop, so control already fell
 * through to the shared pass-completion code below.
 *
 * git archaeology (manager's ruling): the block + its break landed
 * atomically in one commit (0456943, "wire ML detector as PRIMARY") with
 * zero rationale ever recorded, and no test had ever reached this branch.
 * Confirmed a genuine bug, not an intentional early-exit — fix: delete
 * the outer break (templated=true already guards the correct
 * fall-through, matching the shape branch).
 *
 * Both tests force real, nonzero residuals into the correction loop via
 * screen-edge CLAMPING (a huge target near the far corner from the slam
 * origin makes the open-loop's own planned emit exceed the screen, so
 * `clampMickeysToScreen` truncates it — giving a genuine residual to
 * correct without needing any real motion-diff/template pixel content;
 * the frame itself stays a uniform black no-clusters image throughout).
 */

import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { moveToPixel } from '../move-to.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

const { findCursorByMLMultiHintMock } = vi.hoisted(() => ({
  findCursorByMLMultiHintMock: vi.fn(),
}));
const { findCursorByShapeMock } = vi.hoisted(() => ({
  findCursorByShapeMock: vi.fn(),
}));

vi.mock('../cursor-ml-detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cursor-ml-detect.js')>();
  return { ...actual, findCursorByMLMultiHint: findCursorByMLMultiHintMock };
});
vi.mock('../cursor-shape-detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cursor-shape-detect.js')>();
  return { ...actual, findCursorByShape: findCursorByShapeMock };
});

/** Uniform black frame: motion-diff finds no clusters, template-match has
 *  nothing to match — both correction-pass detectors fail on every pass,
 *  forcing the fallback cascade all the way to ML/shape. Same trick as
 *  move-to.verificationLag.test.ts's BlackFrameClient. */
class BlackFrameClient {
  resolution: ScreenResolution = { width: 1920, height: 1080 };

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }
  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    const buf = await sharp(
      Buffer.alloc(this.resolution.width * this.resolution.height * 3),
      { raw: { width: this.resolution.width, height: this.resolution.height, channels: 3 } },
    ).png().toBuffer();
    return { buffer: buf, screenshotWidth: this.resolution.width, screenshotHeight: this.resolution.height };
  }
  async screenshotKeepingCursorAlive(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    return this.screenshot();
  }
  async mouseMoveRelative(_dx: number, _dy: number): Promise<void> {
    /* no-op */
  }
}

// Far-corner target relative to the slam origin (near top-left) forces the
// open-loop's planned emit to exceed the screen, so clampMickeysToScreen
// truncates it — a genuine residual to correct, no real cursor pixels needed.
const FAR_CORNER_TARGET = { x: 1900, y: 1070 };

const baseOptions = {
  strategy: 'slam-then-move' as const, // skip detect-origin; go straight to open-loop + corrections
  forbidSlamFallback: false,
  forbidSlamOnIpad: false, // synthetic black frame is ambiguous; opt out of the Phase 32a guard
  warmupMickeys: 0,
  calibrationProbeMickeys: 0,
  postMoveSettleMs: 0,
};

describe('moveToPixel correction cascade — ML/shape recovery symmetry (N1 fix)', () => {
  it('FIXED: an ML-recovered pass now appears in corrections/diagnostics (mode "shape")', async () => {
    findCursorByMLMultiHintMock.mockResolvedValue({ x: 5, y: 5, confidence: 0.9, crop: { left: 0, top: 0 } });
    findCursorByShapeMock.mockReturnValue(null); // never reached — ML recovers first

    const client = new BlackFrameClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, FAR_CORNER_TARGET, baseOptions);

    expect(findCursorByMLMultiHintMock).toHaveBeenCalled();
    const mlPasses = result.corrections.filter((c) => c.mode === 'shape' && c.reason?.includes('ML'));
    expect(mlPasses.length).toBeGreaterThan(0);
    expect(result.diagnostics.filter((d) => d.mode === 'shape').length).toBeGreaterThan(0);
  }, 30000);

  it('SYMMETRY: ML-success and shape-success both fall through — neither early-exits the correction loop', async () => {
    // ML fails every time; shape's initial (radius-100) search finds a
    // candidate, and its wiggle-verify re-check (radius-8, "is it still at
    // the wiggled-away position?") finds nothing there → confirmed real,
    // wiggleVerifyCandidate returns truthy.
    findCursorByMLMultiHintMock.mockResolvedValue(null);
    findCursorByShapeMock.mockImplementation((_rgb: Buffer, _w: number, _h: number, options?: { expectedNearRadius?: number }) => {
      if (options?.expectedNearRadius === 100) {
        return { centroidX: 10, centroidY: 10, pixels: 40, shapeScore: 0.6 };
      }
      return null; // wiggleVerifyCandidate's stillThere/brightStill checks (radius 8)
    });

    const client = new BlackFrameClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, FAR_CORNER_TARGET, baseOptions);

    expect(findCursorByShapeMock).toHaveBeenCalled();
    const shapePasses = result.corrections.filter((c) => c.mode === 'shape');
    expect(shapePasses.length).toBeGreaterThan(0);
    // The shape branch was never buggy — this pins that it (still) behaves
    // the same way the fixed ML branch now does: recorded, loop continues.
    expect(result.diagnostics.filter((d) => d.mode === 'shape').length).toBe(shapePasses.length);
  }, 30000);
});
