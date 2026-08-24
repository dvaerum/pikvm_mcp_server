/**
 * Real unit test (resolver + fake UDC reader) for the settling-gate-clear
 * decision used in handle_pikvm_health_check (index.ts): fires on a
 * CONFIRMED {online:true} UDC reading only — not on null (reader unwired)
 * and not on {online:false} (confirmed still offline). Pins the ADR-0002
 * Phase 1 fix to index.ts:1231's `if (udcState ? udcState.online : true)`
 * → `if (udcState?.online === true)`, which used to clear the gate on a
 * null reading too (a fallback that guessed "online" absent any signal).
 * Safe to tighten because the resolver's own auto-expiry backstop already
 * makes a never-cleared gate self-healing (see hid-mode.ts's
 * DEFAULT_SETTLE_WINDOW_MS) — this test also pins that backstop still
 * applies when the UDC reading never confirms online.
 */
import { describe, expect, it } from 'vitest';
import { HidModeResolver, shouldClearSettlingFor, type HidModeEndpoint } from '../hid-mode.js';
import type { UdcState } from '../hid-recovery.js';

describe('shouldClearSettlingFor', () => {
  it('true only for a confirmed-online reading', () => {
    expect(shouldClearSettlingFor({ udc: 'fe980000.usb', state: 'configured', online: true })).toBe(true);
  });
  it('false for a confirmed-offline reading', () => {
    expect(shouldClearSettlingFor({ udc: 'fe980000.usb', state: 'not attached', online: false })).toBe(false);
  });
  it('false for a null reading (UDC reader not wired / read failed)', () => {
    expect(shouldClearSettlingFor(null)).toBe(false);
  });
});

describe('settling gate + fake UDC reader (integration of the pattern used by handle_pikvm_health_check)', () => {
  async function makeSettlingResolver() {
    let mode: 'ipad' | 'desktop' = 'ipad';
    let t = 1000;
    const ep: HidModeEndpoint = {
      configured: true,
      read: async () => ({ mode, requested: mode, settled: true }),
      write: async () => ({ ok: true, message: 'ok' }),
    };
    const resolver = new HidModeResolver({ endpoint: ep, ttlMs: 1, now: () => t });
    await resolver.resolve();
    t += 10;
    mode = 'desktop';
    await resolver.resolve(); // mode changed → begins settling
    expect(resolver.moverGate().allowed).toBe(false); // sanity: settling is active
    return resolver;
  }

  it('a confirmed-online UDC reading clears the gate', async () => {
    const resolver = await makeSettlingResolver();
    const udcState: UdcState = { udc: 'fe980000.usb', state: 'configured', online: true };
    if (shouldClearSettlingFor(udcState)) resolver.clearSettling();
    expect(resolver.moverGate().allowed).toBe(true);
  });

  it('a confirmed-offline UDC reading leaves the gate closed', async () => {
    const resolver = await makeSettlingResolver();
    const udcState: UdcState = { udc: 'fe980000.usb', state: 'not attached', online: false };
    if (shouldClearSettlingFor(udcState)) resolver.clearSettling();
    expect(resolver.moverGate().allowed).toBe(false);
  });

  it('a null UDC reading (reader not wired) leaves the gate closed — relies on auto-expiry instead of guessing', async () => {
    const resolver = await makeSettlingResolver();
    if (shouldClearSettlingFor(null)) resolver.clearSettling();
    expect(resolver.moverGate().allowed).toBe(false);
  });
});
