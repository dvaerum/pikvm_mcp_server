/**
 * Tests for sleep() — trivial but pins the contract that callers
 * (e.g. settle delays in cursor-detect, move-to) rely on:
 *  - returns a Promise
 *  - resolves to undefined after ≥ ms
 *  - the timer is cancellable via fake-timer control
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { sleep } from '../util.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('sleep', () => {
  it('returns a Promise', () => {
    vi.useFakeTimers();
    const p = sleep(0);
    expect(p).toBeInstanceOf(Promise);
    vi.runAllTimers();
    return p;
  });

  it('resolves to undefined', async () => {
    vi.useFakeTimers();
    const p = sleep(10);
    vi.advanceTimersByTime(10);
    await expect(p).resolves.toBeUndefined();
  });

  it('does not resolve before the requested duration has elapsed', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = sleep(100).then(() => { resolved = true; });
    vi.advanceTimersByTime(50);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(50);
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves correctly under real timers for small durations', async () => {
    const start = Date.now();
    await sleep(20);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15); // small CI jitter tolerance
  });
});
