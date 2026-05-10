/**
 * Phase 216 (v0.5.204) regression test — pin that takeRawScreenshot
 * prefers the Phase 202 keepalive variant over plain screenshot when
 * the client exposes both. Without this preference, locateCursor's
 * BEFORE/AFTER frames frequently catch the iPadOS cursor mid-fade
 * (the cursor fades within ~200 ms of the last emit, plain
 * screenshots return a 300+ ms stale buffer), motion-diff finds only
 * one cursor-sized cluster, and locateCursor fails with
 * "1 cursor-sized cluster (need ≥2)".
 *
 * The keepalive variant emits a tiny ±1 px wake nudge before each
 * capture so the cursor stays rendered. If a future refactor drops
 * the keepalive preference (e.g. someone "simplifies"
 * takeRawScreenshot to just `client.screenshot()`), this test fails.
 */

import { describe, expect, it } from 'vitest';
import { takeRawScreenshot } from '../cursor-detect.js';
import type { PiKVMClient } from '../client.js';

interface CapturingClient {
  screenshotCalls: number;
  keepaliveCalls: number;
  client: PiKVMClient;
}

function makeClientWithBoth(): CapturingClient {
  const counters = { screenshotCalls: 0, keepaliveCalls: 0 };
  const fakeShot = {
    buffer: Buffer.from('fake-keepalive'),
    screenshotWidth: 1920,
    screenshotHeight: 1080,
    actualWidth: 1920,
    actualHeight: 1080,
    scaleX: 1,
    scaleY: 1,
  };
  const fakePlain = { ...fakeShot, buffer: Buffer.from('fake-plain') };
  const client = {
    async screenshot() {
      counters.screenshotCalls++;
      return fakePlain;
    },
    async screenshotKeepingCursorAlive() {
      counters.keepaliveCalls++;
      return fakeShot;
    },
  } as unknown as PiKVMClient;
  return { ...counters, client };
}

function makeClientWithOnlyScreenshot(): { screenshotCalls: number; client: PiKVMClient } {
  const counters = { screenshotCalls: 0 };
  const fakeShot = {
    buffer: Buffer.from('fake-plain'),
    screenshotWidth: 1920,
    screenshotHeight: 1080,
    actualWidth: 1920,
    actualHeight: 1080,
    scaleX: 1,
    scaleY: 1,
  };
  const client = {
    async screenshot() {
      counters.screenshotCalls++;
      return fakeShot;
    },
    // No screenshotKeepingCursorAlive — simulates legacy mocks.
  } as unknown as PiKVMClient;
  return { ...counters, client };
}

describe('takeRawScreenshot Phase 216 keepalive preference', () => {
  it('prefers screenshotKeepingCursorAlive when the client exposes it', async () => {
    const m = makeClientWithBoth();
    const buf = await takeRawScreenshot(m.client);
    // Read fresh counters via re-creation (since spread above copied
    // initial values). Use the closures by calling once more and
    // checking the underlying client.
    expect(buf.toString()).toBe('fake-keepalive');
  });

  it('does NOT call plain screenshot() when keepalive is available', async () => {
    // Because spread copies into the result object, capture counters
    // through the actual client's wrapped methods.
    let screenshotCalls = 0;
    let keepaliveCalls = 0;
    const fakeShot = {
      buffer: Buffer.from('keepalive-buf'),
      screenshotWidth: 1920,
      screenshotHeight: 1080,
      actualWidth: 1920,
      actualHeight: 1080,
      scaleX: 1,
      scaleY: 1,
    };
    const fakePlain = { ...fakeShot, buffer: Buffer.from('plain-buf') };
    const client = {
      async screenshot() {
        screenshotCalls++;
        return fakePlain;
      },
      async screenshotKeepingCursorAlive() {
        keepaliveCalls++;
        return fakeShot;
      },
    } as unknown as PiKVMClient;
    const buf = await takeRawScreenshot(client);
    expect(buf.toString()).toBe('keepalive-buf');
    expect(keepaliveCalls).toBe(1);
    expect(screenshotCalls).toBe(0);
  });

  it('falls back to plain screenshot() when keepalive is not exposed', async () => {
    let screenshotCalls = 0;
    const fakeShot = {
      buffer: Buffer.from('plain-only'),
      screenshotWidth: 1920,
      screenshotHeight: 1080,
      actualWidth: 1920,
      actualHeight: 1080,
      scaleX: 1,
      scaleY: 1,
    };
    const client = {
      async screenshot() {
        screenshotCalls++;
        return fakeShot;
      },
    } as unknown as PiKVMClient;
    const buf = await takeRawScreenshot(client);
    expect(buf.toString()).toBe('plain-only');
    expect(screenshotCalls).toBe(1);
  });
});
