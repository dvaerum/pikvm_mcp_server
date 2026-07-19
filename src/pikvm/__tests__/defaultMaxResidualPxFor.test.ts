/**
 * Unit tests for defaultMaxResidualPxFor.
 *
 * Pin the per-mouse-mode contract: iPad (relative) gets a strict proximity
 * gate (25 px default), desktop (absolute) gets undefined. Phase 134's live
 * bench measured successful trials at residuals 10-34 px (correct icon) and
 * 36-200 px (wrong icon / empty area); a tight default rejects the latter.
 * The gate is also a config line — PIKVM_CLICK_MAX_RESIDUAL_PX overrides it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { defaultMaxResidualPxFor } from '../click-verify.js';

const ENV = 'PIKVM_CLICK_MAX_RESIDUAL_PX';

describe('defaultMaxResidualPxFor', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('defaults to 25 for iPad mode (mouseAbsoluteMode=false)', () => {
    delete process.env[ENV];
    expect(defaultMaxResidualPxFor(false)).toBe(25);
  });

  it('returns undefined for desktop mode (mouseAbsoluteMode=true)', () => {
    delete process.env[ENV];
    expect(defaultMaxResidualPxFor(true)).toBeUndefined();
  });

  it('config line: a positive number overrides the default for both modes', () => {
    process.env[ENV] = '40';
    expect(defaultMaxResidualPxFor(false)).toBe(40);
    expect(defaultMaxResidualPxFor(true)).toBe(40);
  });

  it("config line: 'off' or 0 disables the gate", () => {
    process.env[ENV] = 'off';
    expect(defaultMaxResidualPxFor(false)).toBeUndefined();
    process.env[ENV] = '0';
    expect(defaultMaxResidualPxFor(false)).toBeUndefined();
  });

  it('config line: a non-numeric value falls back to the mode-aware default', () => {
    process.env[ENV] = 'banana';
    expect(defaultMaxResidualPxFor(false)).toBe(25);
  });

  it('REGRESSION: iPad always has a proximity gate so wrong-icon clicks are rejected', () => {
    delete process.env[ENV];
    expect(defaultMaxResidualPxFor(false)).not.toBeUndefined();
    expect(defaultMaxResidualPxFor(false)).toBeLessThanOrEqual(35);
  });
});
