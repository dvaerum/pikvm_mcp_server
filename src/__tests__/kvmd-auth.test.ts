/**
 * Unit tests for the kvmd-backed client authorizer (src/kvmd-auth.ts,
 * `--security kvmd`). The real kvmd round-trip (GET /api/auth/check) is injected
 * via deps.check so these stay hermetic; deps.now drives the positive-cache TTL.
 */
import { describe, expect, it } from 'vitest';
import { makeKvmdAuthorizer } from '../kvmd-auth.js';

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

const OPTS = { host: 'https://pikvm.invalid', verifySsl: false } as const;

describe('makeKvmdAuthorizer', () => {
  it('authorizes credentials kvmd accepts, rejects the rest', async () => {
    const authorize = makeKvmdAuthorizer(OPTS, {
      check: async (u, p) => u === 'admin' && p === 'good',
    });
    expect(await authorize(basic('admin', 'good'))).toBe(true);
    expect(await authorize(basic('admin', 'bad'))).toBe(false);
  });

  it('rejects a missing / non-Basic header without hitting kvmd', async () => {
    let hits = 0;
    const authorize = makeKvmdAuthorizer(OPTS, {
      check: async () => {
        hits += 1;
        return true;
      },
    });
    expect(await authorize(undefined)).toBe(false);
    expect(await authorize('Bearer token')).toBe(false);
    expect(hits).toBe(0);
  });

  it('caches a positive result for the TTL, then re-validates once it expires', async () => {
    let hits = 0;
    let clock = 1_000;
    const authorize = makeKvmdAuthorizer(
      { ...OPTS, ttlMs: 60_000 },
      {
        check: async () => {
          hits += 1;
          return true;
        },
        now: () => clock,
      },
    );

    expect(await authorize(basic('admin', 'good'))).toBe(true); // miss -> kvmd
    expect(await authorize(basic('admin', 'good'))).toBe(true); // fresh hit -> cached
    expect(hits).toBe(1);

    clock += 60_001; // TTL elapsed
    expect(await authorize(basic('admin', 'good'))).toBe(true); // stale -> kvmd again
    expect(hits).toBe(2);
  });

  it('never caches a negative result (so a fixed password is not locked out)', async () => {
    let accept = false;
    let hits = 0;
    const authorize = makeKvmdAuthorizer(OPTS, {
      check: async () => {
        hits += 1;
        return accept;
      },
    });

    expect(await authorize(basic('admin', 'secret'))).toBe(false); // kvmd says no
    accept = true; // password now valid (e.g. it was just set on the PiKVM)
    expect(await authorize(basic('admin', 'secret'))).toBe(true); // re-validated, not cached-negative
    expect(hits).toBe(2);
  });

  it('keys the cache on username+password so a different user is validated separately', async () => {
    const seen: string[] = [];
    const authorize = makeKvmdAuthorizer(OPTS, {
      check: async (u) => {
        seen.push(u);
        return true;
      },
    });
    await authorize(basic('alice', 'pw'));
    await authorize(basic('bob', 'pw')); // same password, different user -> separate kvmd check
    await authorize(basic('alice', 'pw')); // alice cached
    expect(seen).toEqual(['alice', 'bob']);
  });
});
