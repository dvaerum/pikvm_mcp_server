/**
 * Direct unit tests for unlockIpad. The function is complex —
 * slam to corner, position cursor, mouse-down, rapid drag, mouse-up,
 * settle, screenshot. The load-bearing contract is the mouse-down /
 * drag / mouse-up sandwich: if the button isn't held during the
 * drag, iPadOS treats it as a hover gesture (App Switcher) instead
 * of a touch drag (unlock).
 */

import { describe, expect, it } from 'vitest';
import { unlockIpad } from '../ipad-unlock.js';
import type { PiKVMClient } from '../client.js';

interface CallRecord {
  type: 'shortcut' | 'move' | 'mouseDown' | 'mouseUp' | 'screenshot' | 'getResolution';
  detail: string;
  dx?: number;
  dy?: number;
}

function mockClient() {
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
    async getResolution() {
      calls.push({ type: 'getResolution', detail: '' });
      return { width: 1920, height: 1080 };
    },
    async screenshot() {
      calls.push({ type: 'screenshot', detail: '' });
      return fakeShot;
    },
  } as unknown as PiKVMClient;
  return { client, calls };
}

describe('unlockIpad', () => {
  it('issues mouse-down BEFORE the drag and mouse-up AFTER (sandwich invariant)', async () => {
    const m = mockClient();
    await unlockIpad(m.client, {
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
    const m = mockClient();
    await unlockIpad(m.client, {
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
  });

  it('slamFirst:false skips slam (no -127, -127 calls)', async () => {
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
    const slamMoves = m.calls.filter(
      (c) => c.type === 'move' && c.dx === -127 && c.dy === -127,
    );
    expect(slamMoves).toHaveLength(0);
  });

  it('returns chunkCount, dragPx, swipeDurationMs in the result', async () => {
    const m = mockClient();
    const r = await unlockIpad(m.client, {
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
});
