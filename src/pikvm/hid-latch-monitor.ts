/**
 * pikvm01 HID-LATCH MONITOR — the pure, sample-driven detection core (report-only v1).
 *
 * WHY: pikvm01's HID was latched dead for 6.61 days and nothing noticed —
 * kvmd/kvmd-otg both showed NRestarts=0 and "active" throughout; systemd was
 * green for the entire outage. Root cause (probable): chronic USB-PHY instability
 * from under-volt (vcgencmd get_throttled=0x50005) → 513 re-enumerations since
 * boot. The alarm we were missing is a LATCH, not a blip.
 *
 * THE KEY CONSTRAINT — alert on the LATCH, not the re-enumeration. Re-enumerations
 * are NORMAL here (~2.4/h baseline, storms to ~32/h), each self-healing in 1-3s. A
 * naive `UDC != configured → alert` fires hourly, gets muted, and manufactures the
 * exact silence we're removing. So detection is PERSISTENCE-based: the timer resets
 * on ANY observed `configured`, and we alert only when non-`configured` persists
 * past a threshold (default 90s ≈ 30× the 1-3s transient).
 *
 * This module is the placement- and transport-INDEPENDENT core: it consumes an
 * ordered stream of {@link UdcSample} readings and emits a {@link LatchAlert} the
 * one time a down-window first crosses the threshold. Where the samples come from
 * (SSH `cat /sys/class/udc/<udc>/state` + a re-enum counter) and what keeps the loop
 * alive (a headless launchd agent — the WB-kiosk MCP is a per-session stdio spawn,
 * so an in-process timer would be inert) live in the runner, not here — which is
 * what makes this core deterministic and unit-testable against real traces.
 *
 * GROUND TRUTH IS THE UDC STATE, never kvmd's online flags (they lie in BOTH
 * directions — they read offline for seconds after HID is genuinely back).
 *
 * v1 is REPORT-ONLY. Auto-recovery (driving the {@link HostRecoveryAction} ladder)
 * is an explicit separate later ruling — the alert only RECOMMENDS a rung.
 */

/** Raw value of `/sys/class/udc/<udc>/state`. `configured` = HID usable; anything else = down. */
export type UdcState = string;

/** The one state in which the emulated HID actually drives the target. */
export const UDC_UP: UdcState = 'configured';

/** UDC ground-truth predicate. Only `configured` is up; `not attached`/`addressed`/… are down. */
export function isUdcUp(state: UdcState): boolean {
  return state === UDC_UP;
}

/**
 * One reading from the sampler.
 * - `t`: epoch ms of the read.
 * - `state`: the raw `/sys/class/udc/<udc>/state` value.
 * - `reenumCount`: a CUMULATIVE, monotonic-since-boot count of kernel re-enumeration
 *   events (e.g. from a dmesg/journal grep). It is carried on the sample rather than
 *   derived from `state` transitions, because within a latch window there are BY
 *   DEFINITION zero `configured` samples — so the count can't come from up→down
 *   transitions; it must come from an independent kernel counter.
 */
export interface UdcSample {
  t: number;
  state: UdcState;
  reenumCount: number;
}

/** `latched` = flatlined/dead (rebind-able); `thrashing` = re-enumerating but never settling (power/cable). */
export type LatchClassification = 'latched' | 'thrashing';

/**
 * Recommended remediation rung. `soft_connect`/`udc-rebind` mirror the HID-recovery
 * ladder (R2/R3a). `power_cable` is NOT a ladder action — a thrashing storm is an
 * electrical fault (under-volt) that a UDC rebind will not fix.
 */
export type RecommendedRung = 'soft_connect' | 'udc-rebind' | 'power_cable';

/** Emitted exactly once when a down-window first crosses the persistence threshold. */
export interface LatchAlert {
  kind: 'alert';
  /** `t` of the sample that crossed the threshold. */
  firedAt: number;
  /** `t` of the first non-`configured` sample after the last `configured` (the persistence anchor). */
  downSince: number;
  /** firedAt − downSince. */
  latchDurationMs: number;
  /** The (still non-`configured`) UDC state at the moment of firing. */
  state: UdcState;
  /** reenumCount delta across the persistence window (fire − anchor). */
  reenumCountInWindow: number;
  classification: LatchClassification;
  recommendedRung: RecommendedRung;
}

export interface MonitorConfig {
  /** Coarse baseline sampling cadence (ms) while healthy. Runner concern; surfaced via desiredIntervalMs(). */
  baselineIntervalMs: number;
  /**
   * ESCALATED sampling cadence (ms) once a non-`configured` sample is seen. This is a
   * PARAMETER, not a constant, on purpose: it must be finer than the shortest `configured`
   * window so a coarse grid can't ALIAS a recoverable storm into a false latch (all samples
   * landing in down-windows, the timer never resetting). The safe value is derived from the
   * on-box down-duration measurement; the default is provisional and deliberately conservative.
   */
  escalatedIntervalMs: number;
  /** Fire when non-healthy persists this long (ms) with no intervening healthy sample. */
  persistenceThresholdMs: number;
  /** reenumCountInWindow ≤ this ⇒ `latched` (flatline); above ⇒ `thrashing`. */
  latchReenumMax: number;
  /**
   * The UDC `state` string that means HEALTHY for THIS target — PER-TARGET, not a
   * global truth. On pikvm01 (a live HID target) `configured` is healthy and
   * `not attached` is the fault. But an UNCABLED box (e.g. it-03400's appliance)
   * reads `not attached` on every boot as its correct baseline — hardcoding
   * `configured` there would alert forever and get muted. So the healthy state is
   * configurable; a sample equal to it resets the persistence timer.
   */
  healthyState: UdcState;
}

/**
 * Defaults from the measured pikvm01 behaviour. `escalatedIntervalMs` is PROVISIONAL
 * (5s) pending the iPad node's proposed value + manager sign-off. On-box measurement
 * showed down-windows are ≤220ms (so `configured` windows are the long stretches),
 * which means aliasing is NOT the binding constraint after all — a poll landing
 * inside a recoverable blip is ~0.015% at baseline, ~1% mid-burst, so the stays-quiet
 * arm is near-guaranteed by physics at any interval 1–60s. The interval stays a
 * parameter (and the anti-alias invariant still holds cheaply), it just needn't be tiny.
 */
export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  baselineIntervalMs: 60_000,
  escalatedIntervalMs: 5_000,
  persistenceThresholdMs: 90_000,
  latchReenumMax: 2,
  healthyState: UDC_UP, // `configured` — correct for pikvm01; override per uncabled target
};

/**
 * The pure persistence state machine. Feed samples in time order via {@link observe};
 * it returns a {@link LatchAlert} exactly once per latch (re-arming only after an
 * observed `configured`), else null. Holds no timers and does no I/O.
 */
export class HidLatchMonitor {
  private readonly cfg: MonitorConfig;
  /** `t` of the first non-`configured` since the last `configured`; null while up. */
  private downSince: number | null = null;
  /** reenumCount snapshot at downSince, to compute the in-window delta. */
  private reenumAtDown = 0;
  /** Whether we've already fired for the current down-window (fire-once-per-latch). */
  private alerted = false;

  constructor(cfg?: Partial<MonitorConfig>) {
    this.cfg = { ...DEFAULT_MONITOR_CONFIG, ...cfg };
  }

  /** Whether a UDC `state` is the healthy baseline for THIS target (per-target config). */
  isHealthy(state: UdcState): boolean {
    return state === this.cfg.healthyState;
  }

  observe(sample: UdcSample): LatchAlert | null {
    if (this.isHealthy(sample.state)) {
      // Any healthy sample resets the persistence window and re-arms the alert.
      this.downSince = null;
      this.alerted = false;
      return null;
    }

    // non-healthy
    if (this.downSince === null) {
      this.downSince = sample.t;
      this.reenumAtDown = sample.reenumCount;
      this.alerted = false;
    }

    const latchDurationMs = sample.t - this.downSince;
    if (!this.alerted && latchDurationMs >= this.cfg.persistenceThresholdMs) {
      this.alerted = true;
      const reenumCountInWindow = sample.reenumCount - this.reenumAtDown;
      const classification: LatchClassification =
        reenumCountInWindow <= this.cfg.latchReenumMax ? 'latched' : 'thrashing';
      return {
        kind: 'alert',
        firedAt: sample.t,
        downSince: this.downSince,
        latchDurationMs,
        state: sample.state,
        reenumCountInWindow,
        // A flatline latch is rebind-able (R2 soft_connect); a thrashing storm is an
        // electrical fault a rebind won't fix — point at power/cable instead.
        classification,
        recommendedRung: classification === 'latched' ? 'soft_connect' : 'power_cable',
      };
    }
    return null;
  }

  /**
   * The cadence the runner should poll at RIGHT NOW: escalated once a down-window is
   * open (to catch short `configured` windows before the timer wrongly persists),
   * baseline while healthy. Lets the loop stay cheap at rest and fine under suspicion.
   */
  desiredIntervalMs(): number {
    return this.downSince === null ? this.cfg.baselineIntervalMs : this.cfg.escalatedIntervalMs;
  }

  /** Snapshot for the runner's per-tick JSONL record. */
  status(): { down: boolean; downSince: number | null; alerted: boolean } {
    return { down: this.downSince !== null, downSince: this.downSince, alerted: this.alerted };
  }
}
