/**
 * Phase 191 (v0.5.180): pin the default-resolver for inter-retry jitter
 * magnitude. Mirrors the existing `defaultMaxRetriesFor` /
 * `defaultMaxResidualPxFor` / `defaultChunkPaceMsFor` pattern.
 *
 * Contract:
 * - iPad relative mode (mouseAbsoluteMode=false) → 50 mickeys
 *   (≈ 65 px linear / ~150 px accelerated; comfortably outside iPad
 *   icon snap zones at ~70 px without risking off-screen drift)
 * - desktop absolute mode (mouseAbsoluteMode=true) → 0 (disabled —
 *   no pointer-effect snap zones to break)
 */

import { describe, expect, it } from 'vitest';
import { defaultInterRetryJitterFor } from '../click-verify.js';

describe('defaultInterRetryJitterFor', () => {
  it('iPad relative mode → 0 (Phase 192-D flipped from 50; live A/B showed -20pp)', () => {
    expect(defaultInterRetryJitterFor(false)).toBe(0);
  });

  it('desktop absolute mode → 0 (always was; no pointer-effect snap zones to break)', () => {
    expect(defaultInterRetryJitterFor(true)).toBe(0);
  });

  it('always returns a non-negative finite number', () => {
    for (const mode of [true, false]) {
      const v = defaultInterRetryJitterFor(mode);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
