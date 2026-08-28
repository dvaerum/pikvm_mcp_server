/**
 * Table-driven test for HidModeResolver.policy() (ADR-0002 Phase 1). This
 * pins the behavior-preserving extraction: policy() must return EXACTLY the
 * same per-mode defaults that were previously scattered across index.ts's
 * handlers as individual `mouseAbsoluteMode`-keyed ternaries (see
 * src/index.ts's click_at/move_to/scroll handlers, pre-Phase-1) — a single
 * computed-once object instead of re-derivation at each read site.
 *
 * Also pins the null contract: policy() returns null exactly when
 * moverGate().allowed is false (mode unknown, or settling), so a caller
 * can't accidentally consume a stale/undefined mode by forgetting to check
 * the gate separately.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HidModeResolver, type HidModeEndpoint } from '../hid-mode.js';

const ENV = 'PIKVM_CLICK_MAX_RESIDUAL_PX';

describe('HidModeResolver.policy()', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  describe.each([
    {
      declared: 'ipad' as const,
      expected: {
        mode: 'ipad',
        mouseAbsolute: false,
        strategy: 'curve-one-shot',
        forbidSlamFallback: true,
        forbidSlamOnIpad: true,
        chunkPaceMs: 100,
        maxResidualPx: 15,
        dimThreshold: 35,
        applyTapBias: true,
      },
    },
    {
      declared: 'desktop' as const,
      expected: {
        mode: 'desktop',
        mouseAbsolute: true,
        strategy: 'detect-then-move',
        forbidSlamFallback: false,
        forbidSlamOnIpad: false,
        chunkPaceMs: undefined,
        maxResidualPx: undefined,
        dimThreshold: 0,
        applyTapBias: false,
      },
    },
  ])('mode: $declared', ({ declared, expected }) => {
    it(`matches index.ts's pre-Phase-1 per-mode defaults exactly`, () => {
      delete process.env[ENV];
      const resolver = new HidModeResolver({ declared });
      expect(resolver.policy()).toEqual(expected);
    });
  });

  it('respects the PIKVM_CLICK_MAX_RESIDUAL_PX config override, both modes', () => {
    process.env[ENV] = '40';
    expect(new HidModeResolver({ declared: 'ipad' }).policy()?.maxResidualPx).toBe(40);
    expect(new HidModeResolver({ declared: 'desktop' }).policy()?.maxResidualPx).toBe(40);
  });

  it('returns null when the mode is unknown (endpoint unreachable, never resolved)', async () => {
    const ep: HidModeEndpoint = { configured: true, read: async () => null, write: async () => ({ ok: false, message: 'n/a' }) };
    const resolver = new HidModeResolver({ endpoint: ep });
    await resolver.resolve(); // fails closed: mode stays null
    expect(resolver.policy()).toBeNull();
  });

  it('returns null while settling (mode known, but a switch is mid-re-enum)', async () => {
    let mode: 'ipad' | 'desktop' = 'ipad';
    let t = 1000;
    const ep: HidModeEndpoint = {
      configured: true,
      read: async () => ({ mode, requested: mode, settled: true }),
      write: async () => ({ ok: true, message: 'ok' }),
    };
    // ttlMs:1 so the second resolve() re-reads instead of hitting the cache.
    const resolver = new HidModeResolver({ endpoint: ep, ttlMs: 1, now: () => t });
    await resolver.resolve(); // establishes lastGoodMode='ipad'
    t += 10;
    mode = 'desktop';
    await resolver.resolve(); // mode changed → begins settling
    expect(resolver.policy()).toBeNull();
  });

  it('non-null again once settling clears', async () => {
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
    await resolver.resolve();
    expect(resolver.policy()).toBeNull();
    resolver.clearSettling();
    expect(resolver.policy()?.mode).toBe('desktop');
  });
});
