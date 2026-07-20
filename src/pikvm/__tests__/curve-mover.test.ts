import { describe, it, expect } from 'vitest';
import { mickeysForReport, planAxisEmits, EMIT_CURVE_X, FULL_REPORT_PX } from '../curve-mover.js';

describe('mickeysForReport (invert the single-report curve)', () => {
  it('maps 0 px to 0 mickeys', () => {
    expect(mickeysForReport(0)).toBe(0);
  });
  it('recovers exact curve knots', () => {
    // 8 mickeys → 4.9 px, so 4.9 px → 8 mickeys
    expect(mickeysForReport(4.9)).toBe(8);
    expect(mickeysForReport(49)).toBe(40);
    expect(mickeysForReport(157)).toBe(127);
  });
  it('interpolates between knots', () => {
    // between 4.9(8) and 8.2(12): 6.5px ~ 10 mickeys
    const m = mickeysForReport(6.5);
    expect(m).toBeGreaterThan(8);
    expect(m).toBeLessThan(12);
  });
  it('clamps above the full-report displacement to 127', () => {
    expect(mickeysForReport(FULL_REPORT_PX + 50)).toBe(127);
  });
  it('is sign-agnostic (takes magnitude)', () => {
    expect(mickeysForReport(-49)).toBe(40);
  });
});

describe('planAxisEmits (burst plan for a signed distance)', () => {
  it('returns a single partial report for a short move', () => {
    expect(planAxisEmits(4.9)).toEqual([8]);
  });
  it('preserves sign (negative distance → negative emits)', () => {
    expect(planAxisEmits(-4.9)).toEqual([-8]);
  });
  it('drops sub-2px remainders (below resolvable step)', () => {
    expect(planAxisEmits(1)).toEqual([]);
  });
  it('uses full ±127 reports plus a partial for long moves', () => {
    // 300px = 157 (one full report) + 143 remainder
    const plan = planAxisEmits(300);
    expect(plan[0]).toBe(127);
    expect(plan.length).toBe(2);
    expect(plan[1]).toBeGreaterThan(0);
    expect(plan[1]).toBeLessThanOrEqual(127);
  });
  it('long negative move: all reports negative', () => {
    const plan = planAxisEmits(-450);
    expect(plan.every((e) => e < 0)).toBe(true);
    expect(plan.filter((e) => e === -127).length).toBe(2); // 450 = 2×157 + 136
  });
  it('scale > 1 (bigger geometry) needs FEWER mickeys for the same px', () => {
    // reference: 49px → 40 mickeys. If actual displacement is 1.5× (scale=1.5),
    // 49px needs only mickeysForReport(49/1.5)=mickeysForReport(32.7) < 40.
    const refPlan = planAxisEmits(49, undefined, undefined, 1);
    const scaledPlan = planAxisEmits(49, undefined, undefined, 1.5);
    expect(scaledPlan[0]).toBeLessThan(refPlan[0]);
  });
  it('scale splits a long move into fewer full reports (each moves scale×full)', () => {
    // 300px at scale=2: each full report moves 2×157=314>300 → 0 full + partial
    const plan = planAxisEmits(300, undefined, undefined, 2);
    expect(plan.filter((e) => Math.abs(e) === 127).length).toBe(0);
  });
  it('scale=1 is unchanged from the default', () => {
    expect(planAxisEmits(300, undefined, undefined, 1)).toEqual(planAxisEmits(300));
  });

  it('curve knots are monotonic in both px and mickeys', () => {
    for (let i = 1; i < EMIT_CURVE_X.length; i++) {
      expect(EMIT_CURVE_X[i][0]).toBeGreaterThan(EMIT_CURVE_X[i - 1][0]);
      expect(EMIT_CURVE_X[i][1]).toBeGreaterThan(EMIT_CURVE_X[i - 1][1]);
    }
  });
});
