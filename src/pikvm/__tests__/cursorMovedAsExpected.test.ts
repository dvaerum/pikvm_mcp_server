/**
 * Phase 120 — unit tests for cursorMovedAsExpected.
 *
 * Pure helper that decides whether a candidate cursor position from
 * two sequential frames (with a known emit between) actually moved
 * as expected. Used to reject false-positive template-matches against
 * static wallpaper features.
 *
 * Live discovery (Phase 119): findCursorByTemplateSet returned
 * (952, 916) at score 0.71 against EMPTY iPad wallpaper for 30
 * consecutive iterations. The helper here would have rejected those
 * because the candidate's position never changed despite emits.
 */

import { describe, expect, it } from 'vitest';
import { cursorMovedAsExpected } from '../cursor-detect.js';

describe('cursorMovedAsExpected', () => {
  it('REGRESSION (Phase 119): rejects a static candidate (didnt move at all) when motion was expected', () => {
    // The exact failure mode from Phase 119: cursor "found" at the
    // same position twice across an emit of (10, 0) — wallpaper false
    // positive.
    expect(
      cursorMovedAsExpected({ x: 952, y: 916 }, { x: 952, y: 916 }, 10, 0),
    ).toBe(false);
  });

  it('accepts a candidate that moved approximately as expected', () => {
    // Real cursor: emitted +10 X, moved +12 X (1.2 px/mickey). Within
    // tolerance.
    expect(
      cursorMovedAsExpected({ x: 100, y: 100 }, { x: 112, y: 100 }, 10, 0),
    ).toBe(true);
  });

  it('accepts a candidate that moved with 2× iPad acceleration variance', () => {
    // iPad acceleration can produce 2× movement. Emit +10 X → moved
    // +20 X. Should accept (within 50% tolerance of expected 10, but
    // the actual is 20 which is still "moved in the expected
    // direction" past the lower bound).
    expect(
      cursorMovedAsExpected({ x: 100, y: 100 }, { x: 120, y: 100 }, 10, 0),
    ).toBe(true);
  });

  it('rejects a candidate that moved in the WRONG direction', () => {
    // Emit +10 X, but candidate moved -10 X. Wrong direction =
    // not the cursor (or some weird snap behaviour).
    expect(
      cursorMovedAsExpected({ x: 100, y: 100 }, { x: 90, y: 100 }, 10, 0),
    ).toBe(false);
  });

  it('rejects a candidate that moved much LESS than expected (e.g. 1 px when 50 expected)', () => {
    // Emit +50 X but only +1 X observed. Likely false positive (real
    // cursor would move significantly).
    expect(
      cursorMovedAsExpected({ x: 100, y: 100 }, { x: 101, y: 100 }, 50, 0),
    ).toBe(false);
  });

  it('returns true when no motion was expected (degenerate case)', () => {
    // Emit (0, 0) — there's nothing to verify. Don't reject.
    expect(
      cursorMovedAsExpected({ x: 100, y: 100 }, { x: 100, y: 100 }, 0, 0),
    ).toBe(true);
  });

  it('handles diagonal motion', () => {
    // Emit (+10, +10), cursor moved to (+12, +13). Both axes within
    // tolerance.
    expect(
      cursorMovedAsExpected({ x: 0, y: 0 }, { x: 12, y: 13 }, 10, 10),
    ).toBe(true);
  });

  it('handles small emits with the 3px floor tolerance (JPEG / detection noise)', () => {
    // Emit +3 X, cursor moved +5 X. Within absolute floor of 3 px
    // tolerance (50% of 3 = 1.5, but floor kicks in at 3).
    expect(
      cursorMovedAsExpected({ x: 100, y: 100 }, { x: 105, y: 100 }, 3, 0),
    ).toBe(true);
  });

  it('handles negative-axis motion', () => {
    // Emit -20 X, candidate moved from x=100 to x=78 (delta -22).
    // Same direction, within tolerance.
    expect(
      cursorMovedAsExpected({ x: 100, y: 100 }, { x: 78, y: 100 }, -20, 0),
    ).toBe(true);
  });
});
