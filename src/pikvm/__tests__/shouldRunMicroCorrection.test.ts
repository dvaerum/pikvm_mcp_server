/**
 * Phase 152 — regression tests for shouldRunMicroCorrection.
 *
 * Phase 49 (v0.5.37) introduced the bounds-aware micro-correction
 * loop that runs after moveToPixel and template-matches the cursor
 * to issue tight corrective emits. The loop's three entry conditions
 * are subtle: dropping any of them either skips a feature the caller
 * wanted (microCorrectionIterations > 0), runs an expensive no-op
 * cycle (hasTemplates), or runs the template-match without spatial
 * bias and risks false-positives (hasInitialPosition).
 */

import { describe, expect, it } from 'vitest';
import { shouldRunMicroCorrection } from '../click-verify.js';

describe('shouldRunMicroCorrection', () => {
  it('runs when all three conditions hold', () => {
    expect(
      shouldRunMicroCorrection({
        microCorrectionIterations: 8,
        hasTemplates: true,
        hasInitialPosition: true,
      }),
    ).toBe(true);
  });

  it('does NOT run when caller explicitly disabled the loop (iterations=0)', () => {
    expect(
      shouldRunMicroCorrection({
        microCorrectionIterations: 0,
        hasTemplates: true,
        hasInitialPosition: true,
      }),
    ).toBe(false);
  });

  it('does NOT run when no cursor templates are loaded', () => {
    // Without templates the per-iteration findCursorByTemplateSet
    // returns null on every call; the loop wastes a screenshot+settle
    // cycle before exiting on the first iteration.
    expect(
      shouldRunMicroCorrection({
        microCorrectionIterations: 8,
        hasTemplates: false,
        hasInitialPosition: true,
      }),
    ).toBe(false);
  });

  it('does NOT run without an initial position from moveToPixel', () => {
    // The initial position is the locality hint for the first
    // template-match. Without it the search has no spatial bias and
    // is at much higher risk of returning a wallpaper false-positive.
    expect(
      shouldRunMicroCorrection({
        microCorrectionIterations: 8,
        hasTemplates: true,
        hasInitialPosition: false,
      }),
    ).toBe(false);
  });

  it('rejects negative iteration counts (defensive)', () => {
    expect(
      shouldRunMicroCorrection({
        microCorrectionIterations: -1,
        hasTemplates: true,
        hasInitialPosition: true,
      }),
    ).toBe(false);
  });

  it('REGRESSION: collapsing the three-way AND must fail', () => {
    // If any single guard is dropped, at least one of these
    // single-flip negative cases must flip from false to true.
    expect(
      shouldRunMicroCorrection({
        microCorrectionIterations: 0,
        hasTemplates: true,
        hasInitialPosition: true,
      }),
    ).toBe(false);
    expect(
      shouldRunMicroCorrection({
        microCorrectionIterations: 8,
        hasTemplates: false,
        hasInitialPosition: true,
      }),
    ).toBe(false);
    expect(
      shouldRunMicroCorrection({
        microCorrectionIterations: 8,
        hasTemplates: true,
        hasInitialPosition: false,
      }),
    ).toBe(false);
  });
});
