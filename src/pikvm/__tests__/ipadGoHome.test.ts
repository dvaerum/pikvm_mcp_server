/**
 * Direct unit tests for ipadGoHome. Sends Cmd+H to dismiss the
 * foreground app, sleeps a settle interval, then captures a
 * screenshot. ipad-unlock.ts had no test coverage; pinning this
 * specific shortcut sequence is important because:
 * - Wrong keys would not dismiss the app (silent failure)
 * - Settle too short might capture a frame mid-animation
 */

import { describe, expect, it, vi } from 'vitest';
import { ipadGoHome } from '../ipad-unlock.js';
import type { PiKVMClient } from '../client.js';

interface RecordedShortcut {
  keys: string[];
  ts: number;
}

function mockClient() {
  const shortcuts: RecordedShortcut[] = [];
  const clicks: { button: string; state: boolean | undefined }[] = [];
  const moves: { dx: number; dy: number }[] = [];
  let screenshotCalls = 0;
  const fakeShot = {
    buffer: Buffer.from('fake-jpeg-bytes'),
    screenshotWidth: 1920,
    screenshotHeight: 1080,
    actualWidth: 1920,
    actualHeight: 1080,
    scaleX: 1,
    scaleY: 1,
  };
  const client = {
    async sendShortcut(keys: string[]): Promise<void> {
      shortcuts.push({ keys: [...keys], ts: Date.now() });
    },
    async screenshot(): Promise<typeof fakeShot> {
      screenshotCalls++;
      return fakeShot;
    },
    async mouseMoveRelative(dx: number, dy: number): Promise<void> {
      moves.push({ dx, dy });
    },
    async mouseClick(button: string, opts?: { state?: boolean }): Promise<void> {
      clicks.push({ button, state: opts?.state });
    },
    async getResolution(): Promise<{ width: number; height: number }> {
      return { width: 1920, height: 1080 };
    },
    // Phase 192-B belief wiring — present so methods exist; no-op for tests.
    belief: { reset() {}, predict() {}, observe() { return true; } },
    observeCursor() { return true; },
    resetBelief() {},
  } as unknown as PiKVMClient;
  return {
    client,
    shortcuts,
    clicks,
    moves,
    getScreenshotCalls: () => screenshotCalls,
    fakeShot,
  };
}

describe('ipadGoHome', () => {
  it('sends Cmd+H (MetaLeft + KeyH) to dismiss the foreground app', async () => {
    const m = mockClient();
    await ipadGoHome(m.client, { settleMs: 0 });
    expect(m.shortcuts).toHaveLength(1);
    expect(m.shortcuts[0].keys).toEqual(['MetaLeft', 'KeyH']);
  });

  it('captures a screenshot after the shortcut', async () => {
    const m = mockClient();
    await ipadGoHome(m.client, { settleMs: 0 });
    expect(m.getScreenshotCalls()).toBe(1);
  });

  it('returns the captured screenshot buffer + dimensions', async () => {
    const m = mockClient();
    const result = await ipadGoHome(m.client, { settleMs: 0 });
    expect(result.screenshot).toBe(m.fakeShot.buffer);
    expect(result.screenshotWidth).toBe(1920);
    expect(result.screenshotHeight).toBe(1080);
  });

  it('default settleMs is 800 ms', async () => {
    vi.useFakeTimers();
    const m = mockClient();
    const promise = ipadGoHome(m.client);
    // Resolve any pending async (sendShortcut, sleep, screenshot)
    await vi.advanceTimersByTimeAsync(800);
    await promise;
    vi.useRealTimers();
    expect(m.shortcuts).toHaveLength(1);
    expect(m.getScreenshotCalls()).toBe(1);
  });

  it('honours custom settleMs', async () => {
    vi.useFakeTimers();
    const m = mockClient();
    const promise = ipadGoHome(m.client, { settleMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    await promise;
    vi.useRealTimers();
    expect(m.shortcuts).toHaveLength(1);
  });

  it('returns a non-empty message warning that Cmd+H does not unlock', async () => {
    const m = mockClient();
    const result = await ipadGoHome(m.client, { settleMs: 0 });
    expect(result.message).toContain('Cmd+H');
    // The contract: clarify that this does NOT unlock from the lock screen.
    expect(result.message.toLowerCase()).toContain('unlock');
  });

  // Phase 214 (v0.5.202)
  describe('forceHomeViaSwipe', () => {
    it('default false: only Cmd+H is sent; no mouse activity', async () => {
      const m = mockClient();
      await ipadGoHome(m.client, { settleMs: 0 });
      expect(m.shortcuts).toHaveLength(1);
      expect(m.clicks).toHaveLength(0);
      expect(m.moves).toHaveLength(0);
    });

    it('true: Cmd+H followed by slam + mouse-down + upward drag + mouse-up', async () => {
      const m = mockClient();
      await ipadGoHome(m.client, { settleMs: 0, forceHomeViaSwipe: true });
      // Cmd+H still sent first.
      expect(m.shortcuts).toHaveLength(1);
      expect(m.shortcuts[0].keys).toEqual(['MetaLeft', 'KeyH']);
      // Mouse-down then mouse-up bracketing the drag.
      expect(m.clicks.length).toBeGreaterThanOrEqual(2);
      expect(m.clicks[0]).toEqual({ button: 'left', state: true });
      expect(m.clicks[m.clicks.length - 1]).toEqual({ button: 'left', state: false });
      // Some upward (negative-y) motion happened during the drag.
      const upward = m.moves.filter((mv) => mv.dy < 0);
      expect(upward.length).toBeGreaterThan(0);
    });

    it('true: message records that the swipe was performed', async () => {
      const m = mockClient();
      const result = await ipadGoHome(m.client, { settleMs: 0, forceHomeViaSwipe: true });
      expect(result.message.toLowerCase()).toContain('swipe');
      expect(result.message.toLowerCase()).toContain('app switcher');
    });

    it('respects custom swipeDragPx', async () => {
      const m = mockClient();
      await ipadGoHome(m.client, { settleMs: 0, forceHomeViaSwipe: true, swipeDragPx: 600 });
      // Sum of negative-dy contributions during the drag should ≈ -600.
      // (Positioning emits before the drag are positive-y; only count emits
      // after the first state:true mouseClick.)
      const downIdx = m.clicks.findIndex((c) => c.state === true);
      // Positioning moves come BEFORE the mouseClick; drag moves come AFTER.
      // Approximate: total negative dy across ALL moves >= -swipeDragPx.
      const totalUpward = m.moves.reduce((s, mv) => s + Math.min(0, mv.dy), 0);
      expect(downIdx).toBeGreaterThanOrEqual(0);
      expect(totalUpward).toBeLessThanOrEqual(-600);
    });
  });
});
