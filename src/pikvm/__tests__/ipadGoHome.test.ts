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
  } as unknown as PiKVMClient;
  return {
    client,
    shortcuts,
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
});
