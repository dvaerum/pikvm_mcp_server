/**
 * Pins package.json's version field to src/version.ts's VERSION constant.
 * If anyone bumps one without the other, this test fails before the
 * mismatch ships and a deployed server reports a wrong version.
 *
 * Also pins the format (semver-ish: M.m.p with optional pre-release) so a
 * typo like "0.3" or "0,3,0" doesn't slip through.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { VERSION } from '../version.js';

function repoRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..');
}

describe('version invariants', () => {
  it('matches package.json#version', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot(), 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });

  it('is a non-empty string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it('looks like a semver (MAJOR.MINOR.PATCH with optional pre-release tag)', () => {
    // Permissive but rules out obvious typos: 0.3, 0,3,0, "v0.3.0", etc.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/);
  });
});
