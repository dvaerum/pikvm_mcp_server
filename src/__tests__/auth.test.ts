/**
 * Unit tests for the HTTP Basic auth helpers (src/auth.ts).
 */
import { describe, expect, it } from 'vitest';
import { parseBasicAuthHeader, headerMatches, makeStaticAuthorizer, type HttpAuth } from '../auth.js';

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

describe('parseBasicAuthHeader', () => {
  it('parses a valid Basic header', () => {
    expect(parseBasicAuthHeader(basic('operator', 's3cret'))).toEqual({
      username: 'operator',
      password: 's3cret',
    });
  });

  it('keeps colons in the password (splits on the first only)', () => {
    expect(parseBasicAuthHeader(basic('u', 'a:b:c'))).toEqual({ username: 'u', password: 'a:b:c' });
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseBasicAuthHeader(basic('u', 'p').replace('Basic', 'basic'))).toEqual({
      username: 'u',
      password: 'p',
    });
  });

  it('returns undefined for missing / non-Basic / malformed headers', () => {
    expect(parseBasicAuthHeader(undefined)).toBeUndefined();
    expect(parseBasicAuthHeader('Bearer token')).toBeUndefined();
    expect(parseBasicAuthHeader('Basic')).toBeUndefined();
    // No colon after decoding.
    expect(parseBasicAuthHeader('Basic ' + Buffer.from('nocolon').toString('base64'))).toBeUndefined();
  });
});

describe('headerMatches', () => {
  const auth: HttpAuth = { username: 'operator', password: 'hunter2' };

  it('accepts the exact credentials', () => {
    expect(headerMatches(auth, basic('operator', 'hunter2'))).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(headerMatches(auth, basic('operator', 'hunter3'))).toBe(false);
  });

  it('rejects a wrong username', () => {
    expect(headerMatches(auth, basic('admin', 'hunter2'))).toBe(false);
  });

  it('rejects a password that is a prefix of the real one', () => {
    expect(headerMatches(auth, basic('operator', 'hunter'))).toBe(false);
  });

  it('rejects a missing / malformed header', () => {
    expect(headerMatches(auth, undefined)).toBe(false);
    expect(headerMatches(auth, 'Bearer x')).toBe(false);
  });
});

describe('makeStaticAuthorizer', () => {
  const authorize = makeStaticAuthorizer({ username: 'operator', password: 'hunter2' });

  it('authorizes the exact credentials', async () => {
    expect(await authorize(basic('operator', 'hunter2'))).toBe(true);
  });

  it('rejects wrong credentials and a missing header', async () => {
    expect(await authorize(basic('operator', 'wrong'))).toBe(false);
    expect(await authorize(undefined)).toBe(false);
  });
});
