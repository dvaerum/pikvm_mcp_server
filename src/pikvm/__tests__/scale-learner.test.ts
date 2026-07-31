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
    const l = new ScaleLearner({ enabled: true });
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
    expect(l.currentScale('x')).toBe(1.0);
  });

  it('rejects garbage samples before they can move the scale (each hygiene flag)', () => {
    const l = new ScaleLearner({ enabled: true });
    for (const meta of [{ woken: true }, { forced: true }, { aborted: true }, { lowConfidence: true }, { isCorrectionShot: true }]) {
      expect(l.recordSample('y', 800, 900, 1.0364, meta)).toBe('rejected-hygiene');
    }
    expect(l.recordSample('y', 800, NaN, 1.0364)).toBe('rejected-hygiene');
    expect(l.status().y.windowSize).toBe(0);
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
  });

  it('gates out short moves (<150px) — σ/P is noise, not signal', () => {
    const l = new ScaleLearner({ enabled: true });
    expect(l.recordSample('y', 120, 130, 1.0364)).toBe('rejected-gate');
    expect(l.status().y.windowSize).toBe(0);
  });

  it('pre-filters implied scales outside [0.7,1.4] (kills gross V8 FPs)', () => {
    const l = new ScaleLearner({ enabled: true });
    // an FP: achieved wildly off ⇒ implied ~2 ⇒ rejected
    expect(l.recordSample('y', 800, 1600, 1.0364)).toBe('rejected-prefilter');
    expect(l.status().y.windowSize).toBe(0);
  });
});

describe('ScaleLearner — estimator + guards', () => {
  it('adapts toward the windowed-median implied scale once the SE gate clears', () => {
    const l = new ScaleLearner({ enabled: true, now: () => 1000 });
    feed(l, 1.045, 20); // clean P=800 samples imply 1.045 — within the ±1% clamp band + one rate step of default
    expect(l.currentScale('y')).toBeCloseTo(1.045, 3);
    expect(l.status().y.lastUpdate).toBe(1000);
  });

  it('does NOT update until the window SE < 0.5% (a couple of samples is not enough)', () => {
    const l = new ScaleLearner({ enabled: true });
    // 3 samples: n<5 ⇒ SE null ⇒ no update
    for (let i = 0; i < 3; i++) l.recordSample('y', 800, 800 * (1.05 / l.currentScale('y')), l.currentScale('y'));
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
    expect(l.status().y.windowSE).toBeNull();
  });

  it('rate-limits each update to ≤2% of the current scale (no lurch)', () => {
    const l = new ScaleLearner({ enabled: true });
    // imply 1.15 (way above default 1.0364) — the FIRST update (at 16 samples = 8/8
    // balanced) must move only ~2%. (More samples would fire more capped updates.)
    const before = l.currentScale('y');
    feed(l, 1.15, 16);
    const after = l.currentScale('y');
    expect((after - before) / before).toBeLessThanOrEqual(0.0201);
    expect(after).toBeGreaterThan(before); // moved the right direction
  });

  it('clamps the applied scale to ±1% of the shipped default even if samples imply more (#41 experimental-safety bound)', () => {
    const hi = DEFAULT_CURVE_SCALE_Y * 1.01, lo = DEFAULT_CURVE_SCALE_Y * 0.99;
    const up = new ScaleLearner({ enabled: true });
    feed(up, 1.30, 400); // imply 1.30 forever; the rate-limited climb must stop at +1%
    expect(up.currentScale('y')).toBeLessThanOrEqual(hi + 1e-9);
    expect(up.currentScale('y')).toBeCloseTo(hi, 5);
    const down = new ScaleLearner({ enabled: true });
    feed(down, 0.80, 400); // imply 0.80 forever; the descent must stop at −1%
    expect(down.currentScale('y')).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(down.currentScale('y')).toBeCloseTo(lo, 5);
  });

  it('uses the MEDIAN, so a minority of borderline-passing samples do not drag it', () => {
    const l = new ScaleLearner({ enabled: true });
    const push = (target: number, i: number) => { const P = i % 2 === 0 ? 800 : -800; l.recordSample('y', P, P * (target / l.currentScale('y')), l.currentScale('y')); };
    for (let i = 0; i < 16; i++) push(1.03, i);  // balanced majority → median ~1.03
    for (let i = 0; i < 4; i++) push(1.39, i);   // balanced minority (inside prefilter)
    expect(l.currentScale('y')).toBeLessThan(1.06); // median-driven, not dragged toward the 1.39s
  });

  it('BALANCE GATE (task #41): a direction-SKEWED window does NOT update even with SE<0.5%; balancing it enables the update', () => {
    const l = new ScaleLearner({ enabled: true });
    // 20 samples ALL in one direction imply 1.045 with a tiny SE — but the median of a
    // one-sided window is biased (implied is direction-dependent), so no update fires.
    for (let i = 0; i < 20; i++) l.recordSample('y', 800, 800 * (1.045 / l.currentScale('y')), l.currentScale('y'));
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y); // frozen — window unbalanced
    expect(l.status().y.windowSE).toBeLessThan(0.005);       // SE alone WOULD have passed
    expect(l.status().y.windowBalance).toEqual({ up: 20, down: 0 });
    // now add the other direction — once ≥8 each, the update fires.
    for (let i = 0; i < 10; i++) l.recordSample('y', -800, -800 * (1.045 / l.currentScale('y')), l.currentScale('y'));
    expect(l.currentScale('y')).toBeCloseTo(1.045, 2);
  });

  it('ships the STABLE median clamped ±1%: the two-cluster offset profile that made the SLOPE wander stays bounded + stable (#41)', () => {
    const l = new ScaleLearner({ enabled: true });
    // The rig's REAL profile: only two |planned| per axis (888, 444), both signs, plus a
    // constant −5px offset — the exact conditions under which the (unbiased) regression
    // slope wandered ±2-3% on hardware (the rate cap converts two-cluster slope noise
    // straight into applied wander). The median we ship instead stays pinned inside the
    // ±1% clamp and does not wander. This locks in WHY median+clamp is the shipped choice.
    const S = 1.031, c = -5;
    const lo = DEFAULT_CURVE_SCALE_Y * 0.99, hi = DEFAULT_CURVE_SCALE_Y * 1.01;
    const trace: number[] = [];
    for (let round = 0; round < 20; round++) {
      for (const dist of [888, 444]) {
        for (const sign of [1, -1]) {
          const s = l.currentScale('y');
          l.recordSample('y', sign * dist, sign * (dist * (S / s) + c), s);
        }
      }
      trace.push(l.currentScale('y'));
    }
    for (const v of trace) {                              // never leaves the ±1% clamp
      expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(v).toBeLessThanOrEqual(hi + 1e-9);
    }
    const tail = trace.slice(10);                         // STABLE: no ±2-3% wander
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.01);
    // and the drift DETECTION still reads the true offset-biased estimate (the reliable half)
    expect(l.status().y.estimatedScale).not.toBeNull();
  });
});

describe('ScaleLearner — controls + persistence', () => {
  it('disable freezes (rejects samples, keeps the current value); enable resumes', () => {
    const l = new ScaleLearner({ enabled: true });
    feed(l, 1.05, 20);
    const frozen = l.currentScale('y');
    l.disable();
    expect(l.recordSample('y', 800, 900, l.currentScale('y'))).toBe('rejected-disabled');
    expect(l.currentScale('y')).toBe(frozen); // unchanged
    expect(l.status().active).toBe(false);
    l.enable();
    expect(l.status().active).toBe(true);
  });

  it('status distinguishes DISABLED from IDLE (both sit at warm-start defaults, 0 samples)', () => {
    const idle = new ScaleLearner({ enabled: true });
    expect(idle.status().state).toBe('idle (no qualifying samples yet)'); // opted in, nothing learned yet
    feed(idle, 1.045, 20);
    expect(idle.status().state).toBe('learning');
    idle.disable();
    expect(idle.status().state).toBe('disabled');                         // frozen ≠ idle
    const off = new ScaleLearner({ enabled: false });
    expect(off.status().state).toBe('disabled');                          // not opted in
  });

  it('reset reverts to the shipped defaults and clears the window', () => {
    const l = new ScaleLearner({ enabled: true });
    feed(l, 1.05, 20);
    expect(l.currentScale('y')).not.toBe(DEFAULT_CURVE_SCALE_Y);
    l.reset();
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);
    expect(l.status().y.windowSize).toBe(0);
    expect(l.status().y.accepted).toBe(0);
  });

  it('OFF by default (not opted in): inert, no tools would register, mover uses the static default (#41)', () => {
    const l = new ScaleLearner({ enabled: false });
    expect(l.isActive()).toBe(false);
    expect(l.isFeatureEnabled()).toBe(false);
    expect(l.recordSample('y', 800, 900, 1.0364)).toBe('rejected-disabled');
    expect(l.currentScale('y')).toBe(DEFAULT_CURVE_SCALE_Y);       // true no-op — static default
    expect(l.status().featureEnabled).toBe(false);
    expect(l.status().active).toBe(false);
    expect(l.status().experimental).toBe(true);
  });

  it('reads the opt-in from PIKVM_MOVER_LEARN=1 when no explicit flag is passed', () => {
    const prev = process.env.PIKVM_MOVER_LEARN;
    try {
      process.env.PIKVM_MOVER_LEARN = '1';
      expect(new ScaleLearner().isFeatureEnabled()).toBe(true);
      delete process.env.PIKVM_MOVER_LEARN;
      expect(new ScaleLearner().isFeatureEnabled()).toBe(false); // default OFF
      process.env.PIKVM_MOVER_LEARN = '0';
      expect(new ScaleLearner().isFeatureEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PIKVM_MOVER_LEARN; else process.env.PIKVM_MOVER_LEARN = prev;
    }
  });

  it('loadSnapshot clamps an out-of-band persisted value; snapshot round-trips the scale', () => {
    const l = new ScaleLearner({ enabled: true });
    l.loadSnapshot({ y: { applied: 9.9, lastUpdate: 5 } }); // corrupt/huge
    expect(l.currentScale('y')).toBeLessThanOrEqual(DEFAULT_CURVE_SCALE_Y * 1.01 + 1e-9); // clamped to +1%, not injected
    const l2 = new ScaleLearner({ enabled: true });
    l2.loadSnapshot({ y: { applied: 1.031, lastUpdate: 5 } });
    expect(l2.currentScale('y')).toBeCloseTo(1.031, 5);
    expect(l2.snapshot().y.applied).toBeCloseTo(1.031, 5);
  });

  it('counters are SESSION-scoped: after a load, accepted+rejected ≤ seen (no accepted>seen nonsense)', () => {
    const l = new ScaleLearner({ enabled: true });
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
    const l = new ScaleLearner({ enabled: true });
    // achieved = planned + 20px CONSTANT offset (distance-independent) across varied P
    for (const P of [200, 300, 400, 500, 600, 700, 800, 850]) {
      l.recordSample('y', P, P + 20, l.currentScale('y'));
    }
    const w = l.status().y.warnings.join(' ');
    expect(w).toMatch(/constant .*offset .* detector/i);
    expect(l.status().y.intercept).toBeGreaterThan(10);
  });

  it('warns when the ESTIMATE diverges >2% from the shipped default (re-bake signal survives the ±1% clamp)', () => {
    const l = new ScaleLearner({ enabled: true });
    feed(l, 1.13, 400); // applied is clamped to +1%, but the UNCLAMPED estimate (~1.13) drives the warning
    expect(l.status().y.warnings.join(' ')).toMatch(/from shipped default/i);
    expect(l.status().y.estimatedScale).toBeCloseTo(1.13, 2);
  });

  it('DEFECT A regression: sub-150px moves (rejected-gate) do NOT trigger the detector-degraded alarm', () => {
    const l = new ScaleLearner({ enabled: true });
    for (let i = 0; i < 20; i++) l.recordSample('x', 80, 82, 1.0); // all below the floor = normal traffic
    expect(l.status().x.warnings.join(' ')).not.toMatch(/detector/i);
    expect(l.status().x.rejected).toBe(20);
  });

  it('a high PREFILTER-reject rate among QUALIFIED (≥150px) moves DOES flag a degraded detector', () => {
    const l = new ScaleLearner({ enabled: true });
    for (let i = 0; i < 12; i++) l.recordSample('x', 800, 1600, 1.0); // implied ~2 → prefilter reject
    for (let i = 0; i < 3; i++) l.recordSample('x', 800, 800, 1.0);    // clean
    expect(l.status().x.warnings.join(' ')).toMatch(/detector likely degraded/i);
  });

  it('DEFECT B regression: direction asymmetry (±P back-and-forth) does NOT masquerade as an intercept alarm', () => {
    const l = new ScaleLearner({ enabled: true });
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
    const l = new ScaleLearner({ enabled: true });
    // consistent multiplicative overshoot (achieved = 1.01·planned), no constant
    // offset ⇒ residual = 0.01·P is pure SLOPE, intercept ≈ 0.
    for (const P of [200, 300, 400, 500, 600, 700, 800, 850]) {
      l.recordSample('y', P, P * 1.01, l.currentScale('y'));
    }
    expect(l.status().y.warnings.join(' ')).not.toMatch(/detector/i);
  });
});
