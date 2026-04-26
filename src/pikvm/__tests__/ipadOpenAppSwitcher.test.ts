/**
 * Direct unit tests for ipadOpenAppSwitcher. The function presses
 * Cmd, taps Tab, holds Cmd while capturing the App Switcher
 * screenshot, then releases Cmd.
 *
 * The CRITICAL contract is the call ordering: the screenshot MUST
 * happen between the Cmd-down and Cmd-up. If a future refactor
 * accidentally captures the screenshot after releasing Cmd, the
 * App Switcher dismisses before we see it and the function silently
 * returns a screenshot of the launched app (or home screen).
 */

import { describe, expect, it, vi } from 'vitest';
import { ipadOpenAppSwitcher } from '../ipad-unlock.js';
import type { PiKVMClient } from '../client.js';

interface CallRecord {
  type: 'key' | 'screenshot';
  detail: string;
  ts: number;
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
    async sendKey(key: string, options?: { state?: boolean }): Promise<void> {
      const detail = options?.state === undefined
        ? `${key} (tap)`
        : `${key} ${options.state ? 'down' : 'up'}`;
      calls.push({ type: 'key', detail, ts: Date.now() });
    },
    async screenshot(): Promise<typeof fakeShot> {
      calls.push({ type: 'screenshot', detail: '', ts: Date.now() });
      return fakeShot;
    },
  } as unknown as PiKVMClient;
  return { client, calls, fakeShot };
}

describe('ipadOpenAppSwitcher', () => {
  it('issues the Cmd-down → Tab → screenshot → Cmd-up sequence', async () => {
    const m = mockClient();
    await ipadOpenAppSwitcher(m.client, { holdMs: 0 });

    const sequence = m.calls.map((c) => `${c.type}:${c.detail}`);
    expect(sequence).toEqual([
      'key:MetaLeft down',
      'key:Tab (tap)',
      'screenshot:',
      'key:MetaLeft up',
    ]);
  });

  it('captures the screenshot WHILE Cmd is held (not after release)', async () => {
    const m = mockClient();
    await ipadOpenAppSwitcher(m.client, { holdMs: 0 });

    const screenshotIdx = m.calls.findIndex((c) => c.type === 'screenshot');
    const cmdUpIdx = m.calls.findIndex((c) => c.detail === 'MetaLeft up');
    expect(screenshotIdx).toBeGreaterThanOrEqual(0);
    expect(cmdUpIdx).toBeGreaterThanOrEqual(0);
    // Screenshot MUST come before Cmd up — otherwise switcher dismisses.
    expect(screenshotIdx).toBeLessThan(cmdUpIdx);
  });

  it('default holdMs is 800', async () => {
    vi.useFakeTimers();
    const m = mockClient();
    const promise = ipadOpenAppSwitcher(m.client);
    // Walk through: sleep(40) after Cmd-down, then sleep(holdMs=800) after Tab.
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(800);
    await promise;
    vi.useRealTimers();
    expect(m.calls).toHaveLength(4);
  });

  it('honours custom holdMs', async () => {
    vi.useFakeTimers();
    const m = mockClient();
    const promise = ipadOpenAppSwitcher(m.client, { holdMs: 1500 });
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(1500);
    await promise;
    vi.useRealTimers();
    expect(m.calls).toHaveLength(4);
  });

  it('returns the screenshot from the App Switcher (the one captured mid-hold)', async () => {
    const m = mockClient();
    const result = await ipadOpenAppSwitcher(m.client, { holdMs: 0 });
    expect(result.screenshot).toBe(m.fakeShot.buffer);
    expect(result.screenshotWidth).toBe(1920);
    expect(result.screenshotHeight).toBe(1080);
  });

  it('returns a non-empty message describing the App Switcher state', async () => {
    const m = mockClient();
    const result = await ipadOpenAppSwitcher(m.client, { holdMs: 0 });
    expect(result.message).toContain('App Switcher');
  });
});
