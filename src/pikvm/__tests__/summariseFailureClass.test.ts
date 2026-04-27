/**
 * Phase 93 — unit tests for classifySkipReason and summariseFailureClass.
 *
 * The two pure helpers that aggregate per-attempt skip reasons into a
 * one-line operator-facing diagnosis when every attempt of a retry loop
 * failed under the same skip class.
 *
 * Pinning the contract here lets us add new skip categories in the
 * future without breaking the existing 5 by accident.
 */

import { describe, expect, it } from 'vitest';
import {
  classifySkipReason,
  summariseFailureClass,
} from '../click-verify.js';

describe('classifySkipReason', () => {
  it('returns null for undefined (non-skipped attempt)', () => {
    expect(classifySkipReason(undefined)).toBeNull();
  });

  it('classifies the "moveToPixel threw" prefix as move-failed', () => {
    expect(
      classifySkipReason('moveToPixel threw: cursor cannot be located'),
    ).toBe('move-failed');
  });

  it('classifies the "rate-limit:" prefix as rate-limit', () => {
    expect(
      classifySkipReason('rate-limit: ratio < 0.4'),
    ).toBe('rate-limit');
  });

  it('classifies the "cursor not verified" exact string as cursor-not-verified', () => {
    expect(classifySkipReason('cursor not verified')).toBe('cursor-not-verified');
  });

  it('classifies "residual NN.Npx > maxResidualPx=N" as residual-too-large', () => {
    expect(
      classifySkipReason('residual 78.1px > maxResidualPx=25'),
    ).toBe('residual-too-large');
  });

  it('classifies the Phase 51 disagree-reason patterns as pre-click-disagree', () => {
    expect(
      classifySkipReason('best match score 0.412 < 0.5'),
    ).toBe('pre-click-disagree');
    expect(
      classifySkipReason(
        'narrow window had no match; best full-frame match (score=0.953) at (200,300) is 250 px from claimed cursor (50,55) — algorithm lied',
      ),
    ).toBe('pre-click-disagree');
    expect(
      classifySkipReason('no template match anywhere in frame'),
    ).toBe('pre-click-disagree');
  });

  it('returns null for unrecognised reasons (forward-compat: a new skip class should NOT be silently aggregated under an existing class)', () => {
    expect(classifySkipReason('some new future skip reason')).toBeNull();
  });
});

describe('summariseFailureClass', () => {
  it('returns null for empty history', () => {
    expect(summariseFailureClass([])).toBeNull();
  });

  it('returns null for single-attempt history (no class-level pattern yet)', () => {
    expect(
      summariseFailureClass([{ skippedClickReason: 'cursor not verified' }]),
    ).toBeNull();
  });

  it('returns null when at least one attempt is not a recognised skip', () => {
    expect(
      summariseFailureClass([
        { skippedClickReason: 'cursor not verified' },
        { skippedClickReason: 'cursor not verified' },
        {}, // no skipped reason — successful attempt or non-skip failure
      ]),
    ).toBeNull();
  });

  it('returns null when ≥ 2 distinct skip classes are present (mixed history → no clear diagnosis)', () => {
    expect(
      summariseFailureClass([
        { skippedClickReason: 'cursor not verified' },
        { skippedClickReason: 'residual 78.1px > maxResidualPx=25' },
      ]),
    ).toBeNull();
  });

  it('summarises a 3-attempt residual-too-large run with actionable text', () => {
    const summary = summariseFailureClass([
      { skippedClickReason: 'residual 60.0px > maxResidualPx=25' },
      { skippedClickReason: 'residual 78.1px > maxResidualPx=25' },
      { skippedClickReason: 'residual 95.4px > maxResidualPx=25' },
    ]);
    expect(summary).not.toBeNull();
    expect(summary).toMatch(/All 3 attempts skipped/);
    expect(summary).toMatch(/maxResidualPx/);
  });

  it('summarises a 2-attempt cursor-not-verified run with the pikvm_ipad_unlock hint', () => {
    const summary = summariseFailureClass([
      { skippedClickReason: 'cursor not verified' },
      { skippedClickReason: 'cursor not verified' },
    ]);
    expect(summary).not.toBeNull();
    expect(summary).toMatch(/All 2 attempts skipped/);
    expect(summary).toMatch(/pikvm_ipad_unlock|brightness/);
  });

  it('summarises a 3-attempt rate-limit run with the iPad-state hint', () => {
    const summary = summariseFailureClass([
      { skippedClickReason: 'rate-limit: ratio < 0.4' },
      { skippedClickReason: 'rate-limit: ratio < 0.4' },
      { skippedClickReason: 'rate-limit: ratio < 0.4' },
    ]);
    expect(summary).not.toBeNull();
    expect(summary).toMatch(/rate-limit/);
    expect(summary).toMatch(/popup|low-power|accessibility/);
  });

  it('summarises a 2-attempt move-failed run with the autoUnlockOnDetectFail hint', () => {
    const summary = summariseFailureClass([
      { skippedClickReason: 'moveToPixel threw: cursor cannot be located' },
      { skippedClickReason: 'moveToPixel threw: cursor cannot be located' },
    ]);
    expect(summary).not.toBeNull();
    expect(summary).toMatch(/All 2 attempts failed/);
    expect(summary).toMatch(/autoUnlockOnDetectFail|pikvm_ipad_unlock/);
  });

  it('summarises a pre-click-disagree run with the cached-template hint', () => {
    const summary = summariseFailureClass([
      { skippedClickReason: 'best match score 0.412 < 0.5' },
      { skippedClickReason: 'no template match anywhere in frame' },
    ]);
    expect(summary).not.toBeNull();
    expect(summary).toMatch(/pre-click template search/);
    expect(summary).toMatch(/cursor-templates|stale/);
  });
});
