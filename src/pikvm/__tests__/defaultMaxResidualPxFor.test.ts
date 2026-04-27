/**
 * Phase 135 — unit tests for defaultMaxResidualPxFor.
 *
 * Pin the per-mouse-mode contract: iPad (relative) gets 35 px,
 * desktop (absolute) gets undefined. Phase 134's live bench
 * measured 4/15 successful trials at residuals 10-34 px (correct
 * icon) and 11/15 at 36-200 px (wrong icon or empty area). 35 px
 * is the documented icon hit-area on a 70 px-wide iPad icon.
 */

import { describe, expect, it } from 'vitest';
import { defaultMaxResidualPxFor } from '../click-verify.js';

describe('defaultMaxResidualPxFor', () => {
  it('returns 35 for iPad mode (mouseAbsoluteMode=false)', () => {
    expect(defaultMaxResidualPxFor(false)).toBe(35);
  });

  it('returns undefined for desktop mode (mouseAbsoluteMode=true)', () => {
    expect(defaultMaxResidualPxFor(true)).toBeUndefined();
  });

  it('REGRESSION (Phase 135): a removed iPad default would silently let wrong-icon clicks count as success', () => {
    // If someone refactors away the iPad-specific default, this
    // test fails and surfaces the click_at quality regression.
    expect(defaultMaxResidualPxFor(false)).not.toBeUndefined();
    expect(defaultMaxResidualPxFor(false)).toBeLessThanOrEqual(35);
  });
});
