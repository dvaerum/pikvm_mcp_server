/**
 * Direct unit tests for loadConfig. The function reads from
 * process.env and is the entry point for every PiKVMClient-using
 * code path. Silent breakage (wrong default value, wrong field name,
 * env var precedence wrong) would manifest as mysterious "auth
 * failed" or "host unreachable" errors rather than a clear failure
 * here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const REQUIRED_VARS = [
  'PIKVM_HOST',
  'PIKVM_PASSWORD',
];

const OPTIONAL_VARS = [
  'PIKVM_USERNAME',
  'PIKVM_VERIFY_SSL',
  'PIKVM_DEFAULT_KEYMAP',
  'PIKVM_CALIBRATION_ROUNDS',
  'PIKVM_CALIBRATION_VERIFY_ROUNDS',
  'PIKVM_CALIBRATION_MOVE_DELAY',
];

describe('loadConfig', () => {
  // Snapshot env vars and restore between tests so we don't leak state.
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [...REQUIRED_VARS, ...OPTIONAL_VARS]) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('throws when PIKVM_HOST is missing', () => {
    process.env.PIKVM_PASSWORD = 'pw';
    expect(() => loadConfig()).toThrow(/PIKVM_HOST/);
  });

  it('throws when PIKVM_PASSWORD is missing', () => {
    process.env.PIKVM_HOST = 'https://example';
    expect(() => loadConfig()).toThrow(/PIKVM_PASSWORD/);
  });

  it('returns minimal valid config with defaults when only required vars are set', () => {
    process.env.PIKVM_HOST = 'https://kvm.example';
    process.env.PIKVM_PASSWORD = 'secret';
    const cfg = loadConfig();
    expect(cfg.pikvm.host).toBe('https://kvm.example');
    expect(cfg.pikvm.password).toBe('secret');
    expect(cfg.pikvm.username).toBe('admin');           // default
    expect(cfg.pikvm.verifySsl).toBe(false);             // default false unless 'true'
    expect(cfg.pikvm.defaultKeymap).toBe('en-us');       // default
    expect(cfg.calibration.rounds).toBe(5);              // default
    expect(cfg.calibration.verifyRounds).toBe(5);
    expect(cfg.calibration.moveDelayMs).toBe(300);
  });

  it('honours PIKVM_USERNAME override', () => {
    process.env.PIKVM_HOST = 'https://kvm.example';
    process.env.PIKVM_PASSWORD = 'secret';
    process.env.PIKVM_USERNAME = 'alice';
    expect(loadConfig().pikvm.username).toBe('alice');
  });

  it('verifySsl is true ONLY when PIKVM_VERIFY_SSL=="true" exact match', () => {
    process.env.PIKVM_HOST = 'https://kvm.example';
    process.env.PIKVM_PASSWORD = 'secret';

    process.env.PIKVM_VERIFY_SSL = 'true';
    expect(loadConfig().pikvm.verifySsl).toBe(true);

    process.env.PIKVM_VERIFY_SSL = 'TRUE'; // case-sensitive — does NOT match
    expect(loadConfig().pikvm.verifySsl).toBe(false);

    process.env.PIKVM_VERIFY_SSL = '1'; // truthy string but NOT the magic value
    expect(loadConfig().pikvm.verifySsl).toBe(false);

    process.env.PIKVM_VERIFY_SSL = 'false';
    expect(loadConfig().pikvm.verifySsl).toBe(false);
  });

  it('parses calibration rounds / delays as integers', () => {
    process.env.PIKVM_HOST = 'https://kvm.example';
    process.env.PIKVM_PASSWORD = 'secret';
    process.env.PIKVM_CALIBRATION_ROUNDS = '10';
    process.env.PIKVM_CALIBRATION_VERIFY_ROUNDS = '7';
    process.env.PIKVM_CALIBRATION_MOVE_DELAY = '500';
    const cfg = loadConfig();
    expect(cfg.calibration.rounds).toBe(10);
    expect(cfg.calibration.verifyRounds).toBe(7);
    expect(cfg.calibration.moveDelayMs).toBe(500);
  });

  it('honours PIKVM_DEFAULT_KEYMAP override', () => {
    process.env.PIKVM_HOST = 'https://kvm.example';
    process.env.PIKVM_PASSWORD = 'secret';
    process.env.PIKVM_DEFAULT_KEYMAP = 'da-dk';
    expect(loadConfig().pikvm.defaultKeymap).toBe('da-dk');
  });
});
