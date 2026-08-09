/**
 * HID-latch monitor RUNNER — the headless poll loop around the pure
 * {@link HidLatchMonitor} core.
 *
 * The source is INJECTED (SSH for pikvm01, local sysfs on the pikvm-nixos
 * appliance), and so is the wall clock, so the loop is unit-tested deterministically
 * with a scripted source. The source computes the `healthy` verdict; the runner
 * normalises the raw re-enum count to monotonic, feeds the signal-agnostic
 * classifier, emits JSONL (tick/alert/source_error), and — for the appliance
 * systemd deployment — builds a {@link LatchStatus} snapshot each iteration that the
 * caller persists (atomically to /run/pikvm-hid-latch/status.json) for the appliance
 * endpoint + MCP health_check. `lastSampleAt` advances EVERY iteration, so a hung
 * loop shows as a stale timestamp (systemd Restart covers a crash; this covers a hang).
 */
import {
  HidLatchMonitor,
  type HealthSample,
  type LatchAlert,
  type LatchClassification,
  type RecommendedRung,
} from './hid-latch-monitor.js';

/**
 * One raw reading from the transport. The source computes `healthy` (the composite
 * health verdict) + a RAW re-enum count (NOT guaranteed monotonic across a journal
 * reset); `detail`/`bound`/`state` are diagnostics passed through to the records.
 * `ok:false` is a genuine TRANSPORT/read fault (e.g. `/sys` unreadable), categorically
 * distinct from a healthy:false reading — a `#48` unbound gadget is `healthy:false`,
 * NOT a source error.
 */
export type SourceReading =
  | { ok: true; healthy: boolean; rawReenum: number; bootId?: string; detail?: string; bound?: boolean; state?: string }
  | { ok: false; error: string };

/** Pulls one reading. The SSH + local adapters implement this; tests inject a fake. */
export interface SampleSource {
  read(): Promise<SourceReading>;
}

/** Why a tick record was emitted (steady state is not logged every poll). */
export type TickReason = 'transition' | 'heartbeat';

/** JSONL records emitted to stdout — the durable report. Discriminated by `kind`. */
export type TickRecord = {
  kind: 'tick';
  reason: TickReason;
  t: number;
  healthy: boolean;
  reenumCount: number;
  down: boolean;
  downSince: number | null;
  detail?: string;
  bound?: boolean;
  state?: string;
};
export type SourceErrorRecord = {
  kind: 'source_error';
  t: number;
  error: string;
  /** How many consecutive reads have failed — a blind monitor is itself a fault to surface. */
  consecutive: number;
};
/** The alert record is the {@link LatchAlert} itself (it already carries `kind:'alert'`). */
export type LatchAlertRecord = LatchAlert;
export type MonitorRecord = TickRecord | LatchAlertRecord | SourceErrorRecord;

/**
 * The status snapshot the appliance surface reads (→ /run/pikvm-hid-latch/status.json
 * → GET /hid-recovery/latch-status → MCP health_check). `lastSampleAt` is the
 * self-liveness read (advances every loop iteration; stale ⇒ the monitor hung).
 */
export interface LatchStatus {
  ok: boolean;
  healthy: boolean | null;
  bound: boolean | null;
  state: string | null;
  detail: string | null;
  alert: boolean;
  classification: LatchClassification | null;
  classificationConfidence: 'ok' | 'unreliable' | null;
  recommendedRung: RecommendedRung | null;
  downSince: number | null;
  sustainedForSec: number;
  reenumCount: number;
  bootId: string | null;
  lastSampleAt: number;
  /** Last source_error message, when `ok:false`; null otherwise. */
  lastError: string | null;
}

export interface RunnerConfig {
  /** Emit a heartbeat `tick` after this many polls with no transition (proof-of-life in the log). */
  heartbeatEveryTicks: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  // ~10 min between heartbeats at the 60s baseline — proof-of-life at low log cost.
  heartbeatEveryTicks: 10,
};

export interface RunnerDeps {
  source: SampleSource;
  monitor: HidLatchMonitor;
  /** Wall clock (ms). Injected for deterministic tests. */
  now: () => number;
  /** Sleep for the poll interval. Injected (a fake advances the test clock). */
  sleep: (ms: number) => Promise<void>;
  /** Sink for JSONL records. Default: one JSON object per line to stdout. */
  emit?: (rec: MonitorRecord) => void;
  /** Called each iteration with the current status snapshot (main persists it atomically). */
  onStatus?: (status: LatchStatus) => void;
  /** Loop while this returns false. Omit for a never-ending daemon; tests pass a bounded one. */
  shouldStop?: () => boolean;
  config?: Partial<RunnerConfig>;
}

const stdoutEmit = (rec: MonitorRecord): void => {
  process.stdout.write(JSON.stringify(rec) + '\n');
};

/**
 * The poll loop. Each iteration: read the source, normalise the re-enum counter to a
 * monotonic value, feed the pure monitor, emit JSONL (transitions/alerts/errors/
 * heartbeats), and build the status snapshot.
 *
 * INVARIANT: a read failure (`ok:false`) does NOT advance the latch timer — the
 * monitor is only fed real readings, so a transport/read outage can never masquerade
 * as a latch nor hide one; the two faults are reported as different records.
 */
export async function runMonitorLoop(deps: RunnerDeps): Promise<void> {
  const cfg = { ...DEFAULT_RUNNER_CONFIG, ...deps.config };
  const emit = deps.emit ?? stdoutEmit;
  const { source, monitor } = deps;

  let monotonicReenum = 0;
  let lastRaw: number | null = null;
  let consecutiveErrors = 0;
  let lastEmittedHealthy: boolean | null = null;
  let ticksSinceEmit = 0;
  // Last successful sample diagnostics, retained for the status snapshot across errors.
  let lastHealthy: boolean | null = null;
  let lastBound: boolean | null = null;
  let lastState: string | null = null;
  let lastDetail: string | null = null;
  let lastBootId: string | null = null;

  const buildStatus = (t: number, ok: boolean, lastError: string | null): LatchStatus => {
    const st = monitor.status();
    const a = st.activeAlert;
    return {
      ok,
      healthy: lastHealthy,
      bound: lastBound,
      state: lastState,
      detail: lastDetail,
      alert: st.alerted,
      classification: a?.classification ?? null,
      classificationConfidence: a ? (a.classificationConfidence === 'reliable' ? 'ok' : 'unreliable') : null,
      recommendedRung: a?.recommendedRung ?? null,
      downSince: st.downSince,
      sustainedForSec: st.downSince !== null ? Math.max(0, (t - st.downSince) / 1000) : 0,
      reenumCount: monotonicReenum,
      bootId: lastBootId,
      lastSampleAt: t, // advances every iteration → a stale value means the loop hung
      lastError,
    };
  };

  while (!(deps.shouldStop?.() ?? false)) {
    const t = deps.now();
    const reading = await source.read();

    if (!reading.ok) {
      consecutiveErrors += 1;
      emit({ kind: 'source_error', t, error: reading.error, consecutive: consecutiveErrors });
      // Do NOT feed the monitor: a read fault ≠ unhealthy. Still refresh liveness/status.
      deps.onStatus?.(buildStatus(t, false, reading.error));
      await deps.sleep(monitor.desiredIntervalMs());
      continue;
    }
    consecutiveErrors = 0;

    // Normalise the raw reading to a monotonic counter: a DECREASE means the journal
    // reset/ring-wrapped — never count a negative increment (boot_id guards the reboot).
    if (lastRaw !== null && reading.rawReenum >= lastRaw) {
      monotonicReenum += reading.rawReenum - lastRaw;
    }
    lastRaw = reading.rawReenum;

    lastHealthy = reading.healthy;
    lastBound = reading.bound ?? null;
    lastState = reading.state ?? null;
    lastDetail = reading.detail ?? null;
    lastBootId = reading.bootId ?? null;

    const sample: HealthSample = {
      t,
      healthy: reading.healthy,
      reenumCount: monotonicReenum,
      bootId: reading.bootId,
      detail: reading.detail,
      bound: reading.bound,
      state: reading.state,
    };
    const alert = monitor.observe(sample);
    const st = monitor.status();

    ticksSinceEmit += 1;
    const isTransition = lastEmittedHealthy === null || reading.healthy !== lastEmittedHealthy;
    if (isTransition || ticksSinceEmit >= cfg.heartbeatEveryTicks) {
      emit({
        kind: 'tick',
        reason: isTransition ? 'transition' : 'heartbeat',
        t,
        healthy: reading.healthy,
        reenumCount: monotonicReenum,
        down: st.down,
        downSince: st.downSince,
        detail: reading.detail,
        bound: reading.bound,
        state: reading.state,
      });
      lastEmittedHealthy = reading.healthy;
      ticksSinceEmit = 0;
    }

    if (alert) emit(alert);
    deps.onStatus?.(buildStatus(t, true, null));

    await deps.sleep(monitor.desiredIntervalMs());
  }
}
