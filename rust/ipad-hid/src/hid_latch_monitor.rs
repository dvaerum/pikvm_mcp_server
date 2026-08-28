//! HID-LATCH MONITOR — the pure, sample-driven detection core (report-only v1).
//!
//! Faithful port of `src/pikvm/hid-latch-monitor.ts`.
//!
//! WHY: pikvm01's HID was latched dead for 6.61 days and nothing noticed —
//! kvmd/kvmd-otg both showed NRestarts=0 and "active" throughout; systemd
//! was green for the entire outage. The alarm we were missing is a LATCH,
//! not a blip.
//!
//! THE KEY CONSTRAINT — alert on the LATCH, not the re-enumeration.
//! Re-enumerations are NORMAL (each self-healing in 1-3s); a naive
//! `unhealthy → alert` fires constantly, gets muted, and manufactures the
//! exact silence we're removing. So detection is PERSISTENCE-based: the
//! timer resets on ANY healthy sample, and we alert only when non-healthy
//! persists past a threshold (default 90s).
//!
//! SIGNAL-AGNOSTIC: this core consumes an ordered stream of [`HealthSample`]
//! readings whose `healthy` boolean is computed BY THE SOURCE. It knows
//! nothing about UDC state strings, gadget bound-ness, SSH, or the
//! transport — the source owns the health predicate. That keeps the
//! detection logic deterministic + unit-testable against traces, and lets
//! the same classifier serve a remote SSH sampler or a local sysfs read
//! unchanged.
//!
//! v1 is REPORT-ONLY — the alert only RECOMMENDS a rung.

/// Raw value of `/sys/class/udc/<udc>/state`, when a source deals in UDC states.
pub type UdcStateStr = String;

/// The UDC state in which the emulated HID drives the target — a convenience
/// for sources.
pub const UDC_UP: &str = "configured";

/// One reading from a sampler. The health decision is a pre-computed BOOLEAN
/// so the classifier is signal-agnostic; the source owns whatever composite
/// produced it.
#[derive(Clone, Debug, Default)]
pub struct HealthSample {
    /// Epoch ms of the read (the RUNNER's clock — never a journal timestamp,
    /// which can be pre-NTP stale on an RTC-less appliance).
    pub t: i64,
    /// The source's health verdict. `false` ⇒ counts toward a latch.
    pub healthy: bool,
    /// Monotonic, NON-DECREASING, NORMALISED by the runner + baselined at
    /// first read (a RELATIVE counter near 0, not the raw since-boot
    /// value). Only the in-window DELTA is used, so the origin is
    /// irrelevant.
    pub reenum_count: i64,
    /// `/proc/sys/kernel/random/boot_id`, when supplied. A change WITHIN a
    /// down-window means a reboot reset the reenum-count journal while
    /// `down_since` survived — so the latched/thrashing split across that
    /// window can't be trusted.
    pub boot_id: Option<String>,
    /// SOURCE diagnostics passed through UNTOUCHED into the tick/alert/status
    /// records. The classifier ignores these; they exist purely for the
    /// operator-facing surface.
    pub detail: Option<String>,
    pub bound: Option<bool>,
    pub state: Option<String>,
}

/// `Latched` = flatlined/dead (rebind-able); `Thrashing` = re-enumerating but
/// never settling (power/cable).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LatchClassification {
    Latched,
    Thrashing,
}

/// Recommended remediation rung. `SoftConnect`/`UdcRebind` mirror the
/// HID-recovery ladder (R2/R3a). `PowerCable` is NOT a ladder action — a
/// thrashing storm is an electrical fault (under-volt) a UDC rebind will
/// not fix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecommendedRung {
    SoftConnect,
    UdcRebind,
    PowerCable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClassificationConfidence {
    Reliable,
    Unreliable,
}

/// Emitted exactly once when a down-window first crosses the persistence
/// threshold.
#[derive(Clone, Debug)]
pub struct LatchAlert {
    /// `t` of the sample that crossed the threshold.
    pub fired_at: i64,
    /// `t` of the first non-healthy sample after the last healthy one (the
    /// persistence anchor).
    pub down_since: i64,
    /// `fired_at − down_since`.
    pub latch_duration_ms: i64,
    /// The source's diagnostic detail at the moment of firing.
    pub detail: Option<String>,
    /// reenumCount delta across the persistence window (fire − anchor).
    pub reenum_count_in_window: i64,
    pub classification: LatchClassification,
    pub recommended_rung: RecommendedRung,
    /// Human-readable rationale for the rung, incl. the pikvm01 escalation caveat.
    pub note: String,
    /// True if the target rebooted during the window (boot_id changed) — the
    /// reenum baseline reset, so a small count may be an artifact, not a
    /// real flatline.
    pub rebooted_during_window: bool,
    /// `Unreliable` when a reboot reset the reenum counter mid-window: the
    /// split (and thus `recommended_rung`) is a best-effort guess and MUST
    /// NOT be auto-acted on. The latch itself is still real, which is why
    /// the window is kept, not discarded.
    pub classification_confidence: ClassificationConfidence,
}

#[derive(Clone, Copy, Debug)]
pub struct MonitorConfig {
    /// Coarse baseline sampling cadence (ms) while healthy.
    pub baseline_interval_ms: i64,
    /// ESCALATED sampling cadence (ms) once a non-healthy sample is seen.
    pub escalated_interval_ms: i64,
    /// Fire when non-healthy persists this long (ms) with no intervening
    /// healthy sample.
    pub persistence_threshold_ms: i64,
    /// `reenum_count_in_window <= this` ⇒ Latched (flatline); above ⇒ Thrashing.
    pub latch_reenum_max: i64,
}

/// Defaults from measured behaviour. `escalated_interval_ms` (5s) is safe by
/// a wide margin from the measured ≤220ms down-window bound — a poll
/// landing inside a recoverable blip is ~0.015%/~1%, and firing needs 90s
/// CONTINUOUS non-healthy, so the stays-quiet arm is near-guaranteed by
/// physics, not by tuning.
impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            baseline_interval_ms: 60_000,
            escalated_interval_ms: 5_000,
            persistence_threshold_ms: 90_000,
            latch_reenum_max: 2,
        }
    }
}

/// What [`HidLatchMonitor::status`] exposes so the runner can assemble the
/// status file.
#[derive(Clone, Debug)]
pub struct MonitorStatus {
    pub down: bool,
    pub down_since: Option<i64>,
    pub alerted: bool,
    /// The alert fired for the CURRENT down-window (`None` while healthy or
    /// before threshold).
    pub active_alert: Option<LatchAlert>,
}

/// The pure persistence state machine. Feed samples in time order via
/// [`HidLatchMonitor::observe`]; it returns a [`LatchAlert`] exactly once
/// per latch (re-arming only after a healthy sample), else `None`. Holds no
/// timers and does no I/O.
pub struct HidLatchMonitor {
    cfg: MonitorConfig,
    /// `t` of the first non-healthy since the last healthy sample; `None` while up.
    down_since: Option<i64>,
    /// reenumCount snapshot at down_since, to compute the in-window delta.
    reenum_at_down: i64,
    /// boot_id observed when the window was anchored; `None` if the source omits it.
    boot_id_at_down: Option<String>,
    /// Whether a reboot (boot_id change) has been seen within the current down-window.
    rebooted_in_window: bool,
    /// Whether we've already fired for the current down-window (fire-once-per-latch).
    alerted: bool,
    /// The alert fired for the current down-window (for the status surface); cleared on healthy.
    active_alert: Option<LatchAlert>,
}

impl HidLatchMonitor {
    pub fn new(cfg: MonitorConfig) -> Self {
        Self {
            cfg,
            down_since: None,
            reenum_at_down: 0,
            boot_id_at_down: None,
            rebooted_in_window: false,
            alerted: false,
            active_alert: None,
        }
    }

    pub fn observe(&mut self, sample: &HealthSample) -> Option<LatchAlert> {
        if sample.healthy {
            // Any healthy sample resets the persistence window and re-arms the alert.
            self.down_since = None;
            self.boot_id_at_down = None;
            self.rebooted_in_window = false;
            self.alerted = false;
            self.active_alert = None;
            return None;
        }

        // non-healthy
        match self.down_since {
            None => {
                self.down_since = Some(sample.t);
                self.reenum_at_down = sample.reenum_count;
                self.boot_id_at_down = sample.boot_id.clone();
                self.rebooted_in_window = false;
                self.alerted = false;
                self.active_alert = None;
            }
            Some(_) => {
                if let (Some(sample_boot), Some(anchor_boot)) =
                    (&sample.boot_id, &self.boot_id_at_down)
                {
                    if sample_boot != anchor_boot {
                        // Target rebooted mid-window: the reenum baseline reset while the window lives.
                        self.rebooted_in_window = true;
                    }
                }
            }
        }

        let down_since = self.down_since.unwrap();
        let latch_duration_ms = sample.t - down_since;
        if !self.alerted && latch_duration_ms >= self.cfg.persistence_threshold_ms {
            self.alerted = true;
            let reenum_count_in_window = sample.reenum_count - self.reenum_at_down;
            let classification = if reenum_count_in_window <= self.cfg.latch_reenum_max {
                LatchClassification::Latched
            } else {
                LatchClassification::Thrashing
            };
            // A flatline latch is Mode B in the HID-recovery ladder: R2
            // soft_connect has been INSUFFICIENT for this signature on
            // pikvm01 (2026-07-26 + 2026-08-08 — it left UDC "not
            // attached"; only R3a udc-rebind revived it), so we recommend
            // udc-rebind directly. A thrashing storm is electrical
            // (power/cable).
            let recommended_rung = if classification == LatchClassification::Latched {
                RecommendedRung::UdcRebind
            } else {
                RecommendedRung::PowerCable
            };
            let mut note = match classification {
                LatchClassification::Latched => {
                    "flatline latch: the M0 ladder starts at soft_connect, but this signature on \
                     pikvm01 has needed udc-rebind (soft_connect insufficient 2026-07-26 + \
                     2026-08-08) — expect to escalate."
                        .to_string()
                }
                LatchClassification::Thrashing => {
                    "never-settling storm: an under-volt/electrical fault — a UDC rebind will not \
                     fix it; check power/cable."
                        .to_string()
                }
            };
            if self.rebooted_in_window {
                note = format!(
                    "classification UNRELIABLE — the target rebooted mid-window (reenum baseline \
                     reset), so latched/thrashing cannot be trusted. {note}"
                );
            }
            let alert = LatchAlert {
                fired_at: sample.t,
                down_since,
                latch_duration_ms,
                detail: sample.detail.clone(),
                reenum_count_in_window,
                classification,
                recommended_rung,
                note,
                rebooted_during_window: self.rebooted_in_window,
                classification_confidence: if self.rebooted_in_window {
                    ClassificationConfidence::Unreliable
                } else {
                    ClassificationConfidence::Reliable
                },
            };
            self.active_alert = Some(alert.clone());
            return Some(alert);
        }
        None
    }

    /// The cadence the runner should poll at RIGHT NOW: escalated once a
    /// down-window is open, baseline while healthy. Lets the loop stay
    /// cheap at rest and fine under suspicion.
    pub fn desired_interval_ms(&self) -> i64 {
        if self.down_since.is_none() {
            self.cfg.baseline_interval_ms
        } else {
            self.cfg.escalated_interval_ms
        }
    }

    /// Snapshot for the runner's per-tick JSONL + the status file.
    pub fn status(&self) -> MonitorStatus {
        MonitorStatus {
            down: self.down_since.is_some(),
            down_since: self.down_since,
            alerted: self.alerted,
            active_alert: self.active_alert.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy_sample(t: i64, reenum: i64) -> HealthSample {
        HealthSample {
            t,
            healthy: true,
            reenum_count: reenum,
            ..Default::default()
        }
    }

    fn unhealthy_sample(t: i64, reenum: i64) -> HealthSample {
        HealthSample {
            t,
            healthy: false,
            reenum_count: reenum,
            ..Default::default()
        }
    }

    #[test]
    fn observe_healthy_sample_never_alerts_and_resets_the_window() {
        let mut m = HidLatchMonitor::new(MonitorConfig::default());
        assert!(m.observe(&healthy_sample(0, 0)).is_none());
        assert!(!m.status().down);
    }

    #[test]
    fn observe_short_unhealthy_blip_does_not_alert() {
        let mut m = HidLatchMonitor::new(MonitorConfig::default());
        assert!(m.observe(&unhealthy_sample(0, 0)).is_none());
        // 1s later, well under the 90s default threshold.
        assert!(m.observe(&unhealthy_sample(1_000, 0)).is_none());
        assert!(m.status().down);
        assert!(!m.status().alerted);
    }

    #[test]
    fn observe_persistent_unhealthy_alerts_exactly_at_threshold() {
        let cfg = MonitorConfig {
            persistence_threshold_ms: 90_000,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        m.observe(&unhealthy_sample(0, 0));
        assert!(m.observe(&unhealthy_sample(89_999, 0)).is_none());
        let alert = m.observe(&unhealthy_sample(90_000, 0)).unwrap();
        assert_eq!(alert.fired_at, 90_000);
        assert_eq!(alert.down_since, 0);
        assert_eq!(alert.latch_duration_ms, 90_000);
    }

    #[test]
    fn observe_fires_exactly_once_per_latch_not_on_every_subsequent_sample() {
        let cfg = MonitorConfig {
            persistence_threshold_ms: 1_000,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        m.observe(&unhealthy_sample(0, 0));
        assert!(m.observe(&unhealthy_sample(1_000, 0)).is_some());
        // Still down, still unhealthy — must NOT fire again (fire-once-per-latch).
        assert!(m.observe(&unhealthy_sample(2_000, 0)).is_none());
        assert!(m.observe(&unhealthy_sample(10_000, 0)).is_none());
    }

    #[test]
    fn observe_rearms_after_a_healthy_sample_between_two_latches() {
        let cfg = MonitorConfig {
            persistence_threshold_ms: 1_000,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        m.observe(&unhealthy_sample(0, 0));
        assert!(m.observe(&unhealthy_sample(1_000, 0)).is_some());
        // Recovers.
        m.observe(&healthy_sample(1_500, 0));
        assert!(!m.status().down);
        // A SECOND latch must be able to fire again.
        m.observe(&unhealthy_sample(2_000, 0));
        assert!(m.observe(&unhealthy_sample(3_000, 0)).is_some());
    }

    #[test]
    fn observe_classifies_latched_when_reenum_count_stays_low() {
        let cfg = MonitorConfig {
            persistence_threshold_ms: 1_000,
            latch_reenum_max: 2,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        m.observe(&unhealthy_sample(0, 0));
        let alert = m.observe(&unhealthy_sample(1_000, 1)).unwrap(); // delta=1 <= max=2
        assert_eq!(alert.classification, LatchClassification::Latched);
        assert_eq!(alert.recommended_rung, RecommendedRung::UdcRebind);
    }

    #[test]
    fn observe_classifies_thrashing_when_reenum_count_is_high() {
        let cfg = MonitorConfig {
            persistence_threshold_ms: 1_000,
            latch_reenum_max: 2,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        m.observe(&unhealthy_sample(0, 0));
        let alert = m.observe(&unhealthy_sample(1_000, 50)).unwrap(); // delta=50 > max=2
        assert_eq!(alert.classification, LatchClassification::Thrashing);
        assert_eq!(alert.recommended_rung, RecommendedRung::PowerCable);
    }

    #[test]
    fn observe_marks_unreliable_when_boot_id_changes_mid_window() {
        let cfg = MonitorConfig {
            persistence_threshold_ms: 1_000,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        m.observe(&HealthSample {
            t: 0,
            healthy: false,
            reenum_count: 0,
            boot_id: Some("boot-a".to_string()),
            ..Default::default()
        });
        let alert = m
            .observe(&HealthSample {
                t: 1_000,
                healthy: false,
                reenum_count: 0,
                boot_id: Some("boot-b".to_string()), // reboot mid-window
                ..Default::default()
            })
            .unwrap();
        assert!(alert.rebooted_during_window);
        assert_eq!(
            alert.classification_confidence,
            ClassificationConfidence::Unreliable
        );
        assert!(alert.note.starts_with("classification UNRELIABLE"));
    }

    #[test]
    fn observe_stays_reliable_when_boot_id_is_stable() {
        let cfg = MonitorConfig {
            persistence_threshold_ms: 1_000,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        let boot = Some("boot-a".to_string());
        m.observe(&HealthSample {
            t: 0,
            healthy: false,
            reenum_count: 0,
            boot_id: boot.clone(),
            ..Default::default()
        });
        let alert = m
            .observe(&HealthSample {
                t: 1_000,
                healthy: false,
                reenum_count: 0,
                boot_id: boot,
                ..Default::default()
            })
            .unwrap();
        assert!(!alert.rebooted_during_window);
        assert_eq!(
            alert.classification_confidence,
            ClassificationConfidence::Reliable
        );
    }

    #[test]
    fn desired_interval_ms_is_baseline_while_healthy_and_escalated_while_down() {
        let cfg = MonitorConfig {
            baseline_interval_ms: 60_000,
            escalated_interval_ms: 5_000,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        assert_eq!(m.desired_interval_ms(), 60_000);
        m.observe(&unhealthy_sample(0, 0));
        assert_eq!(m.desired_interval_ms(), 5_000);
        m.observe(&healthy_sample(100, 0));
        assert_eq!(m.desired_interval_ms(), 60_000);
    }

    #[test]
    fn status_reflects_active_alert_until_next_healthy_sample() {
        let cfg = MonitorConfig {
            persistence_threshold_ms: 1_000,
            ..Default::default()
        };
        let mut m = HidLatchMonitor::new(cfg);
        m.observe(&unhealthy_sample(0, 0));
        m.observe(&unhealthy_sample(1_000, 0));
        assert!(m.status().active_alert.is_some());
        m.observe(&healthy_sample(1_100, 0));
        assert!(m.status().active_alert.is_none());
    }

    #[test]
    fn udc_up_constant_matches_the_kernel_state_string() {
        assert_eq!(UDC_UP, "configured");
    }
}
