/**
 * Phase 147 — regression tests for shouldFireDismissRecipe.
 *
 * Phase 141 (v0.5.133) added an auto-dismiss recipe (Escape+Enter)
 * between retries when a click fires at a verified cursor position
 * but produces zero screen change — the documented signature of an
 * iOS hidden HDMI-blocked security popup eating the input. Phase 147
 * extracted the gate predicate so a future revert (e.g. someone
 * collapsing the four-way AND back to a single condition) fails a
 * regression test instead of silently disabling the popup recovery.
 */

import { describe, expect, it } from 'vitest';
import { shouldFireDismissRecipe } from '../click-verify.js';

const baseFire = {
  cursorVerified: true,
  screenChanged: false,
  changedFraction: 0,
  attempt: 1,
  maxRetries: 3,
};

describe('shouldFireDismissRecipe', () => {
  it('fires when all four conditions hold', () => {
    expect(shouldFireDismissRecipe(baseFire)).toBe(true);
  });

  it('does NOT fire when cursor was not verified (blind/skipped attempt)', () => {
    expect(shouldFireDismissRecipe({ ...baseFire, cursorVerified: false })).toBe(false);
  });

  it('does NOT fire when the click already produced a screen change', () => {
    expect(shouldFireDismissRecipe({ ...baseFire, screenChanged: true })).toBe(false);
  });

  it('does NOT fire when changedFraction is just above the zero-effect floor', () => {
    // 0.0011 is above 0.001 — represents a small intentional UI
    // toggle (checkbox flicker). Auto-dismissing here would close a
    // user-intended modal.
    expect(shouldFireDismissRecipe({ ...baseFire, changedFraction: 0.0011 })).toBe(false);
  });

  it('fires at the boundary changedFraction === 0.001', () => {
    expect(shouldFireDismissRecipe({ ...baseFire, changedFraction: 0.001 })).toBe(true);
  });

  it('does NOT fire on the final attempt (no retry round to benefit)', () => {
    // attempt=4, maxRetries=3 → we are out of retries; dismissing
    // costs latency for no gain.
    expect(shouldFireDismissRecipe({ ...baseFire, attempt: 4, maxRetries: 3 })).toBe(false);
  });

  it('fires at the boundary attempt === maxRetries (one retry left)', () => {
    expect(shouldFireDismissRecipe({ ...baseFire, attempt: 3, maxRetries: 3 })).toBe(true);
  });

  it('REGRESSION: collapsing the four-way AND to a single condition must fail', () => {
    // If a future refactor removes any one of the four guards, at
    // least one of the negative cases above must flip from false to
    // true. Pin the four guards by asserting all four single-flip
    // negative cases stay false.
    expect(shouldFireDismissRecipe({ ...baseFire, cursorVerified: false })).toBe(false);
    expect(shouldFireDismissRecipe({ ...baseFire, screenChanged: true })).toBe(false);
    expect(shouldFireDismissRecipe({ ...baseFire, changedFraction: 0.5 })).toBe(false);
    expect(shouldFireDismissRecipe({ ...baseFire, attempt: 99, maxRetries: 3 })).toBe(false);
  });
});
