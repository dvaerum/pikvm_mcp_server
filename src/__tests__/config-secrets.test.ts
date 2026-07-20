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
import { resolveSecret } from '../config.js';

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
