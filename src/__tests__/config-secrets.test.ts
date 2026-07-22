/**
 * TDD for file-based secret resolution (src/config.ts resolveSecret). Precedence:
 *   1. direct env var (PIKVM_PASSWORD)
 *   2. ${name}_FILE (PIKVM_PASSWORD_FILE) — file contents
 *   3. $CREDENTIALS_DIRECTORY/<credName> (systemd LoadCredential / sops-nix)
 * This is what lets the server read username from one file and password from
 * another (sops-nix secret paths, or systemd credentials).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSecret, resolveHttpAuth } from '../config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pikvm-secrets-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function withFile(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('resolveSecret', () => {
  it('returns a direct env var', () => {
    expect(resolveSecret({ PIKVM_PASSWORD: 'direct' }, 'PIKVM_PASSWORD', 'pikvm-password')).toBe('direct');
  });

  it('reads from ${name}_FILE and strips trailing newlines', () => {
    const p = withFile('pw', 'filepw\n');
    expect(resolveSecret({ PIKVM_PASSWORD_FILE: p }, 'PIKVM_PASSWORD', 'pikvm-password')).toBe('filepw');
  });

  it('direct env var beats the _FILE', () => {
    const p = withFile('pw', 'filepw');
    expect(
      resolveSecret({ PIKVM_PASSWORD: 'direct', PIKVM_PASSWORD_FILE: p }, 'PIKVM_PASSWORD', 'pikvm-password'),
    ).toBe('direct');
  });

  it('reads from systemd $CREDENTIALS_DIRECTORY by credential name', () => {
    withFile('pikvm-password', 'credpw\n');
    expect(resolveSecret({ CREDENTIALS_DIRECTORY: dir }, 'PIKVM_PASSWORD', 'pikvm-password')).toBe('credpw');
  });

  it('_FILE beats $CREDENTIALS_DIRECTORY', () => {
    const p = withFile('pw', 'filepw');
    withFile('pikvm-password', 'credpw');
    expect(
      resolveSecret({ PIKVM_PASSWORD_FILE: p, CREDENTIALS_DIRECTORY: dir }, 'PIKVM_PASSWORD', 'pikvm-password'),
    ).toBe('filepw');
  });

  it('resolves username and password independently (two different files)', () => {
    const uf = withFile('user', 'operator\n');
    const pf = withFile('pass', 's3cret\n');
    const env = { PIKVM_USERNAME_FILE: uf, PIKVM_PASSWORD_FILE: pf };
    expect(resolveSecret(env, 'PIKVM_USERNAME', 'pikvm-username')).toBe('operator');
    expect(resolveSecret(env, 'PIKVM_PASSWORD', 'pikvm-password')).toBe('s3cret');
  });

  it('treats an empty direct env var as unset and falls through to the file', () => {
    const p = withFile('pw', 'filepw');
    expect(
      resolveSecret({ PIKVM_PASSWORD: '', PIKVM_PASSWORD_FILE: p }, 'PIKVM_PASSWORD', 'pikvm-password'),
    ).toBe('filepw');
  });

  it('returns undefined when nothing is set', () => {
    expect(resolveSecret({}, 'PIKVM_PASSWORD', 'pikvm-password')).toBeUndefined();
  });

  it('without a credName, does not read from the credentials dir', () => {
    withFile('PIKVM_HOST', 'x');
    expect(resolveSecret({ CREDENTIALS_DIRECTORY: dir }, 'PIKVM_HOST')).toBeUndefined();
  });
});

describe('resolveHttpAuth', () => {
  it('returns undefined when no password is configured anywhere', () => {
    expect(resolveHttpAuth({}, {})).toBeUndefined();
  });

  it('resolves the password from the --auth-password flag', () => {
    expect(resolveHttpAuth({}, { authPassword: 'flagpw' })).toEqual({
      username: 'operator',
      password: 'flagpw',
    });
  });

  it('resolves the password from --auth-password-file', () => {
    const p = withFile('mcp-auth', 'filepw\n');
    expect(resolveHttpAuth({}, { authPasswordFile: p })?.password).toBe('filepw');
  });

  it('resolves the password from PIKVM_MCP_AUTH_PASSWORD / _FILE / the systemd credential', () => {
    expect(resolveHttpAuth({ PIKVM_MCP_AUTH_PASSWORD: 'envpw' }, {})?.password).toBe('envpw');
    const p = withFile('mcp-auth-env', 'envfilepw');
    expect(resolveHttpAuth({ PIKVM_MCP_AUTH_PASSWORD_FILE: p }, {})?.password).toBe('envfilepw');
    withFile('pikvm-mcp-auth-password', 'credpw\n');
    expect(resolveHttpAuth({ CREDENTIALS_DIRECTORY: dir }, {})?.password).toBe('credpw');
  });

  it('username: flag > env > "operator" default', () => {
    expect(resolveHttpAuth({}, { authPassword: 'p' }).username).toBe('operator');
    expect(resolveHttpAuth({ PIKVM_MCP_AUTH_USERNAME: 'bob' }, { authPassword: 'p' }).username).toBe('bob');
    expect(
      resolveHttpAuth({ PIKVM_MCP_AUTH_USERNAME: 'bob' }, { authUsername: 'alice', authPassword: 'p' }).username,
    ).toBe('alice');
  });

  it('flag password wins over the file flag and env', () => {
    const p = withFile('mcp-auth-precedence', 'filepw');
    expect(
      resolveHttpAuth({ PIKVM_MCP_AUTH_PASSWORD: 'envpw' }, { authPassword: 'flagpw', authPasswordFile: p })
        ?.password,
    ).toBe('flagpw');
  });
});
