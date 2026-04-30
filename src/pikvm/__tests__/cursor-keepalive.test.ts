/**
 * Phase 187 (v0.5.177): keepalive wiggle.
 *
 * iPadOS auto-hides the cursor after ~1 s of inactivity. When a
 * cursor-detection screenshot is taken during the fade window, the
 * frame contains no cursor pixels — motion-diff sees no clusters,
 * template-match returns garbage scores. Existing wakeupCursor (Phase
 * 5) wakes the cursor at origin discovery time, but later phases
 * (post-moveToPixel pre-click verification, micro-correction iteration
 * after a long settle, pre-click template-match) take fresh
 * screenshots that may land in the fade window.
 *
 * The keepalive helper tracks the timestamp of the last mouse emit
 * (recorded by `recordEmit()`, called from `client.mouseMoveRelative`
 * and other emit sites) and only wiggles when the elapsed gap exceeds
 * `staleThresholdMs`. This makes the helper cheap when called in tight
 * detection loops (no wiggle if a recent emit already woke the cursor)
 * and effective when called after a long settle/return path.
 *
 * Contract pinned by the tests below:
 *   - recordEmit() updates the module-level last-emit timestamp.
 *   - keepCursorAlive() is a no-op when elapsed < staleThresholdMs.
 *   - keepCursorAlive() emits a +1/-1 round-trip wiggle when stale.
 *   - The wiggle nets zero displacement (no drift on repeat calls).
 *   - Test seam: resetKeepaliveForTest() lets each test start clean.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keepCursorAlive,
  recordEmit,
  resetKeepaliveForTest,
  shouldWiggle,
} from '../cursor-keepalive.js';
import type { PiKVMClient } from '../client.js';

interface RecordedCall {
  dx: number;
  dy: number;
  ts: number;
}

function mockClient(): { client: PiKVMClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client = {
    async mouseMoveRelative(dx: number, dy: number): Promise<void> {
      calls.push({ dx, dy, ts: Date.now() });
    },
  } as unknown as PiKVMClient;
  return { client, calls };
}

beforeEach(() => {
  resetKeepaliveForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shouldWiggle (pure)', () => {
  it('returns false when no emit has been recorded yet (avoid wiggling on a fresh process)', () => {
    expect(shouldWiggle({ lastEmitMs: null, nowMs: 1000, staleThresholdMs: 700 })).toBe(false);
  });

  it('returns false when elapsed < threshold (recent emit woke the cursor already)', () => {
    expect(shouldWiggle({ lastEmitMs: 1000, nowMs: 1500, staleThresholdMs: 700 })).toBe(false);
  });

  it('returns false at exactly the threshold (boundary; conservative — only wiggle when STRICTLY stale)', () => {
    expect(shouldWiggle({ lastEmitMs: 1000, nowMs: 1700, staleThresholdMs: 700 })).toBe(false);
  });

  it('returns true when elapsed > threshold (cursor likely faded)', () => {
    expect(shouldWiggle({ lastEmitMs: 1000, nowMs: 1701, staleThresholdMs: 700 })).toBe(true);
  });

  it('returns true on a long gap (1+ second post-detection)', () => {
    expect(shouldWiggle({ lastEmitMs: 1000, nowMs: 3000, staleThresholdMs: 700 })).toBe(true);
  });
});

describe('recordEmit', () => {
  it('records a timestamp that shouldWiggle can read back', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    recordEmit();
    const t0 = Date.now();
    vi.advanceTimersByTime(500);
    expect(shouldWiggle({ lastEmitMs: t0, nowMs: Date.now(), staleThresholdMs: 700 })).toBe(false);
    vi.advanceTimersByTime(300);
    expect(shouldWiggle({ lastEmitMs: t0, nowMs: Date.now(), staleThresholdMs: 700 })).toBe(true);
  });
});

describe('keepCursorAlive', () => {
  it('is a no-op on a fresh process (no recorded emit yet — caller must seed via recordEmit if they want guarding)', async () => {
    const { client, calls } = mockClient();
    await keepCursorAlive(client, { staleThresholdMs: 700, settleMs: 0 });
    expect(calls).toHaveLength(0);
  });

  it('does NOT wiggle when last emit was recent (cursor still visible)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const { client, calls } = mockClient();
    recordEmit();
    vi.advanceTimersByTime(200);
    await keepCursorAlive(client, { staleThresholdMs: 700, settleMs: 0 });
    expect(calls).toHaveLength(0);
  });

  it('wiggles +1/-1 when last emit is stale (cursor likely faded)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const { client, calls } = mockClient();
    recordEmit();
    vi.advanceTimersByTime(1500);
    const promise = keepCursorAlive(client, { staleThresholdMs: 700, settleMs: 0 });
    // Inter-wiggle pause is 30ms; advance past it.
    await vi.advanceTimersByTimeAsync(30);
    await promise;
    expect(calls).toHaveLength(2);
    expect(calls[0].dx).toBe(1);
    expect(calls[0].dy).toBe(0);
    expect(calls[1].dx).toBe(-1);
    expect(calls[1].dy).toBe(0);
  });

  it('the wiggle nets zero displacement (no drift on repeat calls)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const { client, calls } = mockClient();
    recordEmit();
    vi.advanceTimersByTime(1500);
    const promise = keepCursorAlive(client, { staleThresholdMs: 700, settleMs: 0 });
    await vi.advanceTimersByTimeAsync(30);
    await promise;
    const totalDx = calls.reduce((s, c) => s + c.dx, 0);
    const totalDy = calls.reduce((s, c) => s + c.dy, 0);
    expect(totalDx).toBe(0);
    expect(totalDy).toBe(0);
  });

  it('honours the settleMs argument (gives iPadOS time to render the cursor)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const { client } = mockClient();
    recordEmit();
    vi.advanceTimersByTime(1500);
    const promise = keepCursorAlive(client, { staleThresholdMs: 700, settleMs: 250 });
    let resolved = false;
    void promise.then(() => { resolved = true; });
    // Initial wiggle pair: 30 ms inter-pause, then settleMs after.
    await vi.advanceTimersByTimeAsync(30);
    expect(resolved).toBe(false); // still waiting on settle
    await vi.advanceTimersByTimeAsync(249);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await promise;
    expect(resolved).toBe(true);
  });

  it('records its own emit so a follow-up call within threshold is a no-op (wiggle counts as activity)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const { client, calls } = mockClient();
    recordEmit();
    vi.advanceTimersByTime(1500);
    const p1 = keepCursorAlive(client, { staleThresholdMs: 700, settleMs: 0 });
    await vi.advanceTimersByTimeAsync(30);
    await p1;
    expect(calls).toHaveLength(2);
    // Now a quick re-call: should NOT wiggle again (we just woke it).
    vi.advanceTimersByTime(100);
    await keepCursorAlive(client, { staleThresholdMs: 700, settleMs: 0 });
    expect(calls).toHaveLength(2);
  });

  it('disabled via enabled:false is always a no-op even when stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const { client, calls } = mockClient();
    recordEmit();
    vi.advanceTimersByTime(5000);
    await keepCursorAlive(client, { enabled: false, staleThresholdMs: 700, settleMs: 0 });
    expect(calls).toHaveLength(0);
  });

  it('verbose:true logs the wiggle decision (covers the diagnostic branch)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const { client } = mockClient();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    recordEmit();
    vi.advanceTimersByTime(1500);
    const promise = keepCursorAlive(client, { verbose: true, staleThresholdMs: 700, settleMs: 0 });
    await vi.advanceTimersByTimeAsync(30);
    await promise;
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[keepalive] wiggling'));
    errorSpy.mockRestore();
  });
});
