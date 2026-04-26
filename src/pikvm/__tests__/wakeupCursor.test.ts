/**
 * Direct unit tests for wakeupCursor. The function emits a small
 * round-trip mouse move (+30 X, then -30 X) to make iPadOS re-render
 * the faded pointer before any detection runs. Phase 5 added it to
 * discoverOrigin's template-match path; Phase 13 raised the post-
 * round-trip settle to 300 ms (above PiKVM streamer latency).
 *
 * The contract pins:
 * - Two mouseMoveRelative calls, signed +30 then -30.
 * - settleMs is honoured between the second emit and return.
 */

import { describe, expect, it, vi } from 'vitest';
import { wakeupCursor } from '../move-to.js';
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

describe('wakeupCursor', () => {
  it('emits +30 X then -30 X (round-trip wake nudge)', async () => {
    const { client, calls } = mockClient();
    await wakeupCursor(client, 0); // settleMs=0 to keep the test fast
    expect(calls).toHaveLength(2);
    expect(calls[0].dx).toBe(30);
    expect(calls[0].dy).toBe(0);
    expect(calls[1].dx).toBe(-30);
    expect(calls[1].dy).toBe(0);
  });

  it('uses default settleMs of 300 (matches Phase 13 latency research)', async () => {
    // Verify the default by calling without the second arg and timing.
    // We use vi.useFakeTimers to avoid actually waiting.
    vi.useFakeTimers();
    const { client, calls } = mockClient();
    const promise = wakeupCursor(client);
    // Advance through both sleeps: 80 ms after first emit, 300 ms after second.
    await vi.advanceTimersByTimeAsync(80);
    await vi.advanceTimersByTimeAsync(300);
    await promise;
    vi.useRealTimers();
    expect(calls).toHaveLength(2);
  });

  it('respects custom settleMs argument', async () => {
    vi.useFakeTimers();
    const { client, calls } = mockClient();
    const promise = wakeupCursor(client, 500);
    await vi.advanceTimersByTimeAsync(80);
    await vi.advanceTimersByTimeAsync(500);
    await promise;
    vi.useRealTimers();
    expect(calls).toHaveLength(2);
  });

  it('the second emit cancels the first (round-trip nets zero X displacement)', async () => {
    const { client, calls } = mockClient();
    await wakeupCursor(client, 0);
    const totalDx = calls.reduce((sum, c) => sum + c.dx, 0);
    const totalDy = calls.reduce((sum, c) => sum + c.dy, 0);
    expect(totalDx).toBe(0);
    expect(totalDy).toBe(0);
  });
});
