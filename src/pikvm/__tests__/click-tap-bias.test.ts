import { describe, it, expect } from 'vitest';
import { CLICK_TAP_BIAS_Y_PX, biasCorrectedAimPoint } from '../click-verify.js';

// Task #38: the tap lands ~5.9px ABOVE (smaller Y) the detected pointer (bias =
// tap − detected = (+0.2, −5.9), N=36, georgs). We correct at the source by aiming
// the pointer LOWER so the tap lands on the requested target. These tests pin the
// DIRECTION so a future sign flip — which would DOUBLE the error instead of removing
// it — fails loudly.

describe('click tap-bias correction (task #38)', () => {
  it('the measured bias is Y-up (tap above detected), Y-only', () => {
    expect(CLICK_TAP_BIAS_Y_PX).toBeCloseTo(-5.9, 5);
    expect(CLICK_TAP_BIAS_Y_PX).toBeLessThan(0); // negative = tap at a smaller Y than detected = above
  });

  it('DIRECTION: aims the pointer LOWER (larger Y), by the measured offset, X untouched', () => {
    const target = { x: 959, y: 561 };
    const aim = biasCorrectedAimPoint(target);
    expect(aim.x).toBe(959); // no horizontal component
    expect(aim.y).toBeGreaterThan(561); // DOWN, not up — the sign that matters
    expect(aim.y).toBeCloseTo(561 + 5.9, 5);
  });

  it('SIGN CORRECTNESS: aim + bias lands exactly on target (a flipped sign would double the miss)', () => {
    const target = { x: 100, y: 200 };
    const aim = biasCorrectedAimPoint(target);
    // If the pointer reaches the aim exactly, the tap = aim + bias must land on target.
    const predictedTap = { x: aim.x, y: aim.y + CLICK_TAP_BIAS_Y_PX };
    expect(predictedTap.x).toBeCloseTo(target.x, 5);
    expect(predictedTap.y).toBeCloseTo(target.y, 5);
    // Guard the wrong sign explicitly: target + bias (aiming UP) would land ~11.8px off.
    const wrongAim = { x: target.x, y: target.y + CLICK_TAP_BIAS_Y_PX };
    const wrongTap = { y: wrongAim.y + CLICK_TAP_BIAS_Y_PX };
    expect(Math.abs(wrongTap.y - target.y)).toBeCloseTo(11.8, 1);
  });
});
