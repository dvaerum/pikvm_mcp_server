import { describe, it, expect } from 'vitest';
import {
  HidLatchMonitor,
  DEFAULT_MONITOR_CONFIG,
  isUdcUp,
  type UdcSample,
  type UdcState,
} from '../hid-latch-monitor.js';

/**
 * Tests are parameterised from the REAL measured distribution on pikvm01 (514
 * re-enumerations), NOT invented numbers — per the iPad node's capture:
 *   inter-arrival gaps: p50 29.7s, worst 300s window 42 events (~7.1s cadence)
 *   the 30s PRE-LATCH storm (exact deltas, seconds):
 *     +1.04 +3.14 +3.15 +1.05 +2.01 +1.47 +3.12 +3.13 +3.14 +3.15 +3.16 +3.17 +3.18
 *   → a metronomic ~3.15s cycle, immediately before the 6.6-day HID latch.
 */
const PRELATCH_DELTAS_S = [1.04, 3.14, 3.15, 1.05, 2.01, 1.47, 3.12, 3.13, 3.14, 3.15, 3.16, 3.17, 3.18];

/** A non-`configured` UDC state (any of these ⇒ HID down). */
const DOWN: UdcState = 'not attached';

/** Build one sample. */
function s(t: number, state: UdcState, reenumCount: number): UdcSample {
  return { t, state, reenumCount };
}

/** Feed a whole stream; return every alert emitted (usually 0 or 1 per latch). */
function run(m: HidLatchMonitor, stream: UdcSample[]) {
  return stream.map((x) => m.observe(x)).filter((a): a is NonNullable<typeof a> => a !== null);
}

/**
 * Sample a continuous UDC timeline at a fixed interval. The timeline is a list of
 * [durationMs, state] segments; reenumCount increments once at the START of every
 * DOWN segment (a re-enumeration = a drop event, matching the dmesg arrival count).
 * This models the ALIASING risk: whether a sampler of a given interval actually
 * LANDS on the short `configured` windows between re-enumerations.
 */
function sampleTimeline(segments: Array<[number, UdcState]>, intervalMs: number): UdcSample[] {
  const out: UdcSample[] = [];
  // Precompute segment boundaries + the reenum counter timeline.
  const bounds: Array<{ start: number; end: number; state: UdcState; reenum: number }> = [];
  let tCursor = 0;
  let reenum = 0;
  for (const [dur, state] of segments) {
    if (!isUdcUp(state)) reenum += 1; // a drop event = one re-enumeration
    bounds.push({ start: tCursor, end: tCursor + dur, state, reenum });
    tCursor += dur;
  }
  const total = tCursor;
  for (let t = 0; t <= total; t += intervalMs) {
    // find the segment covering t (last boundary with start <= t)
    let seg = bounds[0];
    for (const b of bounds) if (b.start <= t) seg = b;
    out.push(s(t, seg.state, seg.reenum));
  }
  return out;
}

describe('isUdcUp — only `configured` is up (HID usable)', () => {
  it('maps configured→up, everything else→down', () => {
    expect(isUdcUp('configured')).toBe(true);
    for (const down of ['not attached', 'addressed', 'default', 'powered', 'suspended', '']) {
      expect(isUdcUp(down)).toBe(false);
    }
  });
});

describe('HidLatchMonitor — quiet on the normal/recoverable cases (STAYS-QUIET leg)', () => {
  it('a long healthy run of `configured` never alerts', () => {
    const m = new HidLatchMonitor();
    const stream = Array.from({ length: 200 }, (_, i) => s(i * 60_000, 'configured', 0));
    expect(run(m, stream)).toHaveLength(0);
  });

  it('a single 1-3s transient blip does not alert (self-heals well under 90s)', () => {
    const m = new HidLatchMonitor();
    const stream = [
      s(0, 'configured', 0),
      s(1_000, DOWN, 1), // blip starts
      s(3_000, 'configured', 1), // back within 3s
      s(63_000, 'configured', 1),
    ];
    expect(run(m, stream)).toHaveLength(0);
  });

  it('ROW A (load-bearing STAYS-QUIET): a recoverable ~7.1s storm WITH real `configured` gaps stays silent for >90s', () => {
    // 7.1s cadence, each cycle: ~2s down then back to configured. The persistence
    // timer resets on EVERY observed `configured`, so a storm that keeps settling
    // — however often it re-enumerates — must never fire. This is the manager's
    // mandatory "zero alerts across a measured storm window" requirement.
    const m = new HidLatchMonitor();
    const stream: UdcSample[] = [];
    let reenum = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      const base = cycle * 7_100;
      stream.push(s(base, DOWN, ++reenum)); // re-enumeration drop
      stream.push(s(base + 2_000, 'configured', reenum)); // settles ~2s later
    }
    // spans ~142s (>90s) with 20 re-enumerations — but always recovers → QUIET.
    expect(run(m, stream)).toHaveLength(0);
  });
});

describe('HidLatchMonitor — fires on a genuine latch and on the never-settling storm (FIRES leg)', () => {
  it('ROW C: a flatline latch (never `configured`, reenum counter FLAT) → alert classified `latched` → recommend soft_connect', () => {
    const m = new HidLatchMonitor();
    const stream: UdcSample[] = [s(0, 'configured', 42)];
    // goes down and stays down; kernel emits NO further re-enumerations (dead).
    for (let t = 1_000; t <= 120_000; t += 5_000) stream.push(s(t, DOWN, 42));
    const alerts = run(m, stream);
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.classification).toBe('latched');
    expect(a.recommendedRung).toBe('soft_connect');
    expect(a.reenumCountInWindow).toBe(0);
    expect(a.downSince).toBe(1_000);
    expect(a.latchDurationMs).toBeGreaterThanOrEqual(DEFAULT_MONITOR_CONFIG.persistenceThresholdMs);
  });

  it('ROW B (load-bearing FIRES): the ~3.15s pre-latch metronome that never reaches `configured` → alert classified `thrashing` → recommend power_cable', () => {
    // This is the EXACT pattern that preceded the 6.6-day outage. It re-enumerates
    // every ~3.15s but never settles to `configured`, so no sample ever resets the
    // timer → it must FIRE. The high reenum count in the window distinguishes it
    // from a flatline latch: a rebind won't fix an under-volt storm — flag power/cable.
    // ⚠️ If a future change makes this row QUIET, it has broken the detector for the
    // precursor to the real incident. Do NOT "fix" this as a false positive.
    const m = new HidLatchMonitor();
    const stream: UdcSample[] = [s(0, 'configured', 0)];
    let t = 0;
    let reenum = 0;
    // replay the real pre-latch deltas, then continue the ~3.15s metronome past 90s,
    // never returning to `configured`.
    const deltas = [...PRELATCH_DELTAS_S];
    while (t < 120_000) {
      const d = deltas.length ? deltas.shift()! : 3.15;
      t += d * 1_000;
      reenum += 1; // each cycle is a re-enumeration attempt that fails to settle
      stream.push(s(Math.round(t), DOWN, reenum));
    }
    const alerts = run(m, stream);
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.classification).toBe('thrashing');
    expect(a.recommendedRung).toBe('power_cable');
    expect(a.reenumCountInWindow).toBeGreaterThan(DEFAULT_MONITOR_CONFIG.latchReenumMax);
  });

  it('fires EXACTLY ONCE per latch and re-arms only after an observed `configured`', () => {
    const m = new HidLatchMonitor();
    const down: UdcSample[] = [s(0, 'configured', 0)];
    for (let t = 1_000; t <= 200_000; t += 5_000) down.push(s(t, DOWN, 0));
    expect(run(m, down)).toHaveLength(1); // one alert despite the latch lasting way past threshold

    // recovery, then a fresh latch → a new alert.
    expect(m.observe(s(205_000, 'configured', 0))).toBeNull(); // re-arm
    const second: UdcSample[] = [];
    for (let t = 206_000; t <= 320_000; t += 5_000) second.push(s(t, DOWN, 0));
    expect(run(m, second)).toHaveLength(1);
  });
});

describe('HidLatchMonitor — per-target healthy state (rig-dependent baseline)', () => {
  it('NEGATIVE CONTROL: a legitimately-uncabled box whose baseline is `not attached` never alerts', () => {
    // it-03400's appliance reads `not attached` on every boot (nothing cabled) —
    // that is its CORRECT baseline. With healthyState set accordingly, a constant
    // `not attached` stream must stay QUIET (else the monitor alerts forever → muted).
    const m = new HidLatchMonitor({ healthyState: 'not attached' });
    const stream = Array.from({ length: 200 }, (_, i) => s(i * 60_000, 'not attached', 0));
    expect(run(m, stream)).toHaveLength(0);
    expect(m.isHealthy('not attached')).toBe(true);
    expect(m.isHealthy('configured')).toBe(false);
  });

  it('with the default healthy state (`configured`), `not attached` IS the fault and a sustained run fires', () => {
    const m = new HidLatchMonitor();
    expect(m.isHealthy('configured')).toBe(true);
    const stream: UdcSample[] = [s(0, 'configured', 0)];
    for (let t = 1_000; t <= 120_000; t += 5_000) stream.push(s(t, DOWN, 0));
    expect(run(m, stream)).toHaveLength(1);
  });
});

describe('HidLatchMonitor — adaptive cadence', () => {
  it('desiredIntervalMs: baseline while up, escalated once a down-window opens, back to baseline on recovery', () => {
    const m = new HidLatchMonitor();
    m.observe(s(0, 'configured', 0));
    expect(m.desiredIntervalMs()).toBe(DEFAULT_MONITOR_CONFIG.baselineIntervalMs);
    m.observe(s(60_000, DOWN, 1));
    expect(m.desiredIntervalMs()).toBe(DEFAULT_MONITOR_CONFIG.escalatedIntervalMs);
    m.observe(s(61_000, 'configured', 1));
    expect(m.desiredIntervalMs()).toBe(DEFAULT_MONITOR_CONFIG.baselineIntervalMs);
  });
});

describe('ANTI-ALIAS property — the escalated interval must be ≤ the shortest `configured` window', () => {
  // ⚠️ PROVISIONAL — update from the iPad node's 10ms distribution capture.
  // On-box measurement (10 real re-enumerations) found down-windows ≤220ms with a
  // mid-burst inter-arrival of ~21.6s, i.e. the `configured` windows are the LONG
  // stretches (seconds), not milliseconds. So aliasing turned out NOT to be the
  // binding constraint — a poll landing inside a recoverable ≤220ms blip is ~0.015%
  // at baseline, ~1% mid-burst, so the stays-quiet arm is near-guaranteed by physics
  // at any 1–60s cadence. The inequality below is kept as a cheap invariant guard.
  const MEASURED_SHORTEST_CONFIGURED_WINDOW_MS = 21_000; // ~21.6s burst inter-arrival − ≤220ms down

  it('DEFAULT escalatedIntervalMs ≤ the shortest measured `configured` window', () => {
    expect(DEFAULT_MONITOR_CONFIG.escalatedIntervalMs).toBeLessThanOrEqual(
      MEASURED_SHORTEST_CONFIGURED_WINDOW_MS,
    );
  });

  it('mechanistic: sampling ≤ the configured window stays quiet on a recoverable storm; a coarser strobe aliases', () => {
    // A pure property of the state machine + sampler, independent of the deployed
    // default: a synthetic WORST-CASE tight cycle (short `configured` window W in the
    // middle, ~3.15s period). Demonstrates WHY the interval≤window invariant matters
    // even though the real box is nowhere near this tight.
    const C = 3_150;
    const W = 1_500; // synthetic short configured window (not the measured one)
    const downHalf = (C - W) / 2;
    const segments: Array<[number, UdcState]> = [];
    for (let cycle = 0; cycle < 45; cycle++) {
      segments.push([downHalf, DOWN], [W, 'configured'], [downHalf, DOWN]);
    }
    // Max consecutive down = 2·downHalf = C − W = 1650ms ≪ 90s → genuinely RECOVERABLE.

    // COARSE strobe locked to the cycle length: every sample lands at a cycle
    // boundary (the leading down-half), NEVER in the `configured` window → false latch.
    const coarse = new HidLatchMonitor();
    expect(run(coarse, sampleTimeline(segments, C)).length).toBeGreaterThan(0);

    // FINE sampler at period = W: a window of length W always contains a multiple of
    // a period ≤ W → lands in every `configured` window → timer resets → QUIET.
    const fine = new HidLatchMonitor();
    expect(run(fine, sampleTimeline(segments, W))).toHaveLength(0);
  });
});
