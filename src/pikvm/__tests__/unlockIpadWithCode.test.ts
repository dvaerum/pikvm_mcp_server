/**
 * 2026-06-03 — tests for the keyboard-only passcode unlock recipe.
 * The recipe (user-provided): Space → wait → Space → wait → digits
 * with 100 ms between → Enter.
 *
 * These tests:
 *  - pin the key sequence (Space, Space, Digit*, Enter) and order
 *  - pin that bad input throws BEFORE any HID activity so a partial
 *    passcode never reaches iPadOS's wrong-passcode counter
 *  - confirm the code is not echoed in the result
 */
import { describe, expect, it, vi } from 'vitest';
import { unlockIpadWithCode } from '../ipad-unlock.js';

class CapturingClient {
  keys: string[] = [];
  async sendKey(key: string): Promise<void> {
    this.keys.push(key);
  }
}

describe('unlockIpadWithCode', () => {
  it('sends Space, Space, Digit{n} per digit, then Enter', async () => {
    const client = new CapturingClient();
    const result = await unlockIpadWithCode(client, '1234', {
      wakeWaitMs: 0,
      perDigitMs: 0,
    });
    expect(client.keys).toEqual([
      'Space',
      'Space',
      'Digit1', 'Digit2', 'Digit3', 'Digit4',
      'Enter',
    ]);
    expect(result.digitsSent).toBe(4);
  });

  it('handles a 6-digit passcode', async () => {
    const client = new CapturingClient();
    const result = await unlockIpadWithCode(client, '987654', {
      wakeWaitMs: 0,
      perDigitMs: 0,
    });
    expect(client.keys.slice(2, 8)).toEqual([
      'Digit9', 'Digit8', 'Digit7', 'Digit6', 'Digit5', 'Digit4',
    ]);
    expect(result.digitsSent).toBe(6);
  });

  it('throws on non-digit characters BEFORE any HID activity', async () => {
    const client = new CapturingClient();
    await expect(unlockIpadWithCode(client, '12a4', { wakeWaitMs: 0, perDigitMs: 0 }))
      .rejects.toThrow(/4–10 decimal digits/);
    expect(client.keys).toEqual([]);
  });

  it('throws on too-short code BEFORE any HID activity', async () => {
    const client = new CapturingClient();
    await expect(unlockIpadWithCode(client, '123', { wakeWaitMs: 0, perDigitMs: 0 }))
      .rejects.toThrow(/4–10 decimal digits/);
    expect(client.keys).toEqual([]);
  });

  it('throws on too-long code BEFORE any HID activity', async () => {
    const client = new CapturingClient();
    await expect(unlockIpadWithCode(client, '12345678901', { wakeWaitMs: 0, perDigitMs: 0 }))
      .rejects.toThrow(/4–10 decimal digits/);
    expect(client.keys).toEqual([]);
  });

  it('throws on empty code BEFORE any HID activity', async () => {
    const client = new CapturingClient();
    await expect(unlockIpadWithCode(client, '', { wakeWaitMs: 0, perDigitMs: 0 }))
      .rejects.toThrow(/4–10 decimal digits/);
    expect(client.keys).toEqual([]);
  });

  it('result reports only the count, never the code itself', async () => {
    const client = new CapturingClient();
    const result = await unlockIpadWithCode(client, '4321', { wakeWaitMs: 0, perDigitMs: 0 });
    // The result should expose digitsSent and nothing that echoes the code.
    expect(result).toEqual({ digitsSent: 4 });
    expect(JSON.stringify(result)).not.toContain('4321');
    expect(JSON.stringify(result)).not.toContain('Digit');
  });

  it('paces digit presses by perDigitMs (default 100 ms)', async () => {
    vi.useFakeTimers();
    const client = new CapturingClient();
    const p = unlockIpadWithCode(client, '1234');
    // Drain all timers — wakeWait*2 + perDigit*4 + 0 final = 2200 + 400 = 2600 ms.
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(client.keys.length).toBe(7);
    vi.useRealTimers();
  });
});
