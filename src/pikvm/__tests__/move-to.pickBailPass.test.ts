/**
 * Phase 285 unit tests for `pickBailPass` — pure helper that decides
 * whether moveToPixel should return an earlier verified pass's
 * position instead of the final pass when the final pass returned
 * null.
 *
 * Production motivation: Phase 280 frame-by-frame inspection showed
 * the iPad cursor often visible at intermediate passes (~70 px from
 * target) but absent by the final pass. When the final pass returns
 * null, returning the best earlier verified landing yields a more
 * accurate click than trusting (or skipping) the absent final.
 *
 * Initial impl bailed on smaller-claimed-residual too. Live N=60
 * bench showed that hurt click rate 20 pp because the detector's
 * residual claim can be wrong (high-score widget FPs report small
 * residuals). So pickBailPass now only fires on null-final.
 */
import { describe, expect, it } from 'vitest';
import { pickBailPass, type MovePassDiagnostic } from '../move-to.js';

function diag(
  pass: number,
  mode: MovePassDiagnostic['mode'],
  residualPx: number,
  detectedAt: { x: number; y: number } = { x: 0, y: 0 },
): MovePassDiagnostic {
  return {
    pass,
    mode,
    detectedAt,
    residualPx,
    ratioUsed: { x: 1, y: 1 },
    reason: null,
    linearPhase: false,
  };
}

describe('pickBailPass', () => {
  it('returns -1 when no diagnostics and no final detection', () => {
    expect(pickBailPass([], Infinity)).toBe(-1);
  });

  it('returns -1 when final detection exists (any finite residual)', () => {
    // Even with a very large final residual, an earlier pass should
    // NOT be substituted. Final detection is the freshest signal.
    const diagnostics: MovePassDiagnostic[] = [
      diag(0, 'motion', 30, { x: 750, y: 800 }),
      diag(1, 'motion', 25, { x: 755, y: 805 }),
    ];
    expect(pickBailPass(diagnostics, 500)).toBe(-1);
    expect(pickBailPass(diagnostics, 50)).toBe(-1);
    expect(pickBailPass(diagnostics, 0)).toBe(-1);
  });

  it('returns -1 when final is null but only predicted-mode passes exist', () => {
    const diagnostics: MovePassDiagnostic[] = [
      diag(0, 'predicted', 30),
      diag(1, 'predicted', 25),
    ];
    expect(pickBailPass(diagnostics, Infinity)).toBe(-1);
  });

  it('bails to verified pass when final is null', () => {
    const diagnostics: MovePassDiagnostic[] = [
      diag(0, 'motion', 100, { x: 800, y: 800 }),
      diag(1, 'motion', 50, { x: 750, y: 800 }),
      diag(2, 'predicted', 50),
    ];
    expect(pickBailPass(diagnostics, Infinity)).toBe(1);
  });

  it('picks the smallest-residual verified pass when multiple exist', () => {
    const diagnostics: MovePassDiagnostic[] = [
      diag(0, 'motion', 80),
      diag(1, 'template', 30, { x: 755, y: 830 }),
      diag(2, 'shape', 50),
      diag(3, 'predicted', 50),
    ];
    expect(pickBailPass(diagnostics, Infinity)).toBe(1);
  });

  it('treats motion/template/shape modes equivalently as verified', () => {
    const diagnostics: MovePassDiagnostic[] = [
      diag(0, 'motion', 50),
      diag(1, 'template', 70),
      diag(2, 'shape', 30),
    ];
    expect(pickBailPass(diagnostics, Infinity)).toBe(2);
  });

  it('ignores predicted-mode passes even when their residualPx is small', () => {
    const diagnostics: MovePassDiagnostic[] = [
      diag(0, 'predicted', 5),
      diag(1, 'motion', 30),
    ];
    expect(pickBailPass(diagnostics, Infinity)).toBe(1);
  });

  it('returns the FIRST occurrence on ties (stable order)', () => {
    const diagnostics: MovePassDiagnostic[] = [
      diag(0, 'motion', 30, { x: 1, y: 1 }),
      diag(1, 'motion', 30, { x: 2, y: 2 }),
    ];
    expect(pickBailPass(diagnostics, Infinity)).toBe(0);
  });

  it('returns -1 when diagnostics is empty even on null final', () => {
    expect(pickBailPass([], Infinity)).toBe(-1);
  });
});
