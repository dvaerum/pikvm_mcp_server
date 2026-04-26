/**
 * Direct unit tests for slamToCorner and nudgeFromEdge. Both have
 * load-bearing details that are easy to silently regress:
 * - slamToCorner's default 60 ms pace prevents iPadOS from
 *   misinterpreting the slam as a system gesture (observed live:
 *   28x @ 15ms slam locked the iPad).
 * - cornerVector direction logic — wrong sign = slam goes the
 *   wrong way and mis-anchors every subsequent move.
 */

import { describe, expect, it } from 'vitest';
import { slamToCorner, nudgeFromEdge } from '../ballistics.js';
import type { PiKVMClient } from '../client.js';

interface RecordedMove {
  dx: number;
  dy: number;
}

function mockClient(resolution = { width: 1920, height: 1080 }) {
  const moves: RecordedMove[] = [];
  const client = {
    async mouseMoveRelative(dx: number, dy: number): Promise<void> {
      moves.push({ dx, dy });
    },
    async getResolution(): Promise<typeof resolution> {
      return resolution;
    },
  } as unknown as PiKVMClient;
  return { client, moves };
}

describe('slamToCorner', () => {
  it('emits 127-mickey deltas in the corner direction (top-left default)', async () => {
    const m = mockClient();
    await slamToCorner(m.client, { paceMs: 0 }); // pace 0 keeps test fast
    expect(m.moves.length).toBeGreaterThan(0);
    // top-left = (-1, -1), so each delta is (-127, -127).
    for (const move of m.moves) {
      expect(move.dx).toBe(-127);
      expect(move.dy).toBe(-127);
    }
  });

  it('top-right direction = (+127, -127) per call', async () => {
    const m = mockClient();
    await slamToCorner(m.client, { corner: 'top-right', paceMs: 0 });
    for (const move of m.moves) {
      expect(move.dx).toBe(127);
      expect(move.dy).toBe(-127);
    }
  });

  it('bottom-right direction = (+127, +127) per call', async () => {
    const m = mockClient();
    await slamToCorner(m.client, { corner: 'bottom-right', paceMs: 0 });
    for (const move of m.moves) {
      expect(move.dx).toBe(127);
      expect(move.dy).toBe(127);
    }
  });

  it('bottom-left direction = (-127, +127) per call', async () => {
    const m = mockClient();
    await slamToCorner(m.client, { corner: 'bottom-left', paceMs: 0 });
    for (const move of m.moves) {
      expect(move.dx).toBe(-127);
      expect(move.dy).toBe(127);
    }
  });

  it('default call count scales with screen resolution', async () => {
    // 1920×1080 → max=1920, calls = ceil(1920/100) + 8 = 20 + 8 = 28.
    const m = mockClient({ width: 1920, height: 1080 });
    await slamToCorner(m.client, { paceMs: 0 });
    expect(m.moves).toHaveLength(28);
  });

  it('larger screen → more calls', async () => {
    const m = mockClient({ width: 3840, height: 2160 });
    await slamToCorner(m.client, { paceMs: 0 });
    // ceil(3840/100) + 8 = 39 + 8 = 47.
    expect(m.moves).toHaveLength(47);
  });

  it('custom call count honoured', async () => {
    const m = mockClient();
    await slamToCorner(m.client, { calls: 10, paceMs: 0 });
    expect(m.moves).toHaveLength(10);
  });
});

describe('nudgeFromEdge', () => {
  it('away from top-left = away direction (+x, +y)', async () => {
    const m = mockClient();
    await nudgeFromEdge(m.client, { away: 'top-left', paceMs: 0 });
    for (const move of m.moves) {
      expect(move.dx).toBe(127);
      expect(move.dy).toBe(127);
    }
  });

  it('away from bottom-right = (-127, -127)', async () => {
    const m = mockClient();
    await nudgeFromEdge(m.client, { away: 'bottom-right', paceMs: 0 });
    for (const move of m.moves) {
      expect(move.dx).toBe(-127);
      expect(move.dy).toBe(-127);
    }
  });

  it('default 5 calls', async () => {
    const m = mockClient();
    await nudgeFromEdge(m.client, { paceMs: 0 });
    expect(m.moves).toHaveLength(5);
  });

  it('onlyAxis="x" zeroes Y component', async () => {
    const m = mockClient();
    await nudgeFromEdge(m.client, { away: 'top-left', onlyAxis: 'x', paceMs: 0 });
    for (const move of m.moves) {
      expect(move.dx).toBe(127);
      expect(move.dy).toBe(0);
    }
  });

  it('onlyAxis="y" zeroes X component', async () => {
    const m = mockClient();
    await nudgeFromEdge(m.client, { away: 'top-left', onlyAxis: 'y', paceMs: 0 });
    for (const move of m.moves) {
      expect(move.dx).toBe(0);
      expect(move.dy).toBe(127);
    }
  });
});
