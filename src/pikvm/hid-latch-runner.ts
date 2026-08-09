/**
 * HID-latch monitor RUNNER — the headless poll loop around the pure
 * {@link HidLatchMonitor} core.
 *
 * PLACEMENT (settled with the wrapper owner, verified against macos-nixos-setup
 * @ c334cfc): the WB-kiosk MCP server is a PER-SESSION stdio spawn — Claude Code
 * launches it when the iOS project is open and SIGKILLs it on disconnect, and no
 * launchd agent keeps it alive. So an in-process `setInterval` inside the MCP
 * server would be inert between sessions and dead through exactly the multi-day
 * outage we're detecting. This runner is therefore a SEPARATE headless entrypoint
 * (`pikvm-hid-latch-monitor`) that pikvm-nixos owns placing under
 * `launchd.user.agents` with RunAtLoad+KeepAlive. It emits JSONL to stdout; the
 * launchd agent routes StandardOutPath → the durable log.
 *
 * TRANSPORT: SSH, reusing `PIKVM_HID_RECOVERY_SSH` (root@pikvm01…). The macOS
 * Local-Network privacy grant that the MCP's HTTPS path depends on (loopback
 * tinyproxy in a granted Terminal.app) is NOT available to a headless launchd
 * agent, so the HTTPS API path can't be assumed. Reading the sysfs file over SSH
 * sidesteps it. (Whether SSH from a launchd-spawned nix-store binary itself trips
 * Local-Network privacy is the first on-box check — the SSH adapter lives in
 * {@link ./hid-latch-ssh-source}, kept thin for that reason.)
 *
 * This module holds the loop LOGIC only; the transport and the wall clock are
 * injected, so the loop is unit-tested deterministically with a scripted source.
 */
import {
  HidLatchMonitor,
  type LatchAlert,
  type UdcSample,
  type UdcState,
} from './hid-latch-monitor.js';

/**
 * One raw reading from the transport: the UDC state plus a RAW re-enumeration
 * count (e.g. a dmesg-ring grep — NOT guaranteed monotonic across a ring wrap),
 * or an error when the box was unreachable. `ok:false` is a TRANSPORT fault
 * (SSH/network/Mac), categorically distinct from a UDC-down reading.
 */
export type SourceReading =
  | { ok: true; state: UdcState; rawReenum: number }
  | { ok: false; error: string };

/** Pulls one reading. The SSH adapter implements this; tests inject a fake. */
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
  state: UdcState;
  up: boolean;
  reenumCount: number;
  down: boolean;
  downSince: number | null;
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

export interface RunnerConfig {
  /** Emit a heartbeat `tick` after this many polls with no transition, so a long
   *  healthy (or long latched) stretch still proves the monitor is alive. */
  heartbeatEveryTicks: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  heartbeatEveryTicks: 60,
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
  /** Loop while this returns false. Omit for a never-ending daemon; tests pass a bounded one. */
  shouldStop?: () => boolean;
  config?: Partial<RunnerConfig>;
}

const stdoutEmit = (rec: MonitorRecord): void => {
  // one JSON object per line — the launchd StandardOutPath log is the source of truth.
  process.stdout.write(JSON.stringify(rec) + '\n');
};

/**
 * The poll loop. Each iteration: read the transport, normalise the re-enum counter
 * to a monotonic value, feed the pure monitor, and emit JSONL for transitions,
 * alerts, source errors, and periodic heartbeats. The cadence is the monitor's
 * `desiredIntervalMs()` (baseline while healthy, escalated once a down-window opens).
 *
 * INVARIANT: a transport failure (`ok:false`) does NOT advance the latch timer —
 * the monitor is only fed real UDC readings. An SSH/network outage can therefore
 * never masquerade as a HID latch (nor can a real latch be hidden by pretending the
 * box is merely unreachable); the two faults are reported as different records.
 */
export async function runMonitorLoop(deps: RunnerDeps): Promise<void> {
  const cfg = { ...DEFAULT_RUNNER_CONFIG, ...deps.config };
  const emit = deps.emit ?? stdoutEmit;
  const { source, monitor } = deps;

  let monotonicReenum = 0;
  let lastRaw: number | null = null;
  let consecutiveErrors = 0;
  let lastEmittedUp: boolean | null = null;
  let ticksSinceEmit = 0;

  while (!(deps.shouldStop?.() ?? false)) {
    const t = deps.now();
    const reading = await source.read();

    if (!reading.ok) {
      consecutiveErrors += 1;
      emit({ kind: 'source_error', t, error: reading.error, consecutive: consecutiveErrors });
      // Do NOT feed the monitor: unreachable ≠ UDC-down. Poll at the current cadence.
      await deps.sleep(monitor.desiredIntervalMs());
      continue;
    }
    consecutiveErrors = 0;

    // Normalise the raw (dmesg-ring) reading to a monotonic counter: a DECREASE
    // means the ring wrapped/was cleared — never count a negative increment.
    if (lastRaw !== null && reading.rawReenum >= lastRaw) {
      monotonicReenum += reading.rawReenum - lastRaw;
    }
    lastRaw = reading.rawReenum;

    const up = monitor.isHealthy(reading.state);
    const sample: UdcSample = { t, state: reading.state, reenumCount: monotonicReenum };
    const alert = monitor.observe(sample);
    const st = monitor.status();

    ticksSinceEmit += 1;
    const isTransition = lastEmittedUp === null || up !== lastEmittedUp;
    if (isTransition || ticksSinceEmit >= cfg.heartbeatEveryTicks) {
      emit({
        kind: 'tick',
        reason: isTransition ? 'transition' : 'heartbeat',
        t,
        state: reading.state,
        up,
        reenumCount: monotonicReenum,
        down: st.down,
        downSince: st.downSince,
      });
      lastEmittedUp = up;
      ticksSinceEmit = 0;
    }

    if (alert) emit(alert);

    await deps.sleep(monitor.desiredIntervalMs());
  }
}
