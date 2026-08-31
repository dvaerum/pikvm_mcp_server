/**
 * Unit tests for moveToPixelAbsolute and moveToPixel's new mouseAbsolute
 * dispatch branch — TS port of the Rust design's §4 testing plan
 * (rust/mover/src/move_to/absolute_move/tests.rs), per
 * docs/move-to-pixel-absolute-mode-fix-design.md.
 */

import { describe, expect, it } from 'vitest';
import { moveToPixel } from '../move-to.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

class FakeClient {
  absoluteMoves: Array<{ x: number; y: number }> = [];
  relativeMoves: Array<{ dx: number; dy: number }> = [];
  resolution: ScreenResolution = { width: 1920, height: 1080 };

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }
  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    const sharp = (await import('sharp')).default;
    const buf = await sharp(
      Buffer.alloc(this.resolution.width * this.resolution.height * 3),
      { raw: { width: this.resolution.width, height: this.resolution.height, channels: 3 } },
    ).png().toBuffer();
    return { buffer: buf, screenshotWidth: this.resolution.width, screenshotHeight: this.resolution.height };
  }
  async mouseMove(x: number, y: number): Promise<{ calibrationInvalidated: boolean }> {
    this.absoluteMoves.push({ x, y });
    return { calibrationInvalidated: false };
  }
  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    this.relativeMoves.push({ dx, dy });
  }
}

describe('moveToPixel mouseAbsolute dispatch', () => {
  it('routes to the absolute move-then-verify path and never emits a relative HID report', async () => {
    const client = new FakeClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 300 }, {
      mouseAbsolute: true,
      postMoveSettleMs: 0,
    });

    expect(client.absoluteMoves).toHaveLength(1);
    expect(client.absoluteMoves[0]).toEqual({ x: 500, y: 300 });
    expect(client.relativeMoves).toHaveLength(0);
    expect(result.strategy).toBe('absolute-move');
  }, 15_000);

  it('reports MoveStrategy AbsoluteMove and documented sentinel values for relative-mode-only fields', async () => {
    const client = new FakeClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 300 }, {
      mouseAbsolute: true,
      postMoveSettleMs: 0,
    });

    expect(result.strategy).toBe('absolute-move');
    expect(result.emittedMickeys).toEqual({ x: 0, y: 0 });
    expect(result.usedPxPerMickey).toEqual({ x: 0, y: 0 });
    expect(result.chunkCount).toBe(0);
    expect(result.corrections).toEqual([]);
    expect(result.passesSinceLastVerification).toBe(0);
    expect(result.bailedToBestPass).toBe(false);
  }, 15_000);

  it('reports verification failure rather than a false success when no cursor match is found', async () => {
    // No real cursor-template fixtures exist for this test's blank
    // frame, so verification genuinely fails — the real shape of "the
    // move was sent but never landed" this path must surface, not
    // swallow.
    const client = new FakeClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 300 }, {
      mouseAbsolute: true,
      postMoveSettleMs: 0,
    });

    expect(result.finalDetectedPosition).toBeNull();
    expect(result.finalResidualPx).toBeNull();
    expect(result.message).toMatch(/verification failed/);
  }, 15_000);

  it('mouseAbsolute unset/false leaves the existing relative-mode dispatch untouched', async () => {
    const client = new FakeClient();
    // strategy 'assume-at' with an explicit assumeCursorAt is the
    // cheapest way to exercise the legacy path without a real detector.
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 500, y: 300 }, {
      strategy: 'assume-at',
      assumeCursorAt: { x: 400, y: 300 },
      correct: false,
    });

    expect(result.strategy).not.toBe('absolute-move');
    expect(client.absoluteMoves).toHaveLength(0);
  }, 15_000);
});
