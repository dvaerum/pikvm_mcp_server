/**
 * Phase 148 — regression tests for the Phase 137/140 second-opinion
 * gate (`shouldFireSecondOpinion`) and adopt predicate
 * (`shouldAdoptSecondOpinion`).
 *
 * Phase 137 (v0.5.129) introduced the wake-nudge fallback when motion-
 * diff failed; Phase 140 (v0.5.132) extended the trigger to ALSO fire
 * when motion-diff returned a position but the residual was
 * suspiciously high — caught a live case where motion-diff picked an
 * icon-LABEL feature 30 px below the real cursor. Phase 140 also
 * added the adopt-only-if-closer guard so a wake-nudge frame catching
 * the cursor mid-flight can't quietly REGRESS a good motion-diff
 * match.
 *
 * If a future refactor collapses the two-way OR in shouldFire or
 * removes the strictly-closer guard in shouldAdopt, these tests fail.
 */

import { describe, expect, it } from 'vitest';
import {
  shouldAdoptSecondOpinion,
  shouldFireSecondOpinion,
} from '../click-verify.js';

describe('shouldFireSecondOpinion', () => {
  it('does NOT fire when no templates are cached (nothing to match against)', () => {
    expect(
      shouldFireSecondOpinion({
        hasTemplates: false,
        cursorVerified: false,
        initialResidual: 999,
      }),
    ).toBe(false);
  });

  it('fires when motion-diff failed entirely (cursorVerified=false)', () => {
    expect(
      shouldFireSecondOpinion({
        hasTemplates: true,
        cursorVerified: false,
        initialResidual: Infinity,
      }),
    ).toBe(true);
  });

  it('fires when motion-diff returned a position but residual exceeds the threshold', () => {
    expect(
      shouldFireSecondOpinion({
        hasTemplates: true,
        cursorVerified: true,
        initialResidual: 31,
        secondOpinionResidualPx: 25,
      }),
    ).toBe(true);
  });

  it('does NOT fire when motion-diff was verified AND residual is within the threshold', () => {
    expect(
      shouldFireSecondOpinion({
        hasTemplates: true,
        cursorVerified: true,
        initialResidual: 17,
        secondOpinionResidualPx: 25,
      }),
    ).toBe(false);
  });

  it('boundary: residual === threshold does NOT fire (only > triggers)', () => {
    expect(
      shouldFireSecondOpinion({
        hasTemplates: true,
        cursorVerified: true,
        initialResidual: 25,
        secondOpinionResidualPx: 25,
      }),
    ).toBe(false);
  });

  it('uses default threshold of 25 px when not specified', () => {
    expect(
      shouldFireSecondOpinion({
        hasTemplates: true,
        cursorVerified: true,
        initialResidual: 26,
      }),
    ).toBe(true);
    expect(
      shouldFireSecondOpinion({
        hasTemplates: true,
        cursorVerified: true,
        initialResidual: 24,
      }),
    ).toBe(false);
  });

  it('REGRESSION: collapsing the OR to a single-condition trigger must fail', () => {
    // If a refactor accidentally drops the cursorVerified=false branch
    // (e.g. only triggers on high-residual case), the
    // "motion-diff-failed" path would silently stop firing — these
    // assertions pin both halves.
    expect(
      shouldFireSecondOpinion({
        hasTemplates: true,
        cursorVerified: false,
        initialResidual: 0, // motion-diff failed but residual is 0
      }),
    ).toBe(true);
    expect(
      shouldFireSecondOpinion({
        hasTemplates: true,
        cursorVerified: true,
        initialResidual: 100, // motion-diff "succeeded" but lied
      }),
    ).toBe(true);
  });
});

describe('shouldAdoptSecondOpinion', () => {
  it('adopts when motion-diff was unverified (anything is better than blind)', () => {
    expect(
      shouldAdoptSecondOpinion({
        cursorVerified: false,
        wokenResidual: 200,
        initialResidual: Infinity,
      }),
    ).toBe(true);
  });

  it('adopts when wake-nudge match is strictly closer to target', () => {
    expect(
      shouldAdoptSecondOpinion({
        cursorVerified: true,
        wokenResidual: 17,
        initialResidual: 31,
      }),
    ).toBe(true);
  });

  it('does NOT adopt when wake-nudge match is farther (the Phase 140 regression case)', () => {
    expect(
      shouldAdoptSecondOpinion({
        cursorVerified: true,
        wokenResidual: 50,
        initialResidual: 17,
      }),
    ).toBe(false);
  });

  it('boundary: equal residuals do NOT adopt (strict less-than only)', () => {
    // Avoid swapping for a tie — the cost of swapping (cache invalidation
    // of position-based reasoning downstream) isn't worth a no-op gain.
    expect(
      shouldAdoptSecondOpinion({
        cursorVerified: true,
        wokenResidual: 25,
        initialResidual: 25,
      }),
    ).toBe(false);
  });

  it('REGRESSION: removing the strictly-closer guard must fail', () => {
    // The Phase 140 case: unconditional swap would replace 17 px with
    // 50 px and regress click accuracy. If a future refactor collapses
    // the predicate to "always adopt", this assertion catches it.
    expect(
      shouldAdoptSecondOpinion({
        cursorVerified: true,
        wokenResidual: 999,
        initialResidual: 1,
      }),
    ).toBe(false);
  });
});
