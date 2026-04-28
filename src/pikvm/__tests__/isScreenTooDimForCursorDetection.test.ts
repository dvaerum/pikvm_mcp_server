/**
 * Phase 153 — regression tests for isScreenTooDimForCursorDetection.
 *
 * Phase 38 (v0.5.27) added a fail-fast brightness precheck. Phase
 * 48 (v0.5.36) fixed it after dark-mode iPads (low mean RGB but
 * high stddev from icon/text contrast) were spuriously failing the
 * precheck. The fix added a severity-class guard so only UNIFORM
 * dim frames (severity === 'very-dim') trip the gate.
 *
 * The two-condition AND is load-bearing: collapsing it to just
 * `mean < threshold` would silently re-introduce the dark-mode
 * false-positive that blocked clicks on dark-mode apps before
 * Phase 48 was diagnosed.
 */

import { describe, expect, it } from 'vitest';
import { isScreenTooDimForCursorDetection } from '../click-verify.js';

describe('isScreenTooDimForCursorDetection', () => {
  it('fires on a uniformly-dark frame (low mean, very-dim severity)', () => {
    expect(
      isScreenTooDimForCursorDetection({
        mean: 20,
        severity: 'very-dim',
        minBrightness: 35,
      }),
    ).toBe(true);
  });

  it('does NOT fire on a normal-brightness frame', () => {
    expect(
      isScreenTooDimForCursorDetection({
        mean: 120,
        severity: 'normal',
        minBrightness: 35,
      }),
    ).toBe(false);
  });

  it('does NOT fire on a dark-mode UI (low mean, but severity=dim)', () => {
    // Phase 48's exact regression case: dark-mode iPad had mean
    // around 25-30 (below threshold) but stddev > 3 because of
    // visible icons/text. classifyBrightness scores severity='dim',
    // not 'very-dim'. The gate must NOT fire here — cursor detection
    // works fine on this UI.
    expect(
      isScreenTooDimForCursorDetection({
        mean: 25,
        severity: 'dim',
        minBrightness: 35,
      }),
    ).toBe(false);
  });

  it('does NOT fire when severity is very-dim but mean is at/above threshold', () => {
    // Defensive: a 'very-dim' severity classification with mean >= threshold
    // shouldn't fire because the threshold is the load-bearing fail signal.
    expect(
      isScreenTooDimForCursorDetection({
        mean: 35,
        severity: 'very-dim',
        minBrightness: 35,
      }),
    ).toBe(false);
  });

  it('respects custom minBrightness threshold', () => {
    expect(
      isScreenTooDimForCursorDetection({
        mean: 50,
        severity: 'very-dim',
        minBrightness: 60,
      }),
    ).toBe(true);
    expect(
      isScreenTooDimForCursorDetection({
        mean: 50,
        severity: 'very-dim',
        minBrightness: 40,
      }),
    ).toBe(false);
  });

  it('REGRESSION: dropping the severity guard would re-introduce the dark-mode false-positive', () => {
    // The Phase 48 fix's whole point. If a refactor removes the
    // severity check, this dark-mode case (mean=25, severity=dim)
    // would flip from false to true, blocking clicks on dark-mode
    // apps. Pin both directions: dark-mode must NOT fire, and the
    // very-dim-uniform case MUST fire.
    expect(
      isScreenTooDimForCursorDetection({
        mean: 25,
        severity: 'dim',
        minBrightness: 35,
      }),
    ).toBe(false);
    expect(
      isScreenTooDimForCursorDetection({
        mean: 25,
        severity: 'very-dim',
        minBrightness: 35,
      }),
    ).toBe(true);
  });

  it('REGRESSION: dropping the mean check would fire on bright frames flagged as very-dim by mistake', () => {
    // Defensive against a hypothetical bug in classifyBrightness
    // returning 'very-dim' on a bright frame. The mean threshold
    // is the second line of defense.
    expect(
      isScreenTooDimForCursorDetection({
        mean: 200,
        severity: 'very-dim',
        minBrightness: 35,
      }),
    ).toBe(false);
  });
});
