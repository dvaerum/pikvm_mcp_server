/**
 * Phase 95 — regression tests for defaultMaxRetriesFor.
 *
 * Phase 94 made the maxRetries default conditional on mouseAbsoluteMode
 * (the existing pattern used by forbidSlamFallback and minBrightness).
 * Single-shot click_at on iPad is ~50% reliable on tiny targets; with
 * retries=2 it's ~88%. A future revert to a flat default would silently
 * regress the iPad UX — these tests catch that.
 */

import { describe, expect, it } from 'vitest';
import { defaultMaxRetriesFor } from '../click-verify.js';

describe('defaultMaxRetriesFor', () => {
  it('returns 2 for relative-mouse targets (iPad — mouseAbsoluteMode=false)', () => {
    expect(defaultMaxRetriesFor(false)).toBe(2);
  });

  it('returns 0 for absolute-mouse targets (desktop — mouseAbsoluteMode=true)', () => {
    expect(defaultMaxRetriesFor(true)).toBe(0);
  });

  it('REGRESSION: rejects flat default (a future revert removing the conditional must fail this test)', () => {
    // The two paths must produce DIFFERENT defaults — that's the whole
    // point of Phase 94. If someone collapses both branches to the same
    // value, this assertion catches it.
    expect(defaultMaxRetriesFor(true)).not.toBe(defaultMaxRetriesFor(false));
  });
});
