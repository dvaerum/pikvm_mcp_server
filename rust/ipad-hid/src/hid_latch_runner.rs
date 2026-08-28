//! HID-latch monitor RUNNER — the headless poll loop around the pure
//! [`HidLatchMonitor`] core.
//!
//! Faithful port of `src/pikvm/hid-latch-runner.ts`.
//!
//! The source is INJECTED (SSH for pikvm01, local sysfs on the pikvm-nixos
//! appliance), and so is the wall clock, so the loop is unit-tested
//! deterministically with a scripted source. The source computes the
//! `healthy` verdict; the runner normalises the raw re-enum count to
//! monotonic, feeds the signal-agnostic classifier, emits JSONL
//! (tick/alert/source_error), and — for the appliance systemd deployment —
//! builds a [`LatchStatus`] snapshot each iteration that the caller
//! persists (atomically to `/run/pikvm-hid-latch/status.json`) for the
//! appliance endpoint + MCP health_check. `last_sample_at` advances EVERY
//! iteration, so a hung loop shows as a stale timestamp (systemd Restart
//! covers a crash; this covers a hang).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::hid_latch_monitor::{
    ClassificationConfidence, HealthSample, HidLatchMonitor, LatchAlert, LatchClassification,
    RecommendedRung,
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One raw reading from the transport. The source computes `healthy` (the
/// composite health verdict) + a RAW re-enum count (NOT guaranteed
/// monotonic across a journal reset); `detail`/`bound`/`state` are
/// diagnostics passed through to the records. `Err` is a genuine
/// TRANSPORT/read fault (e.g. `/sys` unreadable), categorically distinct
/// from a healthy:false reading — a `#48` unbound gadget is `healthy:
/// false`, NOT a source error.
#[derive(Clone, Debug)]
pub enum SourceReading {
    Ok {
        healthy: bool,
        raw_reenum: i64,
        boot_id: Option<String>,
        detail: Option<String>,
        bound: Option<bool>,
        state: Option<String>,
    },
    Err {
        error: String,
    },
}

/// Pulls one reading. The SSH + local adapters implement this; tests inject a fake.
pub type SampleSource = Arc<dyn Fn() -> BoxFuture<'static, SourceReading> + Send + Sync>;

/// Why a tick record was emitted (steady state is not logged every poll).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickReason {
    Transition,
    Heartbeat,
}

/// JSONL records emitted to stdout — the durable report.
#[derive(Clone, Debug)]
pub enum MonitorRecord {
    Tick {
        reason: TickReason,
        t: i64,
        healthy: bool,
        reenum_count: i64,
        down: bool,
        down_since: Option<i64>,
        detail: Option<String>,
        bound: Option<bool>,
        state: Option<String>,
    },
    /// The alert record is the [`LatchAlert`] itself.
    Alert(LatchAlert),
    SourceError {
        t: i64,
        error: String,
        /// How many consecutive reads have failed — a blind monitor is
        /// itself a fault to surface.
        consecutive: u32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusClassificationConfidence {
    Ok,
    Unreliable,
}

/// The status snapshot the appliance surface reads
/// (→ `/run/pikvm-hid-latch/status.json` → `GET /hid-recovery/latch-status`
/// → MCP health_check). `last_sample_at` is the self-liveness read
/// (advances every loop iteration; stale ⇒ the monitor hung).
#[derive(Clone, Debug)]
pub struct LatchStatus {
    pub ok: bool,
    pub healthy: Option<bool>,
    pub bound: Option<bool>,
    pub state: Option<String>,
    pub detail: Option<String>,
    pub alert: bool,
    pub classification: Option<LatchClassification>,
    pub classification_confidence: Option<StatusClassificationConfidence>,
    pub recommended_rung: Option<RecommendedRung>,
    pub down_since: Option<i64>,
    pub sustained_for_sec: f64,
    pub reenum_count: i64,
    pub boot_id: Option<String>,
    pub last_sample_at: i64,
    /// Last source_error message, when the last read errored; `None` otherwise.
    pub last_error: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct RunnerConfig {
    /// Emit a heartbeat `tick` after this many polls with no transition
    /// (proof-of-life in the log).
    pub heartbeat_every_ticks: u32,
}

/// ~10 min between heartbeats at the 60s baseline — proof-of-life at low log cost.
impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            heartbeat_every_ticks: 10,
        }
    }
}

/// Called each iteration with the current status snapshot (main persists it atomically).
pub type OnStatusFn = Arc<dyn Fn(&LatchStatus) + Send + Sync>;

pub struct RunnerDeps {
    pub source: SampleSource,
    /// Wall clock (ms). Injected for deterministic tests.
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Sleep for the poll interval. Injected (a fake advances the test clock).
    pub sleep: Arc<dyn Fn(i64) -> BoxFuture<'static, ()> + Send + Sync>,
    /// Sink for JSONL records.
    pub emit: Arc<dyn Fn(&MonitorRecord) + Send + Sync>,
    pub on_status: Option<OnStatusFn>,
    /// Loop while this returns false. Omit (`None`) for a never-ending
    /// daemon; tests pass a bounded one.
    pub should_stop: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub config: RunnerConfig,
}

/// The poll loop. Each iteration: read the source, normalise the re-enum
/// counter to a monotonic value, feed the pure monitor, emit JSONL
/// (transitions/alerts/errors/heartbeats), and build the status snapshot.
///
/// INVARIANT: a read failure does NOT advance the latch timer — the
/// monitor is only fed real readings, so a transport/read outage can never
/// masquerade as a latch nor hide one; the two faults are reported as
/// different records.
pub async fn run_monitor_loop(deps: RunnerDeps, monitor: &mut HidLatchMonitor) {
    let cfg = deps.config;

    let mut monotonic_reenum: i64 = 0;
    let mut last_raw: Option<i64> = None;
    let mut consecutive_errors: u32 = 0;
    let mut last_emitted_healthy: Option<bool> = None;
    let mut ticks_since_emit: u32 = 0;
    // Last successful sample diagnostics, retained for the status snapshot across errors.
    let mut last_healthy: Option<bool> = None;
    let mut last_bound: Option<bool> = None;
    let mut last_state: Option<String> = None;
    let mut last_detail: Option<String> = None;
    let mut last_boot_id: Option<String> = None;

    let build_status = |t: i64,
                        ok: bool,
                        last_error: Option<String>,
                        monotonic_reenum: i64,
                        last_healthy: Option<bool>,
                        last_bound: Option<bool>,
                        last_state: Option<String>,
                        last_detail: Option<String>,
                        last_boot_id: Option<String>,
                        monitor: &HidLatchMonitor|
     -> LatchStatus {
        let st = monitor.status();
        let a = &st.active_alert;
        LatchStatus {
            ok,
            healthy: last_healthy,
            bound: last_bound,
            state: last_state,
            detail: last_detail,
            alert: st.alerted,
            classification: a.as_ref().map(|a| a.classification),
            classification_confidence: a.as_ref().map(|a| match a.classification_confidence {
                ClassificationConfidence::Reliable => StatusClassificationConfidence::Ok,
                ClassificationConfidence::Unreliable => StatusClassificationConfidence::Unreliable,
            }),
            recommended_rung: a.as_ref().map(|a| a.recommended_rung),
            down_since: st.down_since,
            sustained_for_sec: st
                .down_since
                .map_or(0.0, |ds| ((t - ds) as f64 / 1000.0).max(0.0)),
            reenum_count: monotonic_reenum,
            boot_id: last_boot_id,
            last_sample_at: t, // advances every iteration → a stale value means the loop hung
            last_error,
        }
    };

    loop {
        if deps.should_stop.as_ref().map(|f| f()).unwrap_or(false) {
            break;
        }
        let t = (deps.now)();
        let reading = (deps.source)().await;

        match reading {
            SourceReading::Err { error } => {
                consecutive_errors += 1;
                (deps.emit)(&MonitorRecord::SourceError {
                    t,
                    error: error.clone(),
                    consecutive: consecutive_errors,
                });
                // Do NOT feed the monitor: a read fault ≠ unhealthy. Still refresh liveness/status.
                if let Some(on_status) = &deps.on_status {
                    on_status(&build_status(
                        t,
                        false,
                        Some(error),
                        monotonic_reenum,
                        last_healthy,
                        last_bound,
                        last_state.clone(),
                        last_detail.clone(),
                        last_boot_id.clone(),
                        monitor,
                    ));
                }
                (deps.sleep)(monitor.desired_interval_ms()).await;
                continue;
            }
            SourceReading::Ok {
                healthy,
                raw_reenum,
                boot_id,
                detail,
                bound,
                state,
            } => {
                consecutive_errors = 0;

                // Normalise the raw reading to a monotonic counter: a DECREASE means the
                // journal reset/ring-wrapped — never count a negative increment (boot_id
                // guards the reboot).
                if let Some(lr) = last_raw {
                    if raw_reenum >= lr {
                        monotonic_reenum += raw_reenum - lr;
                    }
                }
                last_raw = Some(raw_reenum);

                last_healthy = Some(healthy);
                last_bound = bound;
                last_state = state.clone();
                last_detail = detail.clone();
                last_boot_id = boot_id.clone();

                let sample = HealthSample {
                    t,
                    healthy,
                    reenum_count: monotonic_reenum,
                    boot_id: boot_id.clone(),
                    detail: detail.clone(),
                    bound,
                    state: state.clone(),
                };
                let alert = monitor.observe(&sample);
                let st = monitor.status();

                ticks_since_emit += 1;
                let is_transition =
                    last_emitted_healthy.is_none() || Some(healthy) != last_emitted_healthy;
                if is_transition || ticks_since_emit >= cfg.heartbeat_every_ticks {
                    (deps.emit)(&MonitorRecord::Tick {
                        reason: if is_transition {
                            TickReason::Transition
                        } else {
                            TickReason::Heartbeat
                        },
                        t,
                        healthy,
                        reenum_count: monotonic_reenum,
                        down: st.down,
                        down_since: st.down_since,
                        detail: detail.clone(),
                        bound,
                        state: state.clone(),
                    });
                    last_emitted_healthy = Some(healthy);
                    ticks_since_emit = 0;
                }

                if let Some(alert) = alert {
                    (deps.emit)(&MonitorRecord::Alert(alert));
                }
                if let Some(on_status) = &deps.on_status {
                    on_status(&build_status(
                        t,
                        true,
                        None,
                        monotonic_reenum,
                        last_healthy,
                        last_bound,
                        last_state.clone(),
                        last_detail.clone(),
                        last_boot_id.clone(),
                        monitor,
                    ));
                }

                (deps.sleep)(monitor.desired_interval_ms()).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hid_latch_monitor::MonitorConfig;
    use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
    use std::sync::Mutex;

    fn scripted_source(readings: Vec<SourceReading>) -> SampleSource {
        let idx = Arc::new(AtomicU32::new(0));
        let readings = Arc::new(readings);
        Arc::new(move || {
            let i = idx.fetch_add(1, Ordering::SeqCst) as usize;
            let readings = readings.clone();
            Box::pin(async move {
                readings.get(i).cloned().unwrap_or(SourceReading::Err {
                    error: "no more readings".to_string(),
                })
            })
        })
    }

    fn bounded_stop(after: u32) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let count = Arc::new(AtomicU32::new(0));
        Arc::new(move || count.fetch_add(1, Ordering::SeqCst) >= after)
    }

    fn ok_reading(healthy: bool, raw_reenum: i64) -> SourceReading {
        SourceReading::Ok {
            healthy,
            raw_reenum,
            boot_id: None,
            detail: None,
            bound: None,
            state: None,
        }
    }

    fn test_deps(
        source: SampleSource,
        stop_after: u32,
        emitted: Arc<Mutex<Vec<MonitorRecord>>>,
    ) -> RunnerDeps {
        let clock = Arc::new(AtomicI64::new(0));
        let clock_for_now = clock.clone();
        let clock_for_sleep = clock.clone();
        RunnerDeps {
            source,
            now: Arc::new(move || clock_for_now.load(Ordering::SeqCst)),
            sleep: Arc::new(move |ms: i64| {
                clock_for_sleep.fetch_add(ms, Ordering::SeqCst);
                Box::pin(async {})
            }),
            emit: Arc::new(move |rec: &MonitorRecord| emitted.lock().unwrap().push(rec.clone())),
            on_status: None,
            should_stop: Some(bounded_stop(stop_after)),
            config: RunnerConfig::default(),
        }
    }

    #[tokio::test]
    async fn run_monitor_loop_emits_a_transition_tick_on_the_first_sample() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let source = scripted_source(vec![ok_reading(true, 0)]);
        let deps = test_deps(source, 1, emitted.clone());
        let mut monitor = HidLatchMonitor::new(MonitorConfig::default());
        run_monitor_loop(deps, &mut monitor).await;
        let recs = emitted.lock().unwrap();
        assert_eq!(recs.len(), 1);
        matches!(
            recs[0],
            MonitorRecord::Tick {
                reason: TickReason::Transition,
                ..
            }
        );
    }

    #[tokio::test]
    async fn run_monitor_loop_source_error_does_not_feed_the_monitor() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let source = scripted_source(vec![SourceReading::Err {
            error: "ssh timeout".to_string(),
        }]);
        let deps = test_deps(source, 1, emitted.clone());
        let mut monitor = HidLatchMonitor::new(MonitorConfig::default());
        run_monitor_loop(deps, &mut monitor).await;
        let recs = emitted.lock().unwrap();
        assert_eq!(recs.len(), 1);
        match &recs[0] {
            MonitorRecord::SourceError {
                error, consecutive, ..
            } => {
                assert_eq!(error, "ssh timeout");
                assert_eq!(*consecutive, 1);
            }
            other => panic!("expected SourceError, got {other:?}"),
        }
        // The monitor never observed a sample -> not down.
        assert!(!monitor.status().down);
    }

    #[tokio::test]
    async fn run_monitor_loop_normalizes_reenum_count_monotonically_and_ignores_a_journal_reset_decrease(
    ) {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        // raw_reenum: 10 -> 2 (decrease, journal reset, ignored) -> 5 (increase from 2, +3).
        let source = scripted_source(vec![
            ok_reading(true, 10),
            ok_reading(true, 2),
            ok_reading(true, 5),
        ]);
        let stop_after = 3;
        let clock = Arc::new(AtomicI64::new(0));
        let clock_for_now = clock.clone();
        let clock_for_sleep = clock.clone();
        let emitted_clone = emitted.clone();
        let deps = RunnerDeps {
            source,
            now: Arc::new(move || clock_for_now.load(Ordering::SeqCst)),
            sleep: Arc::new(move |ms: i64| {
                clock_for_sleep.fetch_add(ms, Ordering::SeqCst);
                Box::pin(async {})
            }),
            emit: Arc::new(move |rec: &MonitorRecord| {
                emitted_clone.lock().unwrap().push(rec.clone())
            }),
            on_status: None,
            should_stop: Some(bounded_stop(stop_after)),
            // Force every tick to emit so we can inspect the final reenumCount.
            config: RunnerConfig {
                heartbeat_every_ticks: 1,
            },
        };
        let mut monitor = HidLatchMonitor::new(MonitorConfig::default());
        run_monitor_loop(deps, &mut monitor).await;
        let recs = emitted.lock().unwrap();
        let last_tick_reenum = recs.iter().rev().find_map(|r| match r {
            MonitorRecord::Tick { reenum_count, .. } => Some(*reenum_count),
            _ => None,
        });
        // 10 (first, delta 0 since last_raw was None) -> decrease to 2 ignored (still 0) -> +3 from 2->5 = 3.
        assert_eq!(last_tick_reenum, Some(3));
    }

    #[tokio::test]
    async fn run_monitor_loop_heartbeat_fires_after_configured_tick_count_with_no_transition() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        // All healthy=true, no transitions -> only heartbeats every 2 ticks.
        let source = scripted_source(vec![
            ok_reading(true, 0),
            ok_reading(true, 1),
            ok_reading(true, 2),
        ]);
        let clock = Arc::new(AtomicI64::new(0));
        let emitted_clone = emitted.clone();
        let deps = RunnerDeps {
            source,
            now: Arc::new({
                let clock = clock.clone();
                move || clock.load(Ordering::SeqCst)
            }),
            sleep: Arc::new({
                let clock = clock.clone();
                move |ms: i64| {
                    clock.fetch_add(ms, Ordering::SeqCst);
                    Box::pin(async {})
                }
            }),
            emit: Arc::new(move |rec: &MonitorRecord| {
                emitted_clone.lock().unwrap().push(rec.clone())
            }),
            on_status: None,
            should_stop: Some(bounded_stop(3)),
            config: RunnerConfig {
                heartbeat_every_ticks: 2,
            },
        };
        let mut monitor = HidLatchMonitor::new(MonitorConfig::default());
        run_monitor_loop(deps, &mut monitor).await;
        let recs = emitted.lock().unwrap();
        // tick1: transition (first sample). tick2: no transition, ticksSinceEmit=1 < 2 -> suppressed.
        // tick3: ticksSinceEmit=2 >= 2 -> heartbeat.
        let tick_reasons: Vec<TickReason> = recs
            .iter()
            .filter_map(|r| match r {
                MonitorRecord::Tick { reason, .. } => Some(*reason),
                _ => None,
            })
            .collect();
        assert_eq!(
            tick_reasons,
            vec![TickReason::Transition, TickReason::Heartbeat]
        );
    }

    #[tokio::test]
    async fn run_monitor_loop_on_status_reflects_last_successful_sample_across_a_later_error() {
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let source = scripted_source(vec![
            ok_reading(true, 0),
            SourceReading::Err {
                error: "transient".to_string(),
            },
        ]);
        let clock = Arc::new(AtomicI64::new(0));
        let statuses_clone = statuses.clone();
        let emitted_clone = emitted.clone();
        let deps = RunnerDeps {
            source,
            now: Arc::new({
                let clock = clock.clone();
                move || clock.load(Ordering::SeqCst)
            }),
            sleep: Arc::new({
                let clock = clock.clone();
                move |ms: i64| {
                    clock.fetch_add(ms, Ordering::SeqCst);
                    Box::pin(async {})
                }
            }),
            emit: Arc::new(move |rec: &MonitorRecord| {
                emitted_clone.lock().unwrap().push(rec.clone())
            }),
            on_status: Some(Arc::new(move |s: &LatchStatus| {
                statuses_clone.lock().unwrap().push(s.clone())
            })),
            should_stop: Some(bounded_stop(2)),
            config: RunnerConfig::default(),
        };
        let mut monitor = HidLatchMonitor::new(MonitorConfig::default());
        run_monitor_loop(deps, &mut monitor).await;
        let statuses = statuses.lock().unwrap();
        assert_eq!(statuses.len(), 2);
        assert!(statuses[0].ok);
        assert_eq!(statuses[0].healthy, Some(true));
        // Second status is from the errored read: ok=false, but healthy retains the
        // LAST successful sample's value (true), not reset to None.
        assert!(!statuses[1].ok);
        assert_eq!(statuses[1].healthy, Some(true));
        assert_eq!(statuses[1].last_error, Some("transient".to_string()));
    }
}
