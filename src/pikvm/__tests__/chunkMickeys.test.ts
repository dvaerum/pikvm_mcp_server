/**
 * Phase 155 — regression tests for chunkMickeys.
 *
 * The chunked-mickey computation appears at TWO call sites in
 * clickAtWithRetry: the micro-correction loop's per-iteration emit
 * and Phase 125's in-motion approach emit. Before extraction the
 * math was duplicated (Math.sign * Math.min(Math.ceil(Math.abs))).
 * The duplication invited drift: a refactor at one call site that
 * misremembers the ceil/floor or sign handling would silently
 * regress only one of the two paths.
 *
 * The math has subtle edge cases worth pinning explicitly.
 */

import { describe, expect, it } from 'vitest';
import { chunkMickeys } from '../click-verify.js';

describe('chunkMickeys', () => {
  it('returns 0 for a zero raw count (no emit)', () => {
    expect(chunkMickeys(0, 5)).toBe(0);
  });

  it('rounds magnitude UP via ceil (sub-1-mickey emits don\'t stall)', () => {
    // raw=0.4 with sign=+1 must produce 1 — otherwise sub-pixel
    // residuals would loop forever computing zero emits.
    expect(chunkMickeys(0.4, 5)).toBe(1);
    expect(chunkMickeys(0.001, 5)).toBe(1);
  });

  it('preserves sign on negative inputs', () => {
    expect(chunkMickeys(-0.4, 5)).toBe(-1);
    expect(chunkMickeys(-3.2, 5)).toBe(-4);
  });

  it('caps magnitude at maxMickeys, not raw', () => {
    // raw=10.5, cap=5 → sign(+1) * min(ceil(10.5), 5) = +5, NOT +11.
    expect(chunkMickeys(10.5, 5)).toBe(5);
    expect(chunkMickeys(-10.5, 5)).toBe(-5);
    expect(chunkMickeys(100, 8)).toBe(8);
  });

  it('does not cap when raw is below maxMickeys', () => {
    expect(chunkMickeys(2.1, 5)).toBe(3);
    expect(chunkMickeys(4.9, 5)).toBe(5);
  });

  it('boundary: raw=cap exactly returns cap (no truncation)', () => {
    expect(chunkMickeys(5, 5)).toBe(5);
    expect(chunkMickeys(-5, 5)).toBe(-5);
  });

  it('returns 0 when maxMickeys is 0 (feature disabled)', () => {
    expect(chunkMickeys(10.5, 0)).toBe(0);
    expect(chunkMickeys(-10.5, 0)).toBe(0);
  });

  it('returns 0 for negative maxMickeys (defensive)', () => {
    expect(chunkMickeys(10.5, -1)).toBe(0);
  });

  it('returns 0 for NaN/Infinity raw input (defensive against ratio=0 bugs)', () => {
    // dx / ratioX with ratioX=0 returns Infinity; without the guard
    // it would propagate to mouseMoveRelative and emit a giant
    // (driver-saturating) value.
    expect(chunkMickeys(NaN, 5)).toBe(0);
    expect(chunkMickeys(Infinity, 5)).toBe(0);
    expect(chunkMickeys(-Infinity, 5)).toBe(0);
  });

  it('REGRESSION: Math.sign(0) === 0 path must not multiply through', () => {
    // If a refactor changes Math.sign to (raw < 0 ? -1 : 1), then
    // chunkMickeys(0, 5) would erroneously become +1 instead of 0,
    // triggering a no-op emit on every zero-residual iteration.
    // Note: JS distinguishes +0 / -0 via Object.is, but functionally
    // (HID emit) they're identical — assert magnitude only.
    expect(Math.abs(chunkMickeys(0, 5))).toBe(0);
    expect(Math.abs(chunkMickeys(-0, 5))).toBe(0);
  });

  it('REGRESSION: ceil-not-floor pin', () => {
    // Math.floor(0.4) === 0 — using floor would stall sub-1-mickey
    // residuals. The ceil semantics are critical.
    expect(chunkMickeys(0.4, 5)).toBe(1); // would be 0 with floor
    expect(chunkMickeys(2.1, 5)).toBe(3); // would be 2 with floor
  });
});
