/**
 * Direct unit tests for detectBoundsOrNull. Wraps detectIpadBounds
 * with try/catch — on success returns the bounds, on failure returns
 * null instead of throwing. Both move-to.ts and ipad-unlock.ts rely
 * on this swallow-on-failure semantics so an all-black HDMI capture
 * doesn't crash unrelated flows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { detectBoundsOrNull, clearOrientationCache } from '../orientation.js';
import type { PiKVMClient } from '../client.js';

async function frame(
  hdmiW: number,
  hdmiH: number,
  ipadX: number,
  ipadY: number,
  ipadW: number,
  ipadH: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(hdmiW * hdmiH * 3);
  for (let y = 0; y < hdmiH; y++) {
    for (let x = 0; x < hdmiW; x++) {
      const o = (y * hdmiW + x) * 3;
      const inIpad = x >= ipadX && x < ipadX + ipadW && y >= ipadY && y < ipadY + ipadH;
      if (inIpad) {
        buf[o] = 120;
        buf[o + 1] = 120;
        buf[o + 2] = 120;
      }
    }
  }
  return sharp(buf, { raw: { width: hdmiW, height: hdmiH, channels: 3 } }).png().toBuffer();
}

function mockClient(buffer: Buffer | (() => Buffer | Promise<Buffer>)) {
  const client = {
    async screenshot() {
      const buf = typeof buffer === 'function' ? await buffer() : buffer;
      return {
        buffer: buf,
        screenshotWidth: 1920,
        screenshotHeight: 1080,
        actualWidth: 1920,
        actualHeight: 1080,
        scaleX: 1,
        scaleY: 1,
      };
    },
  } as unknown as PiKVMClient;
  return client;
}

describe('detectBoundsOrNull', () => {
  beforeEach(() => clearOrientationCache());
  afterEach(() => clearOrientationCache());

  it('returns the bounds on a normal HDMI frame with iPad letterboxed', async () => {
    const client = mockClient(await frame(1920, 1080, 600, 0, 720, 1080));
    const bounds = await detectBoundsOrNull(client);
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBe(720);
    expect(bounds!.height).toBe(1080);
  });

  it('returns null on an all-black frame instead of throwing', async () => {
    // Pure black frame (no iPad content) — detectIpadBoundsFromBuffer throws,
    // detectBoundsOrNull must swallow it.
    const black = await sharp(Buffer.alloc(1920 * 1080 * 3), {
      raw: { width: 1920, height: 1080, channels: 3 },
    })
      .png()
      .toBuffer();
    const client = mockClient(black);
    const bounds = await detectBoundsOrNull(client);
    expect(bounds).toBeNull();
  });

  it('logs with default prefix when verbose and detection fails', async () => {
    const black = await sharp(Buffer.alloc(1920 * 1080 * 3), {
      raw: { width: 1920, height: 1080, channels: 3 },
    })
      .png()
      .toBuffer();
    const client = mockClient(black);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await detectBoundsOrNull(client, { verbose: true });
      const allMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(allMessages).toMatch(/orientation/); // default prefix
      expect(allMessages).toMatch(/bounds detection failed/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs with custom logPrefix when verbose and detection fails', async () => {
    const black = await sharp(Buffer.alloc(1920 * 1080 * 3), {
      raw: { width: 1920, height: 1080, channels: 3 },
    })
      .png()
      .toBuffer();
    const client = mockClient(black);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await detectBoundsOrNull(client, { verbose: true, logPrefix: 'my-flow' });
      const allMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(allMessages).toMatch(/my-flow/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does not log on non-verbose failure (silent on failure by default)', async () => {
    const black = await sharp(Buffer.alloc(1920 * 1080 * 3), {
      raw: { width: 1920, height: 1080, channels: 3 },
    })
      .png()
      .toBuffer();
    const client = mockClient(black);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await detectBoundsOrNull(client); // no verbose
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
