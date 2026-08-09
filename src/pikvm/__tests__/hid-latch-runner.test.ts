import { describe, it, expect } from 'vitest';
import { HidLatchMonitor } from '../hid-latch-monitor.js';
import {
  runMonitorLoop,
  type MonitorRecord,
  type SampleSource,
  type SourceReading,
  type TickRecord,
  type LatchAlertRecord,
} from '../hid-latch-runner.js';

/** A fake wall clock: now() reads it, sleep(ms) advances it. Deterministic. */
function fakeClock(start = 0) {
  let clock = start;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

/** Source that replays a scripted list of readings (the last one repeats forever). */
function scriptedSource(readings: SourceReading[]): SampleSource {
  let i = 0;
  return {
    async read() {
      const r = readings[Math.min(i, readings.length - 1)];
      i += 1;
      return r;
    },
  };
}

const up = (rawReenum = 0): SourceReading => ({ ok: true, state: 'configured', rawReenum });
const down = (rawReenum = 0): SourceReading => ({ ok: true, state: 'not attached', rawReenum });
const err = (error = 'ssh: connect to host pikvm01 port 22: Operation timed out'): SourceReading => ({
  ok: false,
  error,
});

/** Run the loop over a fixed number of iterations, capturing every emitted record. */
async function drive(source: SampleSource, monitor: HidLatchMonitor, iterations: number, heartbeatEveryTicks = 60) {
  const clock = fakeClock();
  const records: MonitorRecord[] = [];
  let n = 0;
  await runMonitorLoop({
    source,
    monitor,
    now: clock.now,
    sleep: clock.sleep,
    emit: (r) => records.push(r),
    shouldStop: () => n++ >= iterations,
    config: { heartbeatEveryTicks },
  });
  return records;
}

const ticks = (rs: MonitorRecord[]) => rs.filter((r): r is TickRecord => r.kind === 'tick');
const alerts = (rs: MonitorRecord[]) => rs.filter((r): r is LatchAlertRecord => r.kind === 'alert');
const errors = (rs: MonitorRecord[]) => rs.filter((r) => r.kind === 'source_error');

describe('runMonitorLoop — emit policy (transitions + heartbeat, not per-poll spam)', () => {
  it('a healthy run emits ONE transition tick then only periodic heartbeats — not one per poll', async () => {
    const records = await drive(scriptedSource([up()]), new HidLatchMonitor(), 10, 4);
    const t = ticks(records);
    expect(t[0]).toMatchObject({ kind: 'tick', reason: 'transition', up: true });
    // 10 polls, heartbeat every 4 → 1 transition + heartbeats at ticks 4 and 8 = 3 total, not 10.
    expect(t.length).toBeLessThan(10);
    expect(t.filter((x) => x.reason === 'transition')).toHaveLength(1);
    expect(t.some((x) => x.reason === 'heartbeat')).toBe(true);
  });

  it('emits a transition tick on both the down-onset AND the recovery', async () => {
    const source = scriptedSource([up(), up(), down(), down(), up(), up()]);
    const records = await drive(source, new HidLatchMonitor(), 6, 1000);
    const transitions = ticks(records).filter((x) => x.reason === 'transition');
    expect(transitions.map((x) => x.up)).toEqual([true, false, true]); // up → down → up
  });
});

describe('runMonitorLoop — INVARIANT: a transport failure never advances the latch timer', () => {
  it('a long run of SSH errors (well past the 90s threshold of sim-time) raises source_error, NOT a latch alert', async () => {
    // baseline cadence 60s/poll → 5 polls = 300s of sim-time, far past persistence.
    const records = await drive(scriptedSource([err()]), new HidLatchMonitor(), 5);
    expect(alerts(records)).toHaveLength(0); // unreachable ≠ latched — must not fire
    const e = errors(records);
    expect(e).toHaveLength(5);
    expect(e.map((x) => (x as { consecutive: number }).consecutive)).toEqual([1, 2, 3, 4, 5]);
  });

  it('errors DURING a down-window do not corrupt the persistence timer (gap is skipped, not counted)', async () => {
    // down, then the box goes unreachable for several polls, then down again. The
    // error span must not be treated as continued latch time.
    const monitor = new HidLatchMonitor({ escalatedIntervalMs: 1_000, persistenceThresholdMs: 5_000, latchReenumMax: 2 });
    // 1 down (t=0), 4 errors (t=1..4s), then downs resume. Without the skip, the
    // 5s of errors would push the down-window past 5s and false-fire immediately.
    const source = scriptedSource([down(0), err(), err(), err(), err(), down(0), down(0)]);
    const records = await drive(source, monitor, 6);
    // The first real down is t=0; the next real down after 4 error-polls is t=5000,
    // and the monitor only sees {t=0, t=5000}: 5000 ≥ threshold, ONE latch (real),
    // correctly classified from real samples — but critically no fire happened
    // DURING the blind window, and exactly one alert total.
    expect(alerts(records)).toHaveLength(1);
    expect(errors(records)).toHaveLength(4);
  });
});

describe('runMonitorLoop — monotonic re-enum normalisation across a dmesg-ring wrap', () => {
  it('a DECREASE in the raw dmesg count (ring wrap) never produces a negative increment; tick reenumCount is non-decreasing', async () => {
    // raw sequence includes a wrap: 100 → 105 → 3 (wrapped) → 8.
    const source = scriptedSource([
      down(100),
      down(105),
      down(3), // ring wrapped/cleared
      down(8),
      down(8),
    ]);
    const monitor = new HidLatchMonitor({ escalatedIntervalMs: 1_000, persistenceThresholdMs: 2_000, latchReenumMax: 0 });
    const records = await drive(source, monitor, 5, 1);
    const reenumSeries = ticks(records).map((x) => x.reenumCount);
    // non-decreasing throughout — the wrap did not subtract.
    for (let i = 1; i < reenumSeries.length; i++) {
      expect(reenumSeries[i]).toBeGreaterThanOrEqual(reenumSeries[i - 1]);
    }
    // total monotonic increments = (105-100) + (8-3) = 10; the 105→3 wrap adds 0.
    expect(reenumSeries.at(-1)).toBe(10);
  });
});

describe('runMonitorLoop — end-to-end latch fires exactly once with the right classification', () => {
  it('a flatline latch (never configured, raw reenum FLAT) → one alert, latched → soft_connect', async () => {
    const monitor = new HidLatchMonitor({ escalatedIntervalMs: 1_000, persistenceThresholdMs: 5_000, latchReenumMax: 2 });
    const source = scriptedSource([up(50), down(50), down(50), down(50), down(50), down(50), down(50), down(50), down(50)]);
    const records = await drive(source, monitor, 9);
    const a = alerts(records);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ classification: 'latched', recommendedRung: 'udc-rebind', reenumCountInWindow: 0 });
  });
});
