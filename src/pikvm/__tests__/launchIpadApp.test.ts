/**
 * Direct unit tests for launchIpadApp. The function opens Spotlight
 * (Cmd+Space), types the app name, presses Enter to launch.
 *
 * Critical contracts:
 * - The shortcut MUST be MetaLeft + Space (not Meta + Space, which
 *   wouldn't dispatch on most iPadOS keyboard layouts).
 * - The sequence is shortcut → type → Enter; reordering breaks.
 * - Empty appName must throw early to avoid sending an empty
 *   Spotlight query that lands somewhere unexpected.
 */

import { describe, expect, it, vi } from 'vitest';
import { launchIpadApp } from '../ipad-unlock.js';
import type { PiKVMClient } from '../client.js';

interface CallRecord {
  type: 'shortcut' | 'type' | 'key' | 'screenshot' | 'getResolution';
  detail: string;
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
    async sendShortcut(keys: string[]): Promise<void> {
      calls.push({ type: 'shortcut', detail: keys.join('+') });
    },
    async type(text: string): Promise<void> {
      calls.push({ type: 'type', detail: text });
    },
    async sendKey(key: string): Promise<void> {
      calls.push({ type: 'key', detail: key });
    },
    async screenshot() {
      calls.push({ type: 'screenshot', detail: '' });
      return fakeShot;
    },
    async getResolution() {
      calls.push({ type: 'getResolution', detail: '' });
      return { width: 1920, height: 1080 };
    },
  } as unknown as PiKVMClient;
  return { client, calls };
}

describe('launchIpadApp', () => {
  it('throws on empty appName', async () => {
    const m = mockClient();
    await expect(launchIpadApp(m.client, '', { unlockFirst: false })).rejects.toThrow(/appName/);
  });

  it('throws on whitespace-only appName', async () => {
    const m = mockClient();
    await expect(launchIpadApp(m.client, '   ', { unlockFirst: false })).rejects.toThrow(/appName/);
  });

  it('issues Cmd+Space → type(appName) → Enter sequence (in that order)', async () => {
    const m = mockClient();
    // Use small settles to keep test fast.
    await launchIpadApp(m.client, 'Settings', {
      unlockFirst: false,
      spotlightSettleMs: 0,
      postTypeSettleMs: 0,
      launchSettleMs: 0,
    });

    const sequence = m.calls.map((c) => `${c.type}:${c.detail}`);
    // Look at the first three meaningful calls (after no unlock).
    expect(sequence.slice(0, 3)).toEqual([
      'shortcut:MetaLeft+Space',
      'type:Settings',
      'key:Enter',
    ]);
  });

  it('captures a screenshot after launch (for caller to verify the right app opened)', async () => {
    const m = mockClient();
    await launchIpadApp(m.client, 'Maps', {
      unlockFirst: false,
      spotlightSettleMs: 0,
      postTypeSettleMs: 0,
      launchSettleMs: 0,
    });
    expect(m.calls.some((c) => c.type === 'screenshot')).toBe(true);
  });

  it('returned result contains the appName + dimensions + message', async () => {
    const m = mockClient();
    const result = await launchIpadApp(m.client, 'Files', {
      unlockFirst: false,
      spotlightSettleMs: 0,
      postTypeSettleMs: 0,
      launchSettleMs: 0,
    });
    expect(result.appName).toBe('Files');
    expect(result.screenshotWidth).toBe(1920);
    expect(result.screenshotHeight).toBe(1080);
    expect(result.message).toContain('Files');
    expect(result.unlocked).toBe(false);
  });

  it('honours custom settle times via fake timers', async () => {
    vi.useFakeTimers();
    const m = mockClient();
    const promise = launchIpadApp(m.client, 'TV', {
      unlockFirst: false,
      spotlightSettleMs: 100,
      postTypeSettleMs: 50,
      launchSettleMs: 200,
    });
    await vi.advanceTimersByTimeAsync(100); // spotlight
    await vi.advanceTimersByTimeAsync(50);  // post-type
    await vi.advanceTimersByTimeAsync(200); // launch
    await promise;
    vi.useRealTimers();
    // Shortcut → type → Enter → screenshot → getResolution
    expect(m.calls.length).toBeGreaterThanOrEqual(5);
  });
});
