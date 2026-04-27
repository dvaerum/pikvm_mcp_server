/**
 * Phase 88 — unit tests for residualForSkip.
 *
 * The pure helper that backs clickAtWithRetry's maxResidualPx skip-click
 * gate. Returns null (no skip) when residual is within budget, returns
 * the residual number (skip) when exceeded, returns null (no skip) when
 * the option is undefined.
 */

import { describe, expect, it } from 'vitest';
import { residualForSkip } from '../click-verify.js';

describe('residualForSkip', () => {
  it('returns null when maxResidualPx is undefined (opt-out)', () => {
    expect(
      residualForSkip({ x: 100, y: 100 }, { x: 0, y: 0 }, undefined),
    ).toBeNull();
  });

  it('returns null when residual is within budget', () => {
    // Cursor at (10, 10), target (0, 0), residual = sqrt(200) ≈ 14.14 px.
    expect(
      residualForSkip({ x: 10, y: 10 }, { x: 0, y: 0 }, 25),
    ).toBeNull();
  });

  it('returns the residual when it exceeds budget', () => {
    // Cursor at (50, 50), target (0, 0), residual = sqrt(5000) ≈ 70.71 px.
    const residual = residualForSkip({ x: 50, y: 50 }, { x: 0, y: 0 }, 25);
    expect(residual).not.toBeNull();
    expect(residual).toBeCloseTo(70.71, 1);
  });

  it('boundary: residual exactly equal to maxResidualPx is NOT skipped', () => {
    // Cursor at (3, 4), target (0, 0), residual = 5 (3-4-5 triangle).
    expect(
      residualForSkip({ x: 3, y: 4 }, { x: 0, y: 0 }, 5),
    ).toBeNull();
  });

  it('boundary: residual just over maxResidualPx IS skipped', () => {
    // Cursor at (3, 4), target (0, 0), residual = 5. maxResidualPx = 4.99.
    const residual = residualForSkip({ x: 3, y: 4 }, { x: 0, y: 0 }, 4.99);
    expect(residual).toBeCloseTo(5, 5);
  });

  it("REGRESSION (Phase 87 live failure): 78 px residual triggers skip at 25", () => {
    // The exact live trace: targeted Software Update at (1090, 416),
    // cursor landed at (1030, 466), residual ≈ 78 px. Phase 88's
    // maxResidualPx=25 should refuse this click.
    const residual = residualForSkip(
      { x: 1030, y: 466 },
      { x: 1090, y: 416 },
      25,
    );
    expect(residual).not.toBeNull();
    expect(residual).toBeCloseTo(78.1, 1);
  });

  it('REGRESSION: same scenario with maxResidualPx=100 does NOT skip (loose threshold)', () => {
    expect(
      residualForSkip({ x: 1030, y: 466 }, { x: 1090, y: 416 }, 100),
    ).toBeNull();
  });
});
