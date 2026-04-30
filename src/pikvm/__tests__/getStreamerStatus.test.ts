/**
 * Phase 189 (v0.5.178): pin the contract of `PiKVMClient.getStreamerStatus()`.
 *
 * The method exists so `pikvm_health_check` can distinguish "PiKVM down"
 * from "iPad behind the HDMI cable is off" — the latter manifests as a
 * generic 503 on `pikvm_screenshot`, which gives the operator no clue.
 * `streamer.source.online: false` is the canonical signal that the
 * device producing the HDMI feed is dark.
 *
 * Mocked at the request level (no live PiKVM dependency).
 */

import { describe, expect, it, vi } from 'vitest';
import { PiKVMClient } from '../client.js';

function clientWithMockedRequest(payload: unknown): PiKVMClient {
  const c = new PiKVMClient({
    host: 'mock.local',
    username: 'admin',
    password: 'x',
    verifySsl: false,
  });
  // Replace the private request method with a stub. This is a documented
  // pattern in the existing test suite — no public seam, so we pierce it
  // through the unknown cast.
  (c as unknown as { request: () => Promise<unknown> }).request = async () => payload;
  return c;
}

describe('PiKVMClient.getStreamerStatus', () => {
  it('returns online=true and resolution when source is up', async () => {
    const c = clientWithMockedRequest({
      ok: true,
      result: { streamer: { source: { online: true, resolution: { width: 1920, height: 1080 } } } },
    });
    const out = await c.getStreamerStatus();
    expect(out.sourceOnline).toBe(true);
    expect(out.resolution).toEqual({ width: 1920, height: 1080 });
  });

  it('returns online=false when the HDMI source is off (iPad battery-dead case)', async () => {
    const c = clientWithMockedRequest({
      ok: true,
      result: { streamer: { source: { online: false, resolution: { width: 1920, height: 1080 } } } },
    });
    const out = await c.getStreamerStatus();
    expect(out.sourceOnline).toBe(false);
    expect(out.resolution).toEqual({ width: 1920, height: 1080 });
  });

  it('throws on missing streamer.source (malformed response — fail loud, not silent)', async () => {
    const c = clientWithMockedRequest({ ok: true, result: { streamer: {} } });
    await expect(c.getStreamerStatus()).rejects.toThrow(/Invalid or missing streamer.source/);
  });

  it('throws on non-boolean source.online (treat as malformed)', async () => {
    const c = clientWithMockedRequest({
      ok: true,
      result: { streamer: { source: { online: 'yes', resolution: { width: 1920, height: 1080 } } } },
    });
    await expect(c.getStreamerStatus()).rejects.toThrow(/Invalid or missing streamer.source/);
  });

  it('throws on missing resolution (downstream code relies on numeric width/height)', async () => {
    const c = clientWithMockedRequest({
      ok: true,
      result: { streamer: { source: { online: true } } },
    });
    await expect(c.getStreamerStatus()).rejects.toThrow(/Invalid or missing streamer.source.resolution/);
  });

  it('throws on non-numeric resolution.width', async () => {
    const c = clientWithMockedRequest({
      ok: true,
      result: { streamer: { source: { online: true, resolution: { width: '1920', height: 1080 } } } },
    });
    await expect(c.getStreamerStatus()).rejects.toThrow(/Invalid or missing streamer.source.resolution/);
  });
});
