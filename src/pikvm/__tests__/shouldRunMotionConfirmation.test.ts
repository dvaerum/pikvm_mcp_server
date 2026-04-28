/**
 * Phase 151 — regression tests for shouldRunMotionConfirmation.
 *
 * Phase 119 caught a wallpaper-template-match false-positive at
 * (952, 916) score 0.71 against a static gradient feature; the
 * micro-correction loop happily corrected against the phantom and
 * drove the cursor off-target. Phase 120's fix runs
 * cursorMovedAsExpected after each emit to detect non-moving
 * "cursors". This helper gates whether to run that check at all —
 * if any of the three conditions is silently dropped, the gate's
 * defensive behavior fails (e.g. running motion-confirmation on
 * the first iteration NaN-poisons the comparison).
 */

import { describe, expect, it } from 'vitest';
import { shouldRunMotionConfirmation } from '../click-verify.js';

describe('shouldRunMotionConfirmation', () => {
  it('returns false on first iteration (no prevFound)', () => {
    expect(
      shouldRunMotionConfirmation({
        prevFound: null,
        prevEmit: { mx: 5, my: 0 },
      }),
    ).toBe(false);
  });

  it('returns false when prevEmit is null', () => {
    expect(
      shouldRunMotionConfirmation({
        prevFound: { x: 100, y: 200 },
        prevEmit: null,
      }),
    ).toBe(false);
  });

  it('returns false when previous emit was a no-op (0, 0)', () => {
    // No motion expected, so cursor not moving is the expected case;
    // running motion confirmation would falsely trigger the wallpaper
    // guard on every no-op iteration.
    expect(
      shouldRunMotionConfirmation({
        prevFound: { x: 100, y: 200 },
        prevEmit: { mx: 0, my: 0 },
      }),
    ).toBe(false);
  });

  it('runs when previous emit had non-zero X (X-only motion)', () => {
    expect(
      shouldRunMotionConfirmation({
        prevFound: { x: 100, y: 200 },
        prevEmit: { mx: 5, my: 0 },
      }),
    ).toBe(true);
  });

  it('runs when previous emit had non-zero Y (Y-only motion)', () => {
    // REGRESSION: collapsing the OR to (mx !== 0) would silently
    // disable motion confirmation on Y-only emits.
    expect(
      shouldRunMotionConfirmation({
        prevFound: { x: 100, y: 200 },
        prevEmit: { mx: 0, my: 5 },
      }),
    ).toBe(true);
  });

  it('runs when previous emit had both axes', () => {
    expect(
      shouldRunMotionConfirmation({
        prevFound: { x: 100, y: 200 },
        prevEmit: { mx: 3, my: 4 },
      }),
    ).toBe(true);
  });

  it('runs with negative emits (direction matters, not sign)', () => {
    expect(
      shouldRunMotionConfirmation({
        prevFound: { x: 100, y: 200 },
        prevEmit: { mx: -5, my: 0 },
      }),
    ).toBe(true);
    expect(
      shouldRunMotionConfirmation({
        prevFound: { x: 100, y: 200 },
        prevEmit: { mx: 0, my: -5 },
      }),
    ).toBe(true);
  });

  it('REGRESSION: collapsing the OR to single-axis-only must fail', () => {
    // The OR-split is load-bearing; a Y-only emit must trigger
    // motion confirmation because the Phase 119 wallpaper-match case
    // had a gradient feature that wouldn't move on a Y-axis emit
    // either.
    expect(
      shouldRunMotionConfirmation({
        prevFound: { x: 100, y: 200 },
        prevEmit: { mx: 0, my: 7 },
      }),
    ).toBe(true);
  });
});
