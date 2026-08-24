/**
 * HID-LATCH MONITOR — the pure, sample-driven detection core (report-only v1).
 *
 * WHY: pikvm01's HID was latched dead for 6.61 days and nothing noticed —
 * kvmd/kvmd-otg both showed NRestarts=0 and "active" throughout; systemd was
 * green for the entire outage. The alarm we were missing is a LATCH, not a blip.
 *
 * THE KEY CONSTRAINT — alert on the LATCH, not the re-enumeration. Re-enumerations
 * are NORMAL (each self-healing in 1-3s); a naive `unhealthy → alert` fires
 * constantly, gets muted, and manufactures the exact silence we're removing. So
 * detection is PERSISTENCE-based: the timer resets on ANY healthy sample, and we
 * alert only when non-healthy persists past a threshold (default 90s).
 *
 * SIGNAL-AGNOSTIC: this core consumes an ordered stream of {@link HealthSample}
 * readings whose `healthy` boolean is computed BY THE SOURCE. It knows nothing
 * about UDC state strings, gadget bound-ness, SSH, or the transport — the source
 * owns the health predicate (e.g. the pikvm01 ssh-source: `state === 'configured'`;
 * the appliance local source: `gadget-bound AND state-acceptable`). That keeps the
 * detection logic deterministic + unit-testable against traces, and lets the same
 * classifier serve a remote SSH sampler or a local sysfs read unchanged.
 *
 * v1 is REPORT-ONLY — the alert only RECOMMENDS a rung.
 */

/** Raw value of `/sys/class/udc/<udc>/state`, when a source deals in UDC states.
 *  Phase 2 (architecture review): renamed from `UdcState` to disambiguate from
 *  hid-recovery.ts's richer `interface UdcState {udc, state, online}` — same
 *  name, unrelated shape (bare string vs. a structured reading), previously
 *  distinguishable only by which module you imported from. That one keeps the
 *  `UdcState` name; it's the more-consumed of the two. */
export type UdcKernelState = string;

/** The UDC state in which the emulated HID drives the target — a convenience for sources. */
export const UDC_UP: UdcKernelState = 'configured';

/** Convenience predicate for state-based sources (e.g. the pikvm01 ssh-source). */
export function isUdcUp(state: UdcKernelState): boolean {
  return state === UDC_UP;
}

/**
 * One reading from a sampler. The health decision is a pre-computed BOOLEAN so the
 * classifier is signal-agnostic; the source owns whatever composite produced it.
 * - `t`: epoch ms of the read (the RUNNER's clock — never a journal timestamp,
 *   which can be pre-NTP stale on an RTC-less appliance).
 * - `healthy`: the source's health verdict. `false` ⇒ counts toward a latch.
 * - `reenumCount`: monotonic, NON-DECREASING, NORMALISED by the runner + baselined at
 *   first read (a RELATIVE counter near 0, not the raw since-boot value). Only the
 *   in-window DELTA is used, so the origin is irrelevant. Carried on the sample, not
 *   derived from transitions, because within a latch there are BY DEFINITION zero
 *   healthy samples — the count must come from an independent kernel counter.
 * - `bootId`: `/proc/sys/kernel/random/boot_id`, when supplied. A change WITHIN a
 *   down-window means a reboot reset the reenum-count journal while `downSince`
 *   survived — so the latched/thrashing split across that window can't be trusted.
 * - `detail` / `bound` / `state`: SOURCE diagnostics passed through UNTOUCHED into the
 *   tick/alert/status records (`detail` a human string, `bound`/`state` structured).
 *   The classifier ignores them; they exist purely for the operator-facing surface.
 */
export interface HealthSample {
  t: number;
  healthy: boolean;
  reenumCount: number;
  bootId?: string;
  detail?: string;
  bound?: boolean;
  state?: string;
}

/** `latched` = flatlined/dead (rebind-able); `thrashing` = re-enumerating but never settling (power/cable). */
export type LatchClassification = 'latched' | 'thrashing';

/**
 * Recommended remediation rung. `soft_connect`/`udc-rebind` mirror the HID-recovery
 * ladder (R2/R3a). `power_cable` is NOT a ladder action — a thrashing storm is an
 * electrical fault (under-volt) a UDC rebind will not fix.
 */
export type RecommendedRung = 'soft_connect' | 'udc-rebind' | 'power_cable';

/** Emitted exactly once when a down-window first crosses the persistence threshold. */
export interface LatchAlert {
  kind: 'alert';
  /** `t` of the sample that crossed the threshold. */
  firedAt: number;
  /** `t` of the first non-healthy sample after the last healthy one (the persistence anchor). */
  downSince: number;
  /** firedAt − downSince. */
  latchDurationMs: number;
  /** The source's diagnostic detail at the moment of firing (e.g. `"unbound (#48: no gadget dir)"`). */
  detail?: string;
  /** reenumCount delta across the persistence window (fire − anchor). */
  reenumCountInWindow: number;
  classification: LatchClassification;
  recommendedRung: RecommendedRung;
  /** Human-readable rationale for the rung, incl. the pikvm01 escalation caveat. */
  note: string;
  /** True if the target rebooted during the window (boot_id changed) — the reenum
   *  baseline reset, so a small count may be an artifact, not a real flatline. */
  rebootedDuringWindow: boolean;
  /**
   * `unreliable` when a reboot reset the reenum counter mid-window: the split (and
   * thus `recommendedRung`) is a best-effort guess and MUST NOT be auto-acted on. The
   * latch itself is still real, which is why the window is kept, not discarded.
   */
  classificationConfidence: 'reliable' | 'unreliable';
}

export interface MonitorConfig {
  /** Coarse baseline sampling cadence (ms) while healthy. Runner concern; via desiredIntervalMs(). */
  baselineIntervalMs: number;
  /** ESCALATED sampling cadence (ms) once a non-healthy sample is seen. */
  escalatedIntervalMs: number;
  /** Fire when non-healthy persists this long (ms) with no intervening healthy sample. */
  persistenceThresholdMs: number;
  /** reenumCountInWindow ≤ this ⇒ `latched` (flatline); above ⇒ `thrashing`. */
  latchReenumMax: number;
}

/**
 * Defaults from measured behaviour. `escalatedIntervalMs` (5s) is safe by a wide
 * margin from the measured ≤220ms down-window bound — a poll landing inside a
 * recoverable blip is ~0.015%/~1%, and firing needs 90s CONTINUOUS non-healthy, so
 * the stays-quiet arm is near-guaranteed by physics, not by tuning.
 */
export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  baselineIntervalMs: 60_000,
  escalatedIntervalMs: 5_000,
  persistenceThresholdMs: 90_000,
  latchReenumMax: 2,
};

/** What {@link HidLatchMonitor.status} exposes so the runner can assemble the status file. */
export interface MonitorStatus {
  down: boolean;
  downSince: number | null;
  alerted: boolean;
  /** The alert fired for the CURRENT down-window (null while healthy or before threshold). */
  activeAlert: LatchAlert | null;
}

/**
 * The pure persistence state machine. Feed samples in time order via {@link observe};
 * it returns a {@link LatchAlert} exactly once per latch (re-arming only after a
 * healthy sample), else null. Holds no timers and does no I/O.
 */
export class HidLatchMonitor {
  private readonly cfg: MonitorConfig;
  /** `t` of the first non-healthy since the last healthy sample; null while up. */
  private downSince: number | null = null;
  /** reenumCount snapshot at downSince, to compute the in-window delta. */
  private reenumAtDown = 0;
  /** boot_id observed when the window was anchored; null if the source omits it. */
  private bootIdAtDown: string | null = null;
  /** Whether a reboot (boot_id change) has been seen within the current down-window. */
  private rebootedInWindow = false;
  /** Whether we've already fired for the current down-window (fire-once-per-latch). */
  private alerted = false;
  /** The alert fired for the current down-window (for the status surface); cleared on healthy. */
  private activeAlert: LatchAlert | null = null;

  constructor(cfg?: Partial<MonitorConfig>) {
    this.cfg = { ...DEFAULT_MONITOR_CONFIG, ...cfg };
  }

  observe(sample: HealthSample): LatchAlert | null {
    if (sample.healthy) {
      // Any healthy sample resets the persistence window and re-arms the alert.
      this.downSince = null;
      this.bootIdAtDown = null;
      this.rebootedInWindow = false;
      this.alerted = false;
      this.activeAlert = null;
      return null;
    }

    // non-healthy
    if (this.downSince === null) {
      this.downSince = sample.t;
      this.reenumAtDown = sample.reenumCount;
      this.bootIdAtDown = sample.bootId ?? null;
      this.rebootedInWindow = false;
      this.alerted = false;
      this.activeAlert = null;
    } else if (
      sample.bootId !== undefined &&
      this.bootIdAtDown !== null &&
      sample.bootId !== this.bootIdAtDown
    ) {
      // Target rebooted mid-window: the reenum baseline reset while the window lives.
      this.rebootedInWindow = true;
    }

    const latchDurationMs = sample.t - this.downSince;
    if (!this.alerted && latchDurationMs >= this.cfg.persistenceThresholdMs) {
      this.alerted = true;
      const reenumCountInWindow = sample.reenumCount - this.reenumAtDown;
      const classification: LatchClassification =
        reenumCountInWindow <= this.cfg.latchReenumMax ? 'latched' : 'thrashing';
      // A flatline latch is Mode B in the HID-recovery ladder: R2 soft_connect has
      // been INSUFFICIENT for this signature on pikvm01 (2026-07-26 + 2026-08-08 — it
      // left UDC `not attached`; only R3a udc-rebind revived it), so we recommend
      // udc-rebind directly. A thrashing storm is electrical (power/cable).
      const recommendedRung: RecommendedRung = classification === 'latched' ? 'udc-rebind' : 'power_cable';
      let note =
        classification === 'latched'
          ? 'flatline latch: the M0 ladder starts at soft_connect, but this signature on pikvm01 has needed udc-rebind (soft_connect insufficient 2026-07-26 + 2026-08-08) — expect to escalate.'
          : 'never-settling storm: an under-volt/electrical fault — a UDC rebind will not fix it; check power/cable.';
      if (this.rebootedInWindow) {
        note = `classification UNRELIABLE — the target rebooted mid-window (reenum baseline reset), so latched/thrashing cannot be trusted. ${note}`;
      }
      const alert: LatchAlert = {
        kind: 'alert',
        firedAt: sample.t,
        downSince: this.downSince,
        latchDurationMs,
        detail: sample.detail,
        reenumCountInWindow,
        classification,
        recommendedRung,
        note,
        rebootedDuringWindow: this.rebootedInWindow,
        classificationConfidence: this.rebootedInWindow ? 'unreliable' : 'reliable',
      };
      this.activeAlert = alert;
      return alert;
    }
    return null;
  }

  /**
   * The cadence the runner should poll at RIGHT NOW: escalated once a down-window is
   * open, baseline while healthy. Lets the loop stay cheap at rest and fine under suspicion.
   */
  desiredIntervalMs(): number {
    return this.downSince === null ? this.cfg.baselineIntervalMs : this.cfg.escalatedIntervalMs;
  }

  /** Snapshot for the runner's per-tick JSONL + the status file. */
  status(): MonitorStatus {
    return {
      down: this.downSince !== null,
      downSince: this.downSince,
      alerted: this.alerted,
      activeAlert: this.activeAlert,
    };
  }
}
