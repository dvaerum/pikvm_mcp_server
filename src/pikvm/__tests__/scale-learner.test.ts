import { describe, it, expect } from 'vitest';
import { ScaleLearner } from '../scale-learner.js';
import { DEFAULT_CURVE_SCALE_Y } from '../curve-mover.js';

/** Feed N clean long-move samples on axis y that imply a target scale, ALTERNATING
 *  ±direction so the balance gate (≥8/direction) is satisfied. implied =
 *  sApplied·(achieved/planned) = target ⇒ achieved = planned · target / sApplied
 *  (sign of planned carries through). Use n≥16 for the first update to fire. */
function feed(l: ScaleLearner, target: number, n: number, P = 800, axis: 'x' | 'y' = 'y') {
  let last = '';
  for (let i = 0; i < n; i++) {
    const sApplied = l.currentScale(axis);
    const planned = i % 2 === 0 ? P : -P; // alternate direction
    const achieved = planned * (target / sApplied);
    last = l.recordSample(axis, planned, achieved, sApplied);
  }
  return last;
}

describe('ScaleLearner — warm start + hygiene', () => {
  it('warm-starts from the shipped defaults (Y=1.0364, X=1.0), never from 1.0-cold', () => {
    const l = new ScaleLearner({ killSwitch: false });
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
    expect(l.currentScale('x')).toBe(1.0);
  });

  it('rejects garbage samples before they can move the scale (each hygiene flag)', () => {
    const l = new ScaleLearner({ killSwitch: false });
    for (const meta of [{ woken: true }, { forced: true }, { aborted: true }, { lowConfidence: true }, { isCorrectionShot: true }]) {
      expect(l.recordSample('y', 800, 900, 1.0364, meta)).toBe('rejected-hygiene');
    }
    expect(l.recordSample('y', 800, NaN, 1.0364)).toBe('rejected-hygiene');
    expect(l.status().y.windowSize).toBe(0);
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
  });

  it('gates out short moves (<150px) — σ/P is noise, not signal', () => {
    const l = new ScaleLearner({ killSwitch: false });
    expect(l.recordSample('y', 120, 130, 1.0364)).toBe('rejected-gate');
    expect(l.status().y.windowSize).toBe(0);
  });

  it('pre-filters implied scales outside [0.7,1.4] (kills gross V8 FPs)', () => {
    const l = new ScaleLearner({ killSwitch: false });
    // an FP: achieved wildly off ⇒ implied ~2 ⇒ rejected
    expect(l.recordSample('y', 800, 1600, 1.0364)).toBe('rejected-prefilter');
    expect(l.status().y.windowSize).toBe(0);
  });
});

describe('ScaleLearner — estimator + guards', () => {
  it('adapts toward the windowed-median implied scale once the SE gate clears', () => {
    const l = new ScaleLearner({ killSwitch: false, now: () => 1000 });
    feed(l, 1.05, 20); // 12 clean P=800 samples imply 1.05 (within band, within one rate step of default)
    expect(l.currentScale('y')).toBeCloseTo(1.05, 2);
    expect(l.status().y.lastUpdate).toBe(1000);
  });

  it('does NOT update until the window SE < 0.5% (a couple of samples is not enough)', () => {
    const l = new ScaleLearner({ killSwitch: false });
    // 3 samples: n<5 ⇒ SE null ⇒ no update
    for (let i = 0; i < 3; i++) l.recordSample('y', 800, 800 * (1.05 / l.currentScale('y')), l.currentScale('y'));
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
    expect(l.status().y.windowSE).toBeNull();
  });

  it('rate-limits each update to ≤2% of the current scale (no lurch)', () => {
    const l = new ScaleLearner({ killSwitch: false });
    // imply 1.15 (way above default 1.0364) — the FIRST update (at 16 samples = 8/8
    // balanced) must move only ~2%. (More samples would fire more capped updates.)
    const before = l.currentScale('y');
    feed(l, 1.15, 16);
    const after = l.currentScale('y');
    expect((after - before) / before).toBeLessThanOrEqual(0.0201);
    expect(after).toBeGreaterThan(before); // moved the right direction
  });

  it('clamps the applied scale to [0.85,1.15] even if samples imply more', () => {
    const l = new ScaleLearner({ killSwitch: false });
    feed(l, 1.30, 400); // imply 1.30 for a long time; rate-limited climb must stop at 1.15
    expect(l.currentScale('y')).toBeLessThanOrEqual(1.15 + 1e-9);
    expect(l.currentScale('y')).toBeCloseTo(1.15, 2);
  });

  it('uses the MEDIAN, so a minority of borderline-passing samples do not drag it', () => {
    const l = new ScaleLearner({ killSwitch: false });
    const push = (target: number, i: number) => { const P = i % 2 === 0 ? 800 : -800; l.recordSample('y', P, P * (target / l.currentScale('y')), l.currentScale('y')); };
    for (let i = 0; i < 16; i++) push(1.03, i);  // balanced majority → median ~1.03
    for (let i = 0; i < 4; i++) push(1.39, i);   // balanced minority (inside prefilter)
    expect(l.currentScale('y')).toBeLessThan(1.06); // median-driven, not dragged toward the 1.39s
  });

  it('BALANCE GATE (task #41): a direction-SKEWED window does NOT update even with SE<0.5%; balancing it enables the update', () => {
    const l = new ScaleLearner({ killSwitch: false });
    // 20 samples ALL in one direction imply 1.05 with a tiny SE — but the median of a
    // one-sided window is biased (implied is direction-dependent), so no update fires.
    for (let i = 0; i < 20; i++) l.recordSample('y', 800, 800 * (1.05 / l.currentScale('y')), l.currentScale('y'));
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y); // frozen — window unbalanced
    expect(l.status().y.windowSE).toBeLessThan(0.005);       // SE alone WOULD have passed
    expect(l.status().y.windowBalance).toEqual({ up: 20, down: 0 });
    // now add the other direction — once ≥8 each, the update fires.
    for (let i = 0; i < 10; i++) l.recordSample('y', -800, -800 * (1.05 / l.currentScale('y')), l.currentScale('y'));
    expect(l.currentScale('y')).toBeCloseTo(1.05, 2);
  });
});

describe('ScaleLearner — controls + persistence', () => {
  it('disable freezes (rejects samples, keeps the current value); enable resumes', () => {
    const l = new ScaleLearner({ killSwitch: false });
    feed(l, 1.05, 20);
    const frozen = l.currentScale('y');
    l.disable();
    expect(l.recordSample('y', 800, 900, l.currentScale('y'))).toBe('rejected-disabled');
    expect(l.currentScale('y')).toBe(frozen); // unchanged
    expect(l.status().enabled).toBe(false);
    l.enable();
    expect(l.status().enabled).toBe(true);
  });

  it('reset reverts to the shipped defaults and clears the window', () => {
    const l = new ScaleLearner({ killSwitch: false });
    feed(l, 1.05, 20);
    expect(l.currentScale('y')).not.toBe(DEFAULT_CURVE_SCALE_Y);
    l.reset();
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
    expect(l.status().y.windowSize).toBe(0);
    expect(l.status().y.accepted).toBe(0);
  });

  it('the env kill-switch (PIKVM_MOVER_LEARN=0) freezes at defaults, no session needed', () => {
    const l = new ScaleLearner({ killSwitch: true });
    expect(l.isActive()).toBe(false);
    expect(l.recordSample('y', 800, 900, 1.0364)).toBe('rejected-disabled');
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
    expect(l.status().killSwitch).toBe(true);
  });

  it('loadSnapshot clamps an out-of-band persisted value; snapshot round-trips the scale', () => {
    const l = new ScaleLearner({ killSwitch: false });
    l.loadSnapshot({ y: { applied: 9.9, lastUpdate: 5 } }); // corrupt/huge
    expect(l.currentScale('y')).toBeLessThanOrEqual(1.15); // clamped, not injected
    const l2 = new ScaleLearner({ killSwitch: false });
    l2.loadSnapshot({ y: { applied: 1.031, lastUpdate: 5 } });
    expect(l2.currentScale('y')).toBeCloseTo(1.031, 5);
    expect(l2.snapshot().y.applied).toBeCloseTo(1.031, 5);
  });

  it('counters are SESSION-scoped: after a load, accepted+rejected ≤ seen (no accepted>seen nonsense)', () => {
    const l = new ScaleLearner({ killSwitch: false });
    // a restore only sets the learned scale — NOT a cumulative accepted alongside a
    // session-zero seen (the status-tool inconsistency georgs caught on the rig).
    l.loadSnapshot({ x: { applied: 1.0, lastUpdate: 5 }, y: { applied: 1.031, lastUpdate: 9 } });
    for (const ax of ['x', 'y'] as const) {
      const s = l.status()[ax];
      expect(s.seen).toBe(0);
      expect(s.accepted).toBe(0);
      expect(s.rejected).toBe(0);
      expect(s.accepted + s.rejected).toBeLessThanOrEqual(s.seen); // invariant, always
    }
    // and it holds after real traffic too
    for (let i = 0; i < 10; i++) l.recordSample('y', 800, 820, l.currentScale('y'));
    for (let i = 0; i < 5; i++) l.recordSample('y', 80, 82, 1.0); // sub-floor rejects
    const y = l.status().y;
    expect(y.accepted + y.rejected).toBeLessThanOrEqual(y.seen);
  });
});

describe('ScaleLearner — fault discrimination (slope vs intercept)', () => {
  it('warns on a sustained constant landing INTERCEPT (detector/pacing fault, not geometry)', () => {
    const l = new ScaleLearner({ killSwitch: false });
    // achieved = planned + 20px CONSTANT offset (distance-independent) across varied P
    for (const P of [200, 300, 400, 500, 600, 700, 800, 850]) {
      l.recordSample('y', P, P + 20, l.currentScale('y'));
    }
    const w = l.status().y.warnings.join(' ');
    expect(w).toMatch(/constant .*offset .* detector/i);
    expect(l.status().y.intercept).toBeGreaterThan(10);
  });

  it('warns when divergence from the shipped default exceeds 2% (re-bake signal)', () => {
    const l = new ScaleLearner({ killSwitch: false });
    feed(l, 1.13, 400); // push well past 2% from 1.0364
    expect(l.status().y.warnings.join(' ')).toMatch(/from shipped default/i);
  });

  it('DEFECT A regression: sub-150px moves (rejected-gate) do NOT trigger the detector-degraded alarm', () => {
    const l = new ScaleLearner({ killSwitch: false });
    for (let i = 0; i < 20; i++) l.recordSample('x', 80, 82, 1.0); // all below the floor = normal traffic
    expect(l.status().x.warnings.join(' ')).not.toMatch(/detector/i);
    expect(l.status().x.rejected).toBe(20);
  });

  it('a high PREFILTER-reject rate among QUALIFIED (≥150px) moves DOES flag a degraded detector', () => {
    const l = new ScaleLearner({ killSwitch: false });
    for (let i = 0; i < 12; i++) l.recordSample('x', 800, 1600, 1.0); // implied ~2 → prefilter reject
    for (let i = 0; i < 3; i++) l.recordSample('x', 800, 800, 1.0);    // clean
    expect(l.status().x.warnings.join(' ')).toMatch(/detector likely degraded/i);
  });

  it('DEFECT B regression: direction asymmetry (±P back-and-forth) does NOT masquerade as an intercept alarm', () => {
    const l = new ScaleLearner({ killSwitch: false });
    // up-moves overshoot 3.72%, down-moves 3.14% (the real #39 asymmetry), NO detector fault.
    for (const d of [300, 500, 700, 800, 850]) {
      l.recordSample('y', d, d * 1.0372, 1.0);   // up:  +3.72%
      l.recordSample('y', -d, -d * 1.0314, 1.0); // down: +3.14% overshoot in the −direction
    }
    const st = l.status().y;
    expect(Math.abs(st.intercept ?? 0)).toBeLessThan(10);          // asymmetry ≠ a false intercept
    expect(st.warnings.join(' ')).not.toMatch(/detector|offset/i); // no false fault alarm
  });

  it('a clean scale drift (pure slope, ~zero intercept) does NOT raise the detector-fault alarm', () => {
    const l = new ScaleLearner({ killSwitch: false });
    // consistent multiplicative overshoot (achieved = 1.01·planned), no constant
    // offset ⇒ residual = 0.01·P is pure SLOPE, intercept ≈ 0.
    for (const P of [200, 300, 400, 500, 600, 700, 800, 850]) {
      l.recordSample('y', P, P * 1.01, l.currentScale('y'));
    }
    expect(l.status().y.warnings.join(' ')).not.toMatch(/detector/i);
  });
});
