/**
 * Phase 127 — unit tests for clampPxPerMickeyRatio.
 *
 * Pure helper that sanity-clamps the live px/mickey ratio reported
 * by moveToPixel before it's used in the click-verify micro-
 * correction and approach math. Live diagnostic 2026-04-27 caught
 * moveToPixel reporting (0.73, 1.48) which broke convergence; the
 * clamp falls back to 1.3 when the live value is outside the
 * empirical iPad small-emit range [0.9, 2.5].
 */

import { describe, expect, it } from 'vitest';
import { clampPxPerMickeyRatio } from '../click-verify.js';

describe('clampPxPerMickeyRatio', () => {
  it('passes through a value inside the [0.9, 2.5] range', () => {
    expect(clampPxPerMickeyRatio(1.3)).toBe(1.3);
    expect(clampPxPerMickeyRatio(0.95)).toBe(0.95);
    expect(clampPxPerMickeyRatio(2.0)).toBe(2.0);
    expect(clampPxPerMickeyRatio(1.5)).toBe(1.5);
  });

  it('REGRESSION (Phase 127): falls back to 1.3 for the live trace value 0.7291', () => {
    // The exact value caught in the live trace that triggered
    // Phase 127. Using 0.73 in the micro-correction loop caused
    // residual to oscillate at 31-37 px instead of converging.
    expect(clampPxPerMickeyRatio(0.7291)).toBe(1.3);
  });

  it('falls back to 1.3 when the value is below the floor', () => {
    expect(clampPxPerMickeyRatio(0.5)).toBe(1.3);
    expect(clampPxPerMickeyRatio(0.1)).toBe(1.3);
    expect(clampPxPerMickeyRatio(0)).toBe(1.3);
    expect(clampPxPerMickeyRatio(0.89)).toBe(1.3);
  });

  it('falls back to 1.3 when the value is above the ceiling', () => {
    expect(clampPxPerMickeyRatio(2.51)).toBe(1.3);
    expect(clampPxPerMickeyRatio(5.0)).toBe(1.3);
    expect(clampPxPerMickeyRatio(100)).toBe(1.3);
  });

  it('falls back to 1.3 for undefined input', () => {
    expect(clampPxPerMickeyRatio(undefined)).toBe(1.3);
  });

  it('falls back to 1.3 for non-finite input (NaN, Infinity)', () => {
    expect(clampPxPerMickeyRatio(Number.NaN)).toBe(1.3);
    expect(clampPxPerMickeyRatio(Number.POSITIVE_INFINITY)).toBe(1.3);
    expect(clampPxPerMickeyRatio(Number.NEGATIVE_INFINITY)).toBe(1.3);
  });

  it('respects custom min/max/fallback overrides', () => {
    // Tighter clamp, different fallback.
    expect(clampPxPerMickeyRatio(1.5, 1.0, 1.4, 1.2)).toBe(1.2); // above max
    expect(clampPxPerMickeyRatio(0.95, 1.0, 1.4, 1.2)).toBe(1.2); // below min
    expect(clampPxPerMickeyRatio(1.2, 1.0, 1.4, 1.2)).toBe(1.2); // inside range
  });

  it('boundary values are inclusive', () => {
    // The contract is [min, max] inclusive on both sides.
    expect(clampPxPerMickeyRatio(0.9)).toBe(0.9);
    expect(clampPxPerMickeyRatio(2.5)).toBe(2.5);
  });
});
