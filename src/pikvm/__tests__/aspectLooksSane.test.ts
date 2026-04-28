/**
 * Phase 157 — regression tests for aspectLooksSane.
 *
 * The orientation module's bounds detection cross-checks the aspect
 * ratio of detected iPad bounds before trusting them. Dark-mode apps
 * (e.g. Files canvas at full black) can shrink the vertical bounds
 * because the iPad's solid-black render is indistinguishable from
 * HDMI letterbox black. Reusing a previously-good detection is the
 * simplest robust fallback when the current detection's aspect is
 * suspect.
 *
 * The threshold [0.55, 0.85] is calibrated:
 *  - iPad 4:3 ≈ 0.75
 *  - iPad 3:2 ≈ 0.667
 *  - iPad 4:3 minus minor letterbox crop can drift to ~0.6
 *  - JPEG noise on edges can push the ratio another few %
 *
 * Narrowing the bounds (e.g. [0.62, 0.78]) would reject valid iPad
 * detections under modest noise; widening them (e.g. [0.4, 1.0]) lets
 * non-iPad ratios slip through.
 */

import { describe, expect, it } from 'vitest';
import { aspectLooksSane } from '../orientation.js';

describe('aspectLooksSane', () => {
  it('accepts a perfect 4:3 iPad ratio (0.75)', () => {
    expect(aspectLooksSane(1024, 768)).toBe(true);
  });

  it('accepts a perfect 3:2 iPad ratio (0.667)', () => {
    expect(aspectLooksSane(1500, 1000)).toBe(true);
  });

  it('is symmetric — orientation does not matter', () => {
    expect(aspectLooksSane(1024, 768)).toBe(aspectLooksSane(768, 1024));
    expect(aspectLooksSane(1500, 1000)).toBe(aspectLooksSane(1000, 1500));
  });

  it('accepts 16:9 (0.5625) — within [0.55, 0.85] tolerance', () => {
    // The bounds are wide on purpose; the function is a loose
    // "not totally bonkers" filter, not strict iPad-only. 16:9
    // detections happen if non-iPad target is connected.
    expect(aspectLooksSane(1920, 1080)).toBe(true);
  });

  it('rejects square (1:1) detections — ratio 1.0 > 0.85 ceiling', () => {
    // Square crops typically mean the detection lost one of the long
    // edges (e.g. the bottom got cropped to match the side bezels);
    // shouldn't be trusted as an iPad bounds.
    expect(aspectLooksSane(800, 800)).toBe(false);
  });

  it('boundary: ratio exactly 0.55 returns true', () => {
    // 11:20 = 0.55 exactly — must be accepted (>= semantics).
    expect(aspectLooksSane(11, 20)).toBe(true);
  });

  it('boundary: ratio exactly 0.85 returns true', () => {
    // 17:20 = 0.85 exactly — must be accepted (<= semantics).
    expect(aspectLooksSane(17, 20)).toBe(true);
  });

  it('boundary: just below 0.55 returns false', () => {
    expect(aspectLooksSane(54, 100)).toBe(false);
  });

  it('boundary: just above 0.85 returns false', () => {
    expect(aspectLooksSane(86, 100)).toBe(false);
  });

  it('handles iPad detections with modest noise (within tolerance)', () => {
    // 4:3 = 0.75; with 5% letterbox shrink on the long axis, ratio
    // becomes ~0.79 — still well within [0.55, 0.85].
    expect(aspectLooksSane(1024, 810)).toBe(true);
  });

  it('REGRESSION: narrowing bounds to [0.62, 0.78] would reject these valid iPads', () => {
    // The actual bounds are wider than strict iPad aspect on purpose
    // — for noise tolerance. If a refactor tightens to [0.62, 0.78]
    // these would flip to false:
    expect(aspectLooksSane(11, 20)).toBe(true); // 0.55
    expect(aspectLooksSane(17, 20)).toBe(true); // 0.85
    expect(aspectLooksSane(800, 1430)).toBe(true); // 0.559
  });

  it('REGRESSION: widening above 0.85 lets square crops through', () => {
    // The 0.85 ceiling exists so that detections that lost a long
    // edge (and ended up nearly square) get rejected. Widening to
    // 1.0 would accept those degenerate cases.
    expect(aspectLooksSane(800, 800)).toBe(false); // 1.0 — should reject
    expect(aspectLooksSane(900, 1000)).toBe(false); // 0.9 — should reject
  });

  it('REGRESSION: narrowing the floor below 0.55 lets ultra-wide through', () => {
    // The 0.55 floor exists so that ultra-wide / dual-monitor
    // detections (ratio ≈ 0.42) get rejected.
    expect(aspectLooksSane(2560, 1080)).toBe(false); // ≈ 0.422 — should reject
  });
});
