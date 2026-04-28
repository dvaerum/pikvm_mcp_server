/**
 * Phase 149 — regression tests for isDivergenceDetected.
 *
 * Phase 133 (v0.5.125) added an in-loop divergence guard inside
 * clickAtWithRetry's micro-correction loop. Phase 132 bench had
 * observed a trial reach residual 200 px while no-micro-mode
 * reached 23 px on the same target — the loop was pushing the
 * cursor AWAY from target. The guard's slack-px calibration
 * (10 px) is the load-bearing tuning; this test pins it.
 */

import { describe, expect, it } from 'vitest';
import { isDivergenceDetected } from '../click-verify.js';

describe('isDivergenceDetected', () => {
  it('returns false on the first iteration (no prior residual)', () => {
    expect(
      isDivergenceDetected({ prevResidual: null, currentResidual: 50 }),
    ).toBe(false);
  });

  it('detects clear divergence (residual jumped by 50 px)', () => {
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 80 }),
    ).toBe(true);
  });

  it('does NOT trigger on convergence (residual shrinking)', () => {
    expect(
      isDivergenceDetected({ prevResidual: 50, currentResidual: 30 }),
    ).toBe(false);
  });

  it('does NOT trigger on small noise within slack (residual grew 5 px)', () => {
    // 5 px is iPadOS acceleration variance + JPEG noise; the loop
    // should keep iterating, not exit.
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 35 }),
    ).toBe(false);
  });

  it('does NOT trigger at the boundary residual === prev + slack (10 px exact)', () => {
    // Strict greater-than: a 10 px increase is at-the-limit noise,
    // not divergence. Only > 10 px triggers.
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 40 }),
    ).toBe(false);
  });

  it('triggers at prev + slack + 1 (11 px increase)', () => {
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 41 }),
    ).toBe(true);
  });

  it('respects custom slackPx (tight gate)', () => {
    // Override to 0 — any growth is divergence.
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 31, slackPx: 0 }),
    ).toBe(true);
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 30, slackPx: 0 }),
    ).toBe(false);
  });

  it('respects custom slackPx (loose gate)', () => {
    // Override to 100 — only a 100+ px jump triggers.
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 80, slackPx: 100 }),
    ).toBe(false);
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 200, slackPx: 100 }),
    ).toBe(true);
  });

  it('REGRESSION: catches the Phase 132 bench scenario (30→200 px run-away)', () => {
    // The exact failure that motivated Phase 133. If this test fails,
    // the divergence guard is silently disabled and the micro-correction
    // loop will drive the cursor off-screen on the same input pattern.
    expect(
      isDivergenceDetected({ prevResidual: 30, currentResidual: 200 }),
    ).toBe(true);
  });

  it('REGRESSION: removing the prevResidual !== null guard would NaN-poison comparisons', () => {
    // If a refactor accidentally drops the null check, the comparison
    // (null > NaN+10) would have unpredictable behavior. This test
    // pins that the null path is explicitly handled before any
    // arithmetic.
    expect(
      isDivergenceDetected({ prevResidual: null, currentResidual: 9999 }),
    ).toBe(false);
  });
});
