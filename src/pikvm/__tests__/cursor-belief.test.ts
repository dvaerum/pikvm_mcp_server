/**
 * Phase 192-A (v0.5.181): cursor-belief — Kalman-style state estimator
 * for the on-screen mouse cursor.
 *
 * Replaces scattered point-in-time hints (`expectedNear`,
 * `predictedPostOpen`, `lastMoveResult.finalDetectedPosition`,
 * `lastMoveResult.usedPxPerMickey`) with one coherent probabilistic
 * belief that:
 *   - predicts forward on every mouse emit using a per-axis ratio
 *     (mean + variance)
 *   - corrects on every successful detection using a confidence-
 *     weighted Kalman gain
 *   - knows when iPadOS clamped the cursor to a screen edge and
 *     inflates variance on the clipped axis (we know it's *somewhere
 *     on the edge*, not exactly where)
 *
 * Live trajectory data (Phase 192, 2026-05-09) drives this design:
 *   - Per-chunk px/mickey ratio varies 1.25-1.75 within a single
 *     trajectory → ratio variance is required.
 *   - 12 chunks against the right wall produced zero visible motion
 *     while the algorithm assumed +400 px of travel → edge clip is
 *     required.
 *   - State must persist across calls → owned by PiKVMClient (Phase B).
 *
 * Pure / deterministic / no I/O. Fully unit-testable.
 */

import { describe, expect, it } from 'vitest';
import { CursorBelief } from '../cursor-belief.js';

describe('CursorBelief', () => {
  describe('construction', () => {
    it('initializes at the given position with the given confidence', () => {
      const b = new CursorBelief({
        initialPosition: { x: 500, y: 400 },
        initialPositionVariance: 1, // very confident
      });
      expect(b.position).toEqual({ x: 500, y: 400 });
      expect(b.variance.x).toBeCloseTo(1, 3);
      expect(b.variance.y).toBeCloseTo(1, 3);
    });

    it('seeds ratio prior from a calibrated value', () => {
      const b = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        ratioPrior: { x: 1.4, y: 1.6 },
      });
      expect(b.ratio.x).toBeCloseTo(1.4, 3);
      expect(b.ratio.y).toBeCloseTo(1.6, 3);
    });

    it('falls back to the documented iPad default ratio (1.3) when none given', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      expect(b.ratio.x).toBeCloseTo(1.3, 3);
      expect(b.ratio.y).toBeCloseTo(1.3, 3);
    });
  });

  describe('predict (forward propagation)', () => {
    it('moves position by emit · ratio.mean per axis', () => {
      const b = new CursorBelief({
        initialPosition: { x: 100, y: 100 },
        ratioPrior: { x: 1.5, y: 1.5 },
      });
      b.predict({ dx: 20, dy: 0 });
      expect(b.position.x).toBeCloseTo(100 + 20 * 1.5, 1);
      expect(b.position.y).toBeCloseTo(100, 1);
    });

    it('handles negative emits (sign-preserving)', () => {
      const b = new CursorBelief({
        initialPosition: { x: 500, y: 500 },
        ratioPrior: { x: 1.5, y: 1.5 },
      });
      b.predict({ dx: -10, dy: -10 });
      expect(b.position.x).toBeCloseTo(485, 1);
      expect(b.position.y).toBeCloseTo(485, 1);
    });

    it('zero emit leaves position unchanged but advances time', () => {
      const b = new CursorBelief({ initialPosition: { x: 100, y: 100 } });
      const t0 = b.lastUpdateMs;
      // Force a known time via the optional argument so the test is
      // deterministic.
      b.predict({ dx: 0, dy: 0 }, t0 + 100);
      expect(b.position).toEqual({ x: 100, y: 100 });
      expect(b.lastUpdateMs).toBe(t0 + 100);
    });

    it('widens position variance with emit magnitude (process noise)', () => {
      const b = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        initialPositionVariance: 1,
      });
      const before = b.variance.x;
      b.predict({ dx: 50, dy: 0 });
      expect(b.variance.x).toBeGreaterThan(before);
    });

    it('larger emits add proportionally more variance', () => {
      const a = new CursorBelief({ initialPosition: { x: 0, y: 0 }, initialPositionVariance: 1 });
      const c = new CursorBelief({ initialPosition: { x: 0, y: 0 }, initialPositionVariance: 1 });
      a.predict({ dx: 10, dy: 0 });
      c.predict({ dx: 100, dy: 0 });
      expect(c.variance.x).toBeGreaterThan(a.variance.x);
    });

    it('ratio variance contributes to position variance (uncertain ratio → more spread)', () => {
      const certain = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        ratioPrior: { x: 1.3, y: 1.3 },
        ratioVariancePrior: { x: 0.0001, y: 0.0001 }, // very tight ratio
      });
      const uncertain = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        ratioPrior: { x: 1.3, y: 1.3 },
        ratioVariancePrior: { x: 0.5, y: 0.5 }, // wide ratio
      });
      certain.predict({ dx: 50, dy: 0 });
      uncertain.predict({ dx: 50, dy: 0 });
      expect(uncertain.variance.x).toBeGreaterThan(certain.variance.x);
    });
  });

  describe('clip-to-bounds with variance inflation', () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 800 };

    it('clips predicted X to bounds when emit would project past the right edge', () => {
      const b = new CursorBelief({
        initialPosition: { x: 990, y: 400 },
        bounds,
      });
      // 50 mickeys * 1.3 ratio = 65 px → 990 + 65 = 1055 > width 1000
      b.predict({ dx: 50, dy: 0 });
      expect(b.position.x).toBe(1000); // clamped
    });

    it('inflates the clipped-axis variance (we know cursor is on the edge, not where)', () => {
      const b = new CursorBelief({
        initialPosition: { x: 990, y: 400 },
        initialPositionVariance: 4,
        bounds,
      });
      const xVarBefore = b.variance.x;
      b.predict({ dx: 50, dy: 0 });
      expect(b.variance.x).toBeGreaterThan(xVarBefore);
    });

    it('does NOT inflate the perpendicular axis when only one axis clips', () => {
      const b = new CursorBelief({
        initialPosition: { x: 990, y: 400 },
        initialPositionVariance: 4,
        bounds,
      });
      const yVarBefore = b.variance.y;
      // X clips against right edge; Y emit is 0 so Y variance only grows
      // by the (zero-emit) process noise floor.
      b.predict({ dx: 50, dy: 0 });
      // Y variance may grow slightly from time-decay process noise but
      // should NOT grow more than X variance grew.
      const yVarAfter = b.variance.y;
      expect(b.variance.x).toBeGreaterThan(yVarAfter);
    });

    it('clips on every edge', () => {
      // Right
      const r = new CursorBelief({ initialPosition: { x: 990, y: 400 }, bounds });
      r.predict({ dx: 50, dy: 0 });
      expect(r.position.x).toBe(1000);
      // Left
      const l = new CursorBelief({ initialPosition: { x: 10, y: 400 }, bounds });
      l.predict({ dx: -50, dy: 0 });
      expect(l.position.x).toBe(0);
      // Top
      const t = new CursorBelief({ initialPosition: { x: 500, y: 10 }, bounds });
      t.predict({ dx: 0, dy: -50 });
      expect(t.position.y).toBe(0);
      // Bottom
      const bo = new CursorBelief({ initialPosition: { x: 500, y: 790 }, bounds });
      bo.predict({ dx: 0, dy: 50 });
      expect(bo.position.y).toBe(800);
    });

    it('without bounds, predicts past-screen positions without clipping', () => {
      const b = new CursorBelief({
        initialPosition: { x: 990, y: 400 },
        // no bounds
      });
      b.predict({ dx: 50, dy: 0 });
      expect(b.position.x).toBeGreaterThan(1000);
    });
  });

  describe('observe (Bayesian correction)', () => {
    it('high-confidence observation tightens variance (collapses belief)', () => {
      const b = new CursorBelief({
        initialPosition: { x: 100, y: 100 },
        initialPositionVariance: 100, // wide
      });
      b.observe({ x: 150, y: 150 }, 1.0); // certain measurement
      // Variance collapses tight; mean shifts toward measurement.
      expect(b.variance.x).toBeLessThan(100);
      expect(b.position.x).toBeGreaterThan(100);
      expect(b.position.x).toBeLessThanOrEqual(150);
    });

    it('low-confidence observation barely moves the mean', () => {
      const b = new CursorBelief({
        initialPosition: { x: 100, y: 100 },
        initialPositionVariance: 1, // tight
      });
      b.observe({ x: 200, y: 200 }, 0.01); // very noisy measurement
      // Belief barely budges from x=100 because measurement is noisy.
      expect(b.position.x).toBeLessThan(110);
    });

    it('confidence=0 → no update at all', () => {
      const b = new CursorBelief({
        initialPosition: { x: 100, y: 100 },
        initialPositionVariance: 10,
      });
      b.observe({ x: 200, y: 200 }, 0);
      expect(b.position).toEqual({ x: 100, y: 100 });
      expect(b.variance.x).toBe(10);
    });

    it('multiple consistent observations converge the mean tighter', () => {
      const b = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        initialPositionVariance: 100,
      });
      for (let i = 0; i < 10; i++) {
        b.observe({ x: 500, y: 500 }, 0.8);
      }
      // Within 2px after 10 observations at confidence 0.8 — Kalman
      // gain at c=0.8 has R≈1.56, so each step pulls the mean by
      // ~P/(P+1.56) of the residual; 10 iterations leave a small gap.
      expect(Math.abs(b.position.x - 500)).toBeLessThan(2);
      expect(b.variance.x).toBeLessThan(10); // tight
    });
  });

  describe('expectedRegion (search-window provider)', () => {
    it('returns a region centred on the current position', () => {
      const b = new CursorBelief({
        initialPosition: { x: 500, y: 400 },
        initialPositionVariance: 25, // σ=5
      });
      const r = b.expectedRegion();
      expect(r.cx).toBe(500);
      expect(r.cy).toBe(400);
    });

    it('region radius scales with variance (uncertainty → wider window)', () => {
      const tight = new CursorBelief({ initialPosition: { x: 0, y: 0 }, initialPositionVariance: 1 });
      const wide  = new CursorBelief({ initialPosition: { x: 0, y: 0 }, initialPositionVariance: 100 });
      const tr = tight.expectedRegion();
      const wr = wide.expectedRegion();
      expect(wr.rx).toBeGreaterThan(tr.rx);
    });

    it('a 95% confidence region is roughly 2σ wide (two-sided)', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 }, initialPositionVariance: 100 }); // σ=10
      const r = b.expectedRegion(0.95);
      // 1D 95% → ~1.96σ ≈ 19.6
      expect(r.rx).toBeGreaterThan(15);
      expect(r.rx).toBeLessThan(25);
    });
  });

  describe('isAtEdge', () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 800 };

    it('returns all-false when cursor is in the interior', () => {
      const b = new CursorBelief({
        initialPosition: { x: 500, y: 400 },
        bounds,
      });
      expect(b.isAtEdge()).toEqual({ north: false, south: false, east: false, west: false });
    });

    it('detects east edge', () => {
      const b = new CursorBelief({
        initialPosition: { x: 995, y: 400 },
        bounds,
      });
      expect(b.isAtEdge()).toMatchObject({ east: true });
    });

    it('detects all four edges independently', () => {
      const e = new CursorBelief({ initialPosition: { x: 999, y: 400 }, bounds });
      expect(e.isAtEdge()).toMatchObject({ east: true, west: false, north: false, south: false });
      const w = new CursorBelief({ initialPosition: { x: 1, y: 400 }, bounds });
      expect(w.isAtEdge()).toMatchObject({ east: false, west: true });
      const n = new CursorBelief({ initialPosition: { x: 500, y: 1 }, bounds });
      expect(n.isAtEdge()).toMatchObject({ north: true });
      const s = new CursorBelief({ initialPosition: { x: 500, y: 799 }, bounds });
      expect(s.isAtEdge()).toMatchObject({ south: true });
    });

    it('detects two edges simultaneously when in a corner', () => {
      const b = new CursorBelief({ initialPosition: { x: 999, y: 799 }, bounds });
      expect(b.isAtEdge()).toMatchObject({ east: true, south: true });
    });

    it('returns all-false when no bounds set', () => {
      const b = new CursorBelief({ initialPosition: { x: 999, y: 999 } });
      expect(b.isAtEdge()).toEqual({ north: false, south: false, east: false, west: false });
    });

    it('uses a configurable edge threshold', () => {
      const b = new CursorBelief({ initialPosition: { x: 985, y: 400 }, bounds });
      expect(b.isAtEdge(5)).toMatchObject({ east: false }); // 15px away from edge
      expect(b.isAtEdge(20)).toMatchObject({ east: true }); // within threshold
    });
  });

  describe('reset (collapse to known observation)', () => {
    it('replaces position with the observation and tightens variance', () => {
      const b = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        initialPositionVariance: 1000,
      });
      b.reset({ x: 500, y: 500 });
      expect(b.position).toEqual({ x: 500, y: 500 });
      expect(b.variance.x).toBeLessThan(10);
    });

    it('zeros velocity (reset implies cursor is freshly known and stationary)', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.reset({ x: 100, y: 100 });
      expect(b.velocity.x).toBe(0);
      expect(b.velocity.y).toBe(0);
    });
  });

  describe('ratio learning (live px/mickey update)', () => {
    it('observe-after-emit refines the ratio estimate', () => {
      const b = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        ratioPrior: { x: 1.3, y: 1.3 },
        ratioVariancePrior: { x: 0.5, y: 0.5 },
      });
      const ratioBefore = b.ratio.x;
      // emit 100 mickeys X; observe cursor moved 170 px → live ratio 1.7
      b.predict({ dx: 100, dy: 0 });
      b.observe({ x: 170, y: 0 }, 0.9);
      // Belief ratio should have moved toward 1.7 from prior 1.3.
      expect(b.ratio.x).toBeGreaterThan(ratioBefore);
    });

    it('repeated consistent observations converge ratio toward truth', () => {
      const b = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        ratioPrior: { x: 1.3, y: 1.3 },
        ratioVariancePrior: { x: 0.5, y: 0.5 },
      });
      for (let i = 0; i < 10; i++) {
        const startX = b.position.x;
        b.predict({ dx: 50, dy: 0 });
        // Ground truth: every 50 mickey emit moves the cursor exactly 75 px (ratio 1.5).
        b.observe({ x: startX + 75, y: 0 }, 0.95);
      }
      expect(b.ratio.x).toBeCloseTo(1.5, 0); // within 0.5
    });

    it('clamps insanely-low live ratio so a noisy single observation does not corrupt belief', () => {
      const b = new CursorBelief({
        initialPosition: { x: 0, y: 0 },
        ratioPrior: { x: 1.3, y: 1.3 },
      });
      b.predict({ dx: 100, dy: 0 });
      // Pathological: cursor "moved" only 10 px (live ratio 0.1).
      // Belief should NOT slam to 0.1; the clamp guards against this.
      b.observe({ x: 10, y: 0 }, 0.9);
      expect(b.ratio.x).toBeGreaterThan(0.5);
    });
  });

  // Phase 212 — stationary-cluster rejection
  describe('stationary-cluster rejection', () => {
    it('observe() returns true on first acceptance and updates belief', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      const accepted = b.observe({ x: 100, y: 100 }, 0.9);
      expect(accepted).toBe(true);
      // Position pulled toward observation (Kalman gain on prior variance 25
      // with c=0.9 gives K≈0.95 so position ≈ 95). Just check we moved.
      expect(b.position.x).toBeGreaterThan(50);
    });

    it('wouldRejectAsStationary returns false before any observation', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      expect(b.wouldRejectAsStationary({ x: 50, y: 50 })).toBe(false);
    });

    it('wouldRejectAsStationary returns false when no emit happened between observations', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 100, y: 100 }, 0.9);
      // No predict() in between → no emit → not stationary lock-in.
      expect(b.wouldRejectAsStationary({ x: 100, y: 100 })).toBe(false);
    });

    it('wouldRejectAsStationary returns true when same pixel returned after a real emit', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 970, y: 771 }, 0.9);
      b.predict({ dx: 50, dy: 0 }); // 50 mickeys ≥ 30 threshold
      expect(b.wouldRejectAsStationary({ x: 970, y: 771 })).toBe(true);
    });

    it('wouldRejectAsStationary respects driftPx threshold', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 970, y: 771 }, 0.9);
      b.predict({ dx: 50, dy: 0 });
      // 6 px drift (default threshold is 5) — outside the lock-in window.
      expect(b.wouldRejectAsStationary({ x: 976, y: 771 })).toBe(false);
      // Within 5 px — locked in.
      expect(b.wouldRejectAsStationary({ x: 973, y: 773 })).toBe(true);
    });

    it('wouldRejectAsStationary respects minEmitMickeys threshold', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 970, y: 771 }, 0.9);
      b.predict({ dx: 10, dy: 0 }); // 10 mickeys < default 30 → no rejection
      expect(b.wouldRejectAsStationary({ x: 970, y: 771 })).toBe(false);
      b.predict({ dx: 25, dy: 0 }); // cumulative 35 ≥ 30 → rejection
      expect(b.wouldRejectAsStationary({ x: 970, y: 771 })).toBe(true);
    });

    it('observe() with rejectStationary=false (default) does not gate', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 970, y: 771 }, 0.9);
      b.predict({ dx: 50, dy: 0 });
      const accepted = b.observe({ x: 970, y: 771 }, 0.9);
      expect(accepted).toBe(true);
    });

    it('observe() with rejectStationary=true returns false on lock-in and does not update belief', () => {
      const b = new CursorBelief({ initialPosition: { x: 970, y: 771 } });
      b.observe({ x: 970, y: 771 }, 0.9);
      b.predict({ dx: 50, dy: 0 }); // belief moves to ~1035
      const xAfterPredict = b.position.x;
      const accepted = b.observe(
        { x: 970, y: 771 },
        0.9,
        { rejectStationary: true },
      );
      expect(accepted).toBe(false);
      // Position should NOT have been pulled back to 970 — the
      // rejected observation has zero influence on belief.
      expect(b.position.x).toBe(xAfterPredict);
    });

    it('observe() accepts a measurement that has clearly moved after an emit', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 970, y: 771 }, 0.9);
      b.predict({ dx: 50, dy: 0 });
      const accepted = b.observe(
        { x: 1035, y: 770 },
        0.9,
        { rejectStationary: true },
      );
      expect(accepted).toBe(true);
    });

    it('emit accumulator resets on accepted observation', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 100, y: 100 }, 0.9);
      b.predict({ dx: 50, dy: 0 });
      b.observe({ x: 165, y: 100 }, 0.9); // accept — accumulator resets
      // Now a smaller emit should NOT re-trigger rejection just because
      // the prior emit accumulated past 30.
      b.predict({ dx: 5, dy: 0 });
      expect(b.wouldRejectAsStationary({ x: 165, y: 100 })).toBe(false);
    });

    it('reset() clears the stationary-cluster history', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 970, y: 771 }, 0.9);
      b.predict({ dx: 50, dy: 0 });
      // Without reset, this would be rejected.
      b.reset({ x: 500, y: 500 });
      expect(b.wouldRejectAsStationary({ x: 970, y: 771 })).toBe(false);
    });

    it('configurable thresholds via options', () => {
      const b = new CursorBelief({ initialPosition: { x: 0, y: 0 } });
      b.observe({ x: 970, y: 771 }, 0.9);
      b.predict({ dx: 100, dy: 0 });
      // Tighter drift threshold (3 px) — 4 px counts as moved.
      expect(b.wouldRejectAsStationary({ x: 974, y: 771 }, { driftPx: 3 })).toBe(false);
      // Higher emit threshold (200) — 100 mickeys is too few to expect motion.
      expect(b.wouldRejectAsStationary({ x: 970, y: 771 }, { minEmitMickeys: 200 })).toBe(false);
    });
  });
});
