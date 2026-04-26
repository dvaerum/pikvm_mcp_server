/**
 * Phase 50: pure tests for the rate-limit classifier.
 *
 * The classifier sits on top of moveToPixel's `usedPxPerMickey` to
 * detect iPadOS-side input throttling — when iPadOS applies only ~25%
 * of the requested motion regardless of emit (popup intercept, low-
 * power, accessibility throttle, display-off-but-on). Continuing to
 * retry click_at while this state holds wastes attempts and produces
 * identical-looking failures.
 *
 * Bench data point that drove this: live ratio 0.829 px/mickey vs
 * expected ~3.0; 4 correction passes all wasted; final cursor never
 * actually left origin region. Phase 50 surfaces this once and bails
 * out instead of accumulating noise.
 */

import { describe, expect, it } from 'vitest';
import { isRateLimited } from '../click-verify.js';

describe('isRateLimited', () => {
  it('returns true when both axes are below threshold', () => {
    expect(isRateLimited({ x: 0.83, y: 0.78 }, 0.4)).toBe(false);  // both > 0.4 → not limited
    expect(isRateLimited({ x: 0.3, y: 0.3 }, 0.4)).toBe(true);  // both < 0.4 → limited
    expect(isRateLimited({ x: 0.1, y: 0.2 }, 0.4)).toBe(true);  // both < 0.4 → limited
  });

  it('returns false when only one axis is below threshold', () => {
    // Single-axis low ratio is a weak signal — could be a move that
    // emitted near-zero on that axis and the algorithm fell back to a
    // stale ratio. Don't bail out on weak signals.
    expect(isRateLimited({ x: 0.1, y: 5.0 }, 0.4)).toBe(false);
    expect(isRateLimited({ x: 5.0, y: 0.1 }, 0.4)).toBe(false);
  });

  it('returns false when either axis is zero (no measurement)', () => {
    // Zero ratio means motion-diff failed to measure that axis at all
    // (no emit along it, or noise rejected). Treat as "no signal" not
    // "rate-limited".
    expect(isRateLimited({ x: 0, y: 0.1 }, 0.4)).toBe(false);
    expect(isRateLimited({ x: 0.1, y: 0 }, 0.4)).toBe(false);
    expect(isRateLimited({ x: 0, y: 0 }, 0.4)).toBe(false);
  });

  it('returns false when ratios are at normal iPadOS variance', () => {
    // Healthy iPad relative-mouse ratios are 1.0-3.0+ depending on pace
    // and chunk size. None of these should be flagged.
    expect(isRateLimited({ x: 1.0, y: 1.5 }, 0.4)).toBe(false);
    expect(isRateLimited({ x: 3.0, y: 3.7 }, 0.4)).toBe(false);
    expect(isRateLimited({ x: 5.0, y: 5.0 }, 0.4)).toBe(false);
  });

  it('returns false when both axes negative (not physically meaningful but defensive)', () => {
    expect(isRateLimited({ x: -0.5, y: -0.5 }, 0.4)).toBe(false);
  });

  it('boundary: ratio exactly at threshold is NOT rate-limited', () => {
    // Strict less-than; ratio exactly at threshold passes through.
    expect(isRateLimited({ x: 0.4, y: 0.4 }, 0.4)).toBe(false);
  });

  it('threshold parameter is respected', () => {
    // Live data showed 0.829 — would NOT be limited at threshold 0.4
    // (the default) but WOULD be limited at threshold 1.0.
    expect(isRateLimited({ x: 0.829, y: 0.78 }, 0.4)).toBe(false);
    expect(isRateLimited({ x: 0.829, y: 0.78 }, 1.0)).toBe(true);
  });
});
