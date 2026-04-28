/**
 * Phase 150 — regression tests for shouldEmitApproach.
 *
 * Phase 125 (v0.5.119) introduced the in-motion click: send one
 * directional emit toward target then click WITHOUT settling, so
 * iPadOS pointer-effect's snap-to-icon behavior fires while the
 * cursor is moving. The 3 px residual gate prevents wasted emits
 * when the cursor is already inside iPadOS's snap radius (≤ 3 px
 * from target) — adding more motion at sub-pixel distance just
 * injects acceleration noise.
 *
 * Pin the gate so a future "let's tighten this to 1 px for
 * precision" or "drop this gate, more motion is better" doesn't
 * silently regress click_at on small targets.
 */

import { describe, expect, it } from 'vitest';
import { shouldEmitApproach } from '../click-verify.js';

describe('shouldEmitApproach', () => {
  it('does NOT fire when preClickApproachMickeys is 0 (feature disabled)', () => {
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 0,
        cursorKnown: true,
        residual: 50,
      }),
    ).toBe(false);
  });

  it('does NOT fire when cursor position is unknown (would NaN-poison emit math)', () => {
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 10,
        cursorKnown: false,
        residual: 50,
      }),
    ).toBe(false);
  });

  it('fires when residual is well above the snap radius', () => {
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 10,
        cursorKnown: true,
        residual: 30,
      }),
    ).toBe(true);
  });

  it('does NOT fire below the 3 px minimum (sub-pixel jitter)', () => {
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 10,
        cursorKnown: true,
        residual: 2,
      }),
    ).toBe(false);
  });

  it('boundary: residual === 3 px DOES fire (≥ semantics, not >)', () => {
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 10,
        cursorKnown: true,
        residual: 3,
      }),
    ).toBe(true);
  });

  it('respects custom minResidualPx (tighter)', () => {
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 10,
        cursorKnown: true,
        residual: 5,
        minResidualPx: 10,
      }),
    ).toBe(false);
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 10,
        cursorKnown: true,
        residual: 10,
        minResidualPx: 10,
      }),
    ).toBe(true);
  });

  it('rejects negative preClickApproachMickeys (defensive against caller bugs)', () => {
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: -1,
        cursorKnown: true,
        residual: 50,
      }),
    ).toBe(false);
  });

  it('REGRESSION: removing the cursorKnown guard would let blind-cursor emits through', () => {
    // Without the guard, we'd emit based on residual=0 (the
    // fallback), which then triggers an emit toward target without
    // knowing where the cursor is — open-loop overshoot risk.
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 10,
        cursorKnown: false,
        residual: 100,
      }),
    ).toBe(false);
  });

  it('REGRESSION: removing the 3 px gate would emit on sub-pixel residuals', () => {
    // 1 px residual on an icon is well within iPadOS snap radius;
    // emitting adds acceleration variance noise. If the gate is
    // dropped, residual=1 with cursorKnown would fire.
    expect(
      shouldEmitApproach({
        preClickApproachMickeys: 10,
        cursorKnown: true,
        residual: 1,
      }),
    ).toBe(false);
  });
});
