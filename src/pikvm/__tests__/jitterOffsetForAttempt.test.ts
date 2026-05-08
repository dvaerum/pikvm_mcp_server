/**
 * Phase 191 (v0.5.180): pin the contract of `jitterOffsetForAttempt`.
 *
 * The retry orchestrator (`clickAtWithRetry`) calls this helper before
 * every retry > 1 to compute a deterministic cursor displacement that
 * deliberately approaches the target on a *different trajectory* than
 * the previous attempt. iPadOS pointer-effect snap zones are axis-
 * aligned; correlated retry failures previously stuck on the same
 * snap zone. Diagonal-first rosette breaks the correlation.
 *
 * Pattern: 8-step compass rosette starting at NE, indexed by
 * `(attemptIndex − 2) mod 8`:
 *   1 → no jitter (baseline)
 *   2 → NE (+,+)
 *   3 → SE (+,-)
 *   4 → SW (-,-)
 *   5 → NW (-,+)
 *   6 → E  (+,0)
 *   7 → S  (0,-)
 *   8 → W  (-,0)
 *   9 → N  (0,+)
 *  10 → NE again (wraps)
 *
 * Pure function; no I/O; deterministic. Magnitudes are clamped to
 * the ±127 PiKVM range via the existing `chunkMickeys` helper.
 */

import { describe, expect, it } from 'vitest';
import { jitterOffsetForAttempt } from '../click-verify.js';

describe('jitterOffsetForAttempt', () => {
  describe('attempt 1 (baseline)', () => {
    it('returns {0, 0} regardless of magnitude', () => {
      expect(jitterOffsetForAttempt(1, 50)).toEqual({ dx: 0, dy: 0 });
      expect(jitterOffsetForAttempt(1, 200)).toEqual({ dx: 0, dy: 0 });
      expect(jitterOffsetForAttempt(1, 1)).toEqual({ dx: 0, dy: 0 });
    });

    it('returns {0, 0} for attemptIndex < 1 (defensive — should not be called this way)', () => {
      expect(jitterOffsetForAttempt(0, 50)).toEqual({ dx: 0, dy: 0 });
      expect(jitterOffsetForAttempt(-1, 50)).toEqual({ dx: 0, dy: 0 });
    });
  });

  describe('attempt 2-9 trace the 8-step compass rosette starting at NE', () => {
    // M=50: cos45° = sin45° ≈ 0.707 → 50 * 0.707 ≈ 35
    // The exact rounding is what production code does; lock it in.
    it('attempt 2 → NE (+35, +35) at magnitude 50', () => {
      expect(jitterOffsetForAttempt(2, 50)).toEqual({ dx: 35, dy: 35 });
    });

    it('attempt 3 → SE (+35, −35)', () => {
      expect(jitterOffsetForAttempt(3, 50)).toEqual({ dx: 35, dy: -35 });
    });

    it('attempt 4 → SW (−35, −35)', () => {
      expect(jitterOffsetForAttempt(4, 50)).toEqual({ dx: -35, dy: -35 });
    });

    it('attempt 5 → NW (−35, +35)', () => {
      expect(jitterOffsetForAttempt(5, 50)).toEqual({ dx: -35, dy: 35 });
    });

    it('attempt 6 → E (+50, 0)', () => {
      expect(jitterOffsetForAttempt(6, 50)).toEqual({ dx: 50, dy: 0 });
    });

    it('attempt 7 → S (0, −50)', () => {
      expect(jitterOffsetForAttempt(7, 50)).toEqual({ dx: 0, dy: -50 });
    });

    it('attempt 8 → W (−50, 0)', () => {
      expect(jitterOffsetForAttempt(8, 50)).toEqual({ dx: -50, dy: 0 });
    });

    it('attempt 9 → N (0, +50)', () => {
      expect(jitterOffsetForAttempt(9, 50)).toEqual({ dx: 0, dy: 50 });
    });
  });

  describe('rosette wraps every 8 steps', () => {
    it('attempt 10 produces same offset as attempt 2 (NE)', () => {
      expect(jitterOffsetForAttempt(10, 50)).toEqual(
        jitterOffsetForAttempt(2, 50),
      );
    });

    it('attempt 11 produces same offset as attempt 3 (SE)', () => {
      expect(jitterOffsetForAttempt(11, 50)).toEqual(
        jitterOffsetForAttempt(3, 50),
      );
    });

    it('attempt 17 produces same offset as attempt 9 (N — full cycle + 1)', () => {
      expect(jitterOffsetForAttempt(17, 50)).toEqual(
        jitterOffsetForAttempt(9, 50),
      );
    });
  });

  describe('magnitude edge cases', () => {
    it('magnitude=0 → {0, 0} regardless of attempt', () => {
      expect(jitterOffsetForAttempt(2, 0)).toEqual({ dx: 0, dy: 0 });
      expect(jitterOffsetForAttempt(5, 0)).toEqual({ dx: 0, dy: 0 });
    });

    it('magnitude=NaN → {0, 0}', () => {
      expect(jitterOffsetForAttempt(2, NaN)).toEqual({ dx: 0, dy: 0 });
    });

    it('negative magnitude → {0, 0} (treated as opt-out)', () => {
      expect(jitterOffsetForAttempt(2, -1)).toEqual({ dx: 0, dy: 0 });
      expect(jitterOffsetForAttempt(2, -50)).toEqual({ dx: 0, dy: 0 });
    });

    it('magnitude=Infinity → {0, 0} (defensive — non-finite)', () => {
      expect(jitterOffsetForAttempt(2, Infinity)).toEqual({ dx: 0, dy: 0 });
    });
  });

  describe('PiKVM ±127 clamping via chunkMickeys', () => {
    it('magnitude=200 cardinal-axis attempt clamps to ±127', () => {
      // Attempt 6 = E, raw would be (200, 0); clamp → (127, 0)
      expect(jitterOffsetForAttempt(6, 200)).toEqual({ dx: 127, dy: 0 });
    });

    it('magnitude=200 diagonal attempt clamps both axes (200·cos45° ≈ 141 → 127)', () => {
      // Attempt 2 = NE, raw would be (~141, ~141); clamp both → (127, 127)
      expect(jitterOffsetForAttempt(2, 200)).toEqual({ dx: 127, dy: 127 });
    });

    it('magnitude exactly at ±127 boundary unchanged', () => {
      // Attempt 6 = E, raw (127, 0); no clamp needed
      expect(jitterOffsetForAttempt(6, 127)).toEqual({ dx: 127, dy: 0 });
    });
  });

  describe('coverage / sanity', () => {
    it('all 8 directions in attempts 2-9 are pairwise distinct at magnitude 50', () => {
      const offsets = new Set<string>();
      for (let i = 2; i <= 9; i++) {
        const { dx, dy } = jitterOffsetForAttempt(i, 50);
        offsets.add(`${dx},${dy}`);
      }
      expect(offsets.size).toBe(8);
    });

    it('the 4 diagonal attempts (2-5) come BEFORE the 4 cardinal attempts (6-9) — by design, diagonals first', () => {
      // Diagonals have BOTH dx and dy non-zero; cardinals have one zero.
      for (let i = 2; i <= 5; i++) {
        const { dx, dy } = jitterOffsetForAttempt(i, 50);
        expect(dx).not.toBe(0);
        expect(dy).not.toBe(0);
      }
      for (let i = 6; i <= 9; i++) {
        const { dx, dy } = jitterOffsetForAttempt(i, 50);
        expect(dx === 0 || dy === 0).toBe(true);
      }
    });
  });
});
