/**
 * Unit tests for the per-session login gate (src/session-auth.ts). The gate
 * reuses the injected HeaderAuthorizer, so a fake authorizer stands in for the
 * kvmd/static validation.
 */
import { describe, expect, it } from 'vitest';
import { makeLoginGate, basicAuthHeader, type SessionAuthState } from '../session-auth.js';
import { parseBasicAuthHeader } from '../auth.js';

describe('basicAuthHeader', () => {
  it('produces a header that parseBasicAuthHeader round-trips', () => {
    expect(parseBasicAuthHeader(basicAuthHeader('admin', 'p@ss:word'))).toEqual({
      username: 'admin',
      password: 'p@ss:word',
    });
  });
});

describe('makeLoginGate', () => {
  it('marks the session authenticated on a validated login', async () => {
    const session: SessionAuthState = { authenticated: false };
    // Authorizer accepts exactly admin/good — validated via the Basic header.
    const gate = makeLoginGate(async (h) => h === basicAuthHeader('admin', 'good'), session);

    expect(await gate.login('admin', 'good')).toBe(true);
    expect(session.authenticated).toBe(true);
  });

  it('rejects bad credentials and leaves the session unauthenticated', async () => {
    const session: SessionAuthState = { authenticated: false };
    const gate = makeLoginGate(async (h) => h === basicAuthHeader('admin', 'good'), session);

    expect(await gate.login('admin', 'wrong')).toBe(false);
    expect(session.authenticated).toBe(false);
  });

  it('passes the credentials to the authorizer as a Basic header (never plaintext args)', async () => {
    const session: SessionAuthState = { authenticated: false };
    let seen: string | undefined;
    const gate = makeLoginGate(async (h) => {
      seen = h;
      return true;
    }, session);

    await gate.login('user', 'secret');
    expect(seen).toBe(basicAuthHeader('user', 'secret'));
  });
});
