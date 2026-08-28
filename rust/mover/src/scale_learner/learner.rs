//! `ScaleLearner` itself: the estimator's runtime state and the
//! `record_sample`/`status`/`load_snapshot`/`snapshot` API surface.

use pikvm_mcp_foundation::util::median;

#[cfg(test)]
use crate::curve_mover::DEFAULT_CURVE_SCALE_Y;

#[cfg(test)]
use super::move_sample::{record_move_sample, MoveLearnSample};
use super::types::{
    clamp_to_band, shipped_default, Axis, AxisState, AxisStatus, LearnerState, LearnerStatus,
    RecordOutcome, Sample, SampleMeta, ScaleLearnerOpts, WindowBalance, DIVERGENCE_WARN,
    INTERCEPT_ALARM_PX, MIN_PLANNED_PX, MIN_SAMPLES_PER_DIRECTION, PREFILTER_HI, PREFILTER_LO,
    RATE_LIMIT, REJECT_RATE_ALARM, SE_APPLY_THRESHOLD, SIGMA_DETECT_PX, WINDOW_MAX,
};

/// Least-squares slope+intercept of residual (achieved−planned) vs
/// planned, over the window — the geometry-drift (slope) vs
/// detector-fault (intercept) discriminator.
fn fit_residual(win: &[Sample]) -> Option<(f64, f64)> {
    if win.len() < 5 {
        return None;
    }
    let n = win.len() as f64;
    let (mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0);
    for s in win {
        sx += s.planned;
        sy += s.residual;
        sxx += s.planned * s.planned;
        sxy += s.planned * s.residual;
    }
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-9 {
        return None;
    }
    let slope = (n * sxy - sx * sy) / denom;
    let intercept = (sy - slope * sx) / n;
    Some((slope, intercept))
}

pub struct ScaleLearner {
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    // OPT-IN gate (immutable per instance): the experimental feature is
    // OFF unless the caller opted in. When false the learner is inert
    // AND index.ts does not register the 3 pikvm_mover_scale_* tools —
    // a true no-op.
    env_enabled: bool,
    // Runtime freeze via the control tool (only meaningful when opted in).
    enabled_flag: bool,
    // An applied scale changed since the last persist.
    dirty: bool,
    x: AxisState,
    y: AxisState,
}

impl ScaleLearner {
    /// `env_learn_1`: the caller-resolved `PIKVM_MOVER_LEARN == "1"`
    /// check, used only when `opts.enabled` is `None`. Faithful port of
    /// the TS constructor reading `process.env.PIKVM_MOVER_LEARN`
    /// directly — this crate takes it as a parameter instead (same DI
    /// discipline as the rest of this port; `foundation`'s settings.rs
    /// owns real env access).
    pub fn new(opts: ScaleLearnerOpts, env_learn_1: bool) -> Self {
        Self {
            now: opts.now.unwrap_or_else(|| Box::new(now_ms)),
            env_enabled: opts.enabled.unwrap_or(env_learn_1),
            enabled_flag: true,
            dirty: false,
            x: AxisState::fresh(Axis::X),
            y: AxisState::fresh(Axis::Y),
        }
    }

    fn axis(&self, axis: Axis) -> &AxisState {
        match axis {
            Axis::X => &self.x,
            Axis::Y => &self.y,
        }
    }

    fn axis_mut(&mut self, axis: Axis) -> &mut AxisState {
        match axis {
            Axis::X => &mut self.x,
            Axis::Y => &mut self.y,
        }
    }

    /// Is the learner adapting? True only when opted in (env) AND not
    /// frozen by the tool.
    pub fn is_active(&self) -> bool {
        self.env_enabled && self.enabled_flag
    }

    /// Did the process opt into the experimental feature
    /// (`PIKVM_MOVER_LEARN=1`)? index.ts gates registration of the 3
    /// `pikvm_mover_scale_*` tools on this — off ⇒ they vanish.
    pub fn is_feature_enabled(&self) -> bool {
        self.env_enabled
    }

    /// The scale the mover should apply for this axis right now. Always
    /// defined, warm-started from the shipped default, never outside the
    /// clamp.
    pub fn current_scale(&self, axis: Axis) -> f64 {
        self.axis(axis).applied
    }

    /// Record one first-shot move sample. Returns the outcome (for
    /// status/tests). Hygiene → gate(|planned|≥150) → implied →
    /// pre-filter → window → SE-gated update.
    pub fn record_sample(
        &mut self,
        axis: Axis,
        planned: f64,
        achieved: f64,
        s_applied: f64,
        meta: SampleMeta,
    ) -> RecordOutcome {
        // The kill-switch/disable FREEZES: we don't even count samples
        // we won't learn from, so status counters reflect real learning
        // traffic, not frozen no-ops.
        if !self.is_active() {
            return RecordOutcome::RejectedDisabled;
        }
        let now = (self.now)();
        self.axis_mut(axis).seen += 1;

        // Hygiene + the distance gate reject BEFORE the sample is
        // "qualified": these are expected traffic, NOT a
        // detector-degraded signal, so they only bump `rejected`.
        if meta.woken
            || meta.forced
            || meta.aborted
            || meta.low_confidence
            || meta.is_correction_shot
            || !planned.is_finite()
            || !achieved.is_finite()
            || planned.abs() < 1.0
        {
            self.axis_mut(axis).rejected += 1;
            return RecordOutcome::RejectedHygiene;
        }
        if planned.abs() < MIN_PLANNED_PX {
            self.axis_mut(axis).rejected += 1;
            return RecordOutcome::RejectedGate;
        }

        // A QUALIFIED sample (passed hygiene + gate, reached the
        // pre-filter). Only here on does a rejection signal a lying
        // detector (a ≥150px move whose implied scale is physically
        // impossible = a gross V8 false-positive).
        self.axis_mut(axis).recent_qualified += 1;
        let implied = s_applied * (achieved / planned);
        if !(PREFILTER_LO..=PREFILTER_HI).contains(&implied) {
            let s = self.axis_mut(axis);
            s.rejected += 1;
            s.recent_prefilter_rejects += 1;
            Self::decay_recent(s);
            return RecordOutcome::RejectedPrefilter;
        }

        {
            let s = self.axis_mut(axis);
            s.accepted += 1;
            Self::decay_recent(s);
        }
        let sigma = (SIGMA_DETECT_PX * std::f64::consts::SQRT_2) / planned.abs();
        // DIRECTION-NORMALISED residual: real traffic clusters at ±P
        // (moves go back and forth), so a signed residual-vs-signed-
        // planned fit is degenerate — direction asymmetry (down 3.14%
        // vs up 3.72%) leaks into slope, noise into intercept. We store
        // the along-travel overshoot (residual · sign(planned)) against
        // |planned|, collapsing both clusters onto one line: a true
        // SCALE error is the slope, a true constant OFFSET is the
        // intercept, and up/down asymmetry becomes spread — not a false
        // intercept.
        let sign = planned.signum();
        let along_travel_residual = (achieved - planned) * sign;
        {
            let s = self.axis_mut(axis);
            s.window.push(Sample {
                implied,
                planned: planned.abs(),
                sigma,
                residual: along_travel_residual,
                sign,
            });
            if s.window.len() > WINDOW_MAX {
                s.window.remove(0);
            }
        }

        // Update only when the estimate is precise enough (SE gate) AND
        // the window is representative (a balanced ±direction mix). The
        // TARGET is the window MEDIAN of the implied scale — the STABLE
        // estimator. We deliberately do NOT use the (unbiased)
        // regression slope: on the real rig each axis sees only two
        // distinct |planned| values, so the two-cluster slope is noisy
        // and the rate cap (which caps, not averages) turns that noise
        // into ±2-3% applied-value wander — measured worse than the
        // median's ~1% bias. Biased-but-stable beats unbiased-but-noisy
        // for an opt-in. The ±1% clamp bounds the median's residual
        // bias so it cannot materially hurt.
        let se = self.window_se(axis);
        if let Some(se) = se {
            if se < SE_APPLY_THRESHOLD && self.direction_balanced(axis) {
                let s = self.axis_mut(axis);
                let target = clamp_to_band(
                    axis,
                    median(&s.window.iter().map(|w| w.implied).collect::<Vec<_>>()),
                );
                let step =
                    (-RATE_LIMIT * s.applied).max((RATE_LIMIT * s.applied).min(target - s.applied));
                if step != 0.0 {
                    s.applied += step;
                    s.last_update = Some(now);
                    self.dirty = true;
                    return RecordOutcome::AcceptedUpdated;
                }
            }
        }
        RecordOutcome::Accepted
    }

    fn decay_recent(s: &mut AxisState) {
        // rolling decay on the qualified-sample reject-rate signal so a
        // burst shows, then fades.
        if s.recent_qualified > WINDOW_MAX as u64 {
            s.recent_qualified = (s.recent_qualified as f64 * 0.7).round() as u64;
            s.recent_prefilter_rejects = (s.recent_prefilter_rejects as f64 * 0.7).round() as u64;
        }
    }

    /// Both directions represented ≥ `MIN_SAMPLES_PER_DIRECTION` — the
    /// window is a fair sample of the direction-dependent implied scale,
    /// so its median isn't skewed.
    fn direction_balanced(&self, axis: Axis) -> bool {
        let s = self.axis(axis);
        let up = s.window.iter().filter(|w| w.sign > 0.0).count();
        up.min(s.window.len() - up) >= MIN_SAMPLES_PER_DIRECTION
    }

    fn window_se(&self, axis: Axis) -> Option<f64> {
        let s = self.axis(axis);
        let n = s.window.len();
        if n < 5 {
            return None;
        }
        Some(
            (1.25 * median(&s.window.iter().map(|w| w.sigma).collect::<Vec<_>>()))
                / (n as f64).sqrt(),
        )
    }

    fn axis_status(&self, axis: Axis) -> AxisStatus {
        let s = self.axis(axis);
        let fit = fit_residual(&s.window);
        // The drift signal is the UNCLAMPED estimate vs the default, NOT
        // the applied value: applied is bounded to ±1% by the clamp, so
        // a divergence read off `applied` could never report a drift
        // bigger than the clamp — it would silence the very
        // "re-measure" signal this warning exists for. The window
        // median (the estimator we ship) is the honest read of where
        // the true scale sits.
        let estimate = if s.window.len() >= 5 {
            Some(median(
                &s.window.iter().map(|w| w.implied).collect::<Vec<_>>(),
            ))
        } else {
            None
        };
        let default = shipped_default(axis);
        let divergence = (estimate.unwrap_or(s.applied) - default) / default;
        let mut warnings = Vec::new();
        if let Some((slope, intercept)) = fit {
            let _ = slope;
            if intercept.abs() > INTERCEPT_ALARM_PX {
                warnings.push(format!(
                    "constant {intercept:.1}px landing offset (NOT a scale drift) — detector/pacing fault, re-check the detector"
                ));
            }
        }
        if s.recent_qualified >= 10
            && (s.recent_prefilter_rejects as f64 / s.recent_qualified as f64) > REJECT_RATE_ALARM
        {
            let pct = s.recent_prefilter_rejects as f64 / s.recent_qualified as f64 * 100.0;
            warnings.push(format!(
                "{pct:.0}% of QUALIFIED (≥150px) moves rejected as physically-impossible — detector likely degraded"
            ));
        }
        if divergence.abs() > DIVERGENCE_WARN {
            let axis_letter = match axis {
                Axis::X => "X",
                Axis::Y => "Y",
            };
            warnings.push(format!(
                "estimated scale {:.1}% from shipped default — consider re-measuring + re-baking DEFAULT_CURVE_SCALE_{axis_letter}",
                divergence * 100.0
            ));
        }
        let up = s.window.iter().filter(|w| w.sign > 0.0).count() as u64;
        let down = s.window.iter().filter(|w| w.sign < 0.0).count() as u64;
        AxisStatus {
            applied: s.applied,
            estimated_scale: estimate,
            shipped_default: default,
            divergence_from_default: divergence,
            seen: s.seen,
            accepted: s.accepted,
            rejected: s.rejected,
            window_size: s.window.len(),
            window_balance: WindowBalance { up, down },
            window_se: self.window_se(axis),
            last_update: s.last_update,
            slope: fit.map(|f| f.0),
            intercept: fit.map(|f| f.1),
            warnings,
        }
    }

    pub fn status(&self) -> LearnerStatus {
        let state = if !self.is_active() {
            LearnerState::Disabled
        } else if self.x.accepted + self.y.accepted == 0 {
            LearnerState::IdleNoQualifyingSamplesYet
        } else {
            LearnerState::Learning
        };
        LearnerStatus {
            experimental: true,
            feature_enabled: self.env_enabled,
            active: self.is_active(),
            state,
            x: self.axis_status(Axis::X),
            y: self.axis_status(Axis::Y),
        }
    }

    /// Freeze at the current value: stop adapting AND stop persisting
    /// (the persistence layer checks `is_active()`). Does NOT revert the
    /// applied scale.
    pub fn disable(&mut self) {
        self.enabled_flag = false;
    }

    pub fn enable(&mut self) {
        self.enabled_flag = true;
    }

    /// True and CLEARED when an applied scale changed since the last
    /// persist — the periodic flush uses this so it only writes when
    /// there's something to write (never per-move). disable()d/
    /// kill-switched learners are never dirty.
    pub fn consume_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// Clear learned state and revert to shipped defaults. The
    /// persistence layer, on seeing a reset, DELETES the file (not just
    /// zeroes memory).
    pub fn reset(&mut self) {
        self.x = AxisState::fresh(Axis::X);
        self.y = AxisState::fresh(Axis::Y);
        self.dirty = false;
    }

    /// Restore ONLY the learned applied scale (clamped, so a corrupt
    /// file can't inject an out-of-band value) + when it was last
    /// learned. Counters (seen/accepted/rejected) are deliberately
    /// SESSION-SCOPED — persisting a cumulative `accepted` alongside a
    /// session-zero `seen` made the status readout report
    /// accepted>seen, and "samples this session" is the more useful
    /// diagnostic than a cumulative count with no consumer (georgs,
    /// 2026-07-31). So a fresh process always starts the counters at 0,
    /// consistent with each other.
    pub fn load_snapshot(&mut self, x: Option<(f64, Option<u64>)>, y: Option<(f64, Option<u64>)>) {
        for (axis, v) in [(Axis::X, x), (Axis::Y, y)] {
            if let Some((applied, last_update)) = v {
                if applied.is_finite() {
                    let s = self.axis_mut(axis);
                    s.applied = clamp_to_band(axis, applied);
                    if let Some(lu) = last_update {
                        s.last_update = Some(lu);
                    }
                }
            }
        }
    }

    /// The snapshot to persist: only the learned scale + when it was
    /// learned. NOT the counters (see `load_snapshot`).
    pub fn snapshot(&self) -> ((f64, Option<u64>), (f64, Option<u64>)) {
        (
            (self.x.applied, self.x.last_update),
            (self.y.applied, self.y.last_update),
        )
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn learner_enabled() -> ScaleLearner {
        ScaleLearner::new(
            ScaleLearnerOpts {
                enabled: Some(true),
                ..Default::default()
            },
            false,
        )
    }

    fn learner_enabled_at(now: u64) -> ScaleLearner {
        ScaleLearner::new(
            ScaleLearnerOpts {
                enabled: Some(true),
                now: Some(Box::new(move || now)),
            },
            false,
        )
    }

    /// Feed N clean long-move samples on axis y that imply a target scale,
    /// ALTERNATING ±direction so the balance gate (≥8/direction) is
    /// satisfied. implied = sApplied·(achieved/planned) = target ⇒
    /// achieved = planned · target / sApplied (sign of planned carries
    /// through). Use n≥16 for the first update to fire.
    fn feed(l: &mut ScaleLearner, target: f64, n: u32) -> RecordOutcome {
        let p = 800.0;
        let mut last = RecordOutcome::Accepted;
        for i in 0..n {
            let s_applied = l.current_scale(Axis::Y);
            let planned = if i % 2 == 0 { p } else { -p };
            let achieved = planned * (target / s_applied);
            last = l.record_sample(Axis::Y, planned, achieved, s_applied, SampleMeta::default());
        }
        last
    }

    mod warm_start_and_hygiene {
        use super::*;

        #[test]
        fn warm_starts_from_the_shipped_defaults_never_from_1_0_cold() {
            let l = learner_enabled();
            assert_eq!(l.current_scale(Axis::Y), DEFAULT_CURVE_SCALE_Y);
            assert_eq!(l.current_scale(Axis::X), 1.0);
        }

        #[test]
        fn rejects_garbage_samples_before_they_can_move_the_scale() {
            let mut l = learner_enabled();
            for meta in [
                SampleMeta {
                    woken: true,
                    ..Default::default()
                },
                SampleMeta {
                    forced: true,
                    ..Default::default()
                },
                SampleMeta {
                    aborted: true,
                    ..Default::default()
                },
                SampleMeta {
                    low_confidence: true,
                    ..Default::default()
                },
                SampleMeta {
                    is_correction_shot: true,
                    ..Default::default()
                },
            ] {
                assert_eq!(
                    l.record_sample(Axis::Y, 800.0, 900.0, 1.0364, meta),
                    RecordOutcome::RejectedHygiene
                );
            }
            assert_eq!(
                l.record_sample(Axis::Y, 800.0, f64::NAN, 1.0364, SampleMeta::default()),
                RecordOutcome::RejectedHygiene
            );
            assert_eq!(l.status().y.window_size, 0);
            assert_eq!(l.current_scale(Axis::Y), DEFAULT_CURVE_SCALE_Y);
        }

        #[test]
        fn gates_out_short_moves_below_150px() {
            let mut l = learner_enabled();
            assert_eq!(
                l.record_sample(Axis::Y, 120.0, 130.0, 1.0364, SampleMeta::default()),
                RecordOutcome::RejectedGate
            );
            assert_eq!(l.status().y.window_size, 0);
        }

        #[test]
        fn pre_filters_implied_scales_outside_0_7_1_4() {
            let mut l = learner_enabled();
            // an FP: achieved wildly off ⇒ implied ~2 ⇒ rejected
            assert_eq!(
                l.record_sample(Axis::Y, 800.0, 1600.0, 1.0364, SampleMeta::default()),
                RecordOutcome::RejectedPrefilter
            );
            assert_eq!(l.status().y.window_size, 0);
        }
    }

    mod estimator_and_guards {
        use super::*;

        #[test]
        fn adapts_toward_the_windowed_median_implied_scale_once_the_se_gate_clears() {
            let mut l = learner_enabled_at(1000);
            feed(&mut l, 1.045, 20); // clean P=800 samples imply 1.045 — within the ±1% clamp band + one rate step of default
            assert!((l.current_scale(Axis::Y) - 1.045).abs() < 1e-3);
            assert_eq!(l.status().y.last_update, Some(1000));
        }

        #[test]
        fn does_not_update_until_the_window_se_below_0_5_percent() {
            let mut l = learner_enabled();
            // 3 samples: n<5 ⇒ SE null ⇒ no update
            for _ in 0..3 {
                let s = l.current_scale(Axis::Y);
                l.record_sample(Axis::Y, 800.0, 800.0 * (1.05 / s), s, SampleMeta::default());
            }
            assert_eq!(l.current_scale(Axis::Y), DEFAULT_CURVE_SCALE_Y);
            assert_eq!(l.status().y.window_se, None);
        }

        #[test]
        fn rate_limits_each_update_to_at_most_2_percent_of_the_current_scale() {
            let mut l = learner_enabled();
            let before = l.current_scale(Axis::Y);
            feed(&mut l, 1.15, 16);
            let after = l.current_scale(Axis::Y);
            assert!((after - before) / before <= 0.0201);
            assert!(after > before); // moved the right direction
        }

        #[test]
        fn clamps_the_applied_scale_to_1_percent_of_the_shipped_default() {
            let hi = DEFAULT_CURVE_SCALE_Y * 1.01;
            let lo = DEFAULT_CURVE_SCALE_Y * 0.99;
            let mut up = learner_enabled();
            feed(&mut up, 1.30, 400); // imply 1.30 forever; the rate-limited climb must stop at +1%
            assert!(up.current_scale(Axis::Y) <= hi + 1e-9);
            assert!((up.current_scale(Axis::Y) - hi).abs() < 1e-5);
            let mut down = learner_enabled();
            feed(&mut down, 0.80, 400); // imply 0.80 forever; the descent must stop at −1%
            assert!(down.current_scale(Axis::Y) >= lo - 1e-9);
            assert!((down.current_scale(Axis::Y) - lo).abs() < 1e-5);
        }

        #[test]
        fn uses_the_median_so_a_minority_of_borderline_samples_does_not_drag_it() {
            let mut l = learner_enabled();
            let mut push = |target: f64, i: u32| {
                let p = if i.is_multiple_of(2) { 800.0 } else { -800.0 };
                let s = l.current_scale(Axis::Y);
                l.record_sample(Axis::Y, p, p * (target / s), s, SampleMeta::default());
            };
            for i in 0..16 {
                push(1.03, i); // balanced majority → median ~1.03
            }
            for i in 0..4 {
                push(1.39, i); // balanced minority (inside prefilter)
            }
            assert!(l.current_scale(Axis::Y) < 1.06); // median-driven, not dragged toward the 1.39s
        }

        #[test]
        fn balance_gate_a_direction_skewed_window_does_not_update_even_with_low_se() {
            let mut l = learner_enabled();
            // 20 samples ALL in one direction imply 1.045 with a tiny SE — but
            // the median of a one-sided window is biased (implied is
            // direction-dependent), so no update fires.
            for _ in 0..20 {
                let s = l.current_scale(Axis::Y);
                l.record_sample(
                    Axis::Y,
                    800.0,
                    800.0 * (1.045 / s),
                    s,
                    SampleMeta::default(),
                );
            }
            assert_eq!(l.current_scale(Axis::Y), DEFAULT_CURVE_SCALE_Y); // frozen — window unbalanced
            assert!(l.status().y.window_se.unwrap() < 0.005); // SE alone WOULD have passed
            assert_eq!(
                l.status().y.window_balance,
                WindowBalance { up: 20, down: 0 }
            );
            // now add the other direction — once ≥8 each, the update fires.
            for _ in 0..10 {
                let s = l.current_scale(Axis::Y);
                l.record_sample(
                    Axis::Y,
                    -800.0,
                    -800.0 * (1.045 / s),
                    s,
                    SampleMeta::default(),
                );
            }
            assert!((l.current_scale(Axis::Y) - 1.045).abs() < 1e-2);
        }

        #[test]
        fn ships_the_stable_median_clamped_1_percent_two_cluster_offset_stays_bounded() {
            let mut l = learner_enabled();
            // The rig's REAL profile: only two |planned| per axis (888, 444),
            // both signs, plus a constant −5px offset — the exact conditions
            // under which the (unbiased) regression slope wandered ±2-3% on
            // hardware. The median we ship instead stays pinned inside the
            // ±1% clamp and does not wander.
            let (s_true, c) = (1.031, -5.0);
            let lo = DEFAULT_CURVE_SCALE_Y * 0.99;
            let hi = DEFAULT_CURVE_SCALE_Y * 1.01;
            let mut trace = Vec::new();
            for _round in 0..20 {
                for dist in [888.0, 444.0] {
                    for sign in [1.0, -1.0] {
                        let s = l.current_scale(Axis::Y);
                        l.record_sample(
                            Axis::Y,
                            sign * dist,
                            sign * (dist * (s_true / s) + c),
                            s,
                            SampleMeta::default(),
                        );
                    }
                }
                trace.push(l.current_scale(Axis::Y));
            }
            for v in &trace {
                assert!(*v >= lo - 1e-9);
                assert!(*v <= hi + 1e-9);
            }
            let tail = &trace[10..]; // STABLE: no ±2-3% wander
            let max = tail.iter().cloned().fold(f64::MIN, f64::max);
            let min = tail.iter().cloned().fold(f64::MAX, f64::min);
            assert!(max - min < 0.01);
            // and the drift DETECTION still reads the true offset-biased estimate (the reliable half)
            assert!(l.status().y.estimated_scale.is_some());
        }
    }

    mod controls_and_persistence {
        use super::*;

        #[test]
        fn disable_freezes_rejects_samples_keeps_current_value_enable_resumes() {
            let mut l = learner_enabled();
            feed(&mut l, 1.05, 20);
            let frozen = l.current_scale(Axis::Y);
            l.disable();
            assert_eq!(
                l.record_sample(
                    Axis::Y,
                    800.0,
                    900.0,
                    l.current_scale(Axis::Y),
                    SampleMeta::default()
                ),
                RecordOutcome::RejectedDisabled
            );
            assert_eq!(l.current_scale(Axis::Y), frozen); // unchanged
            assert!(!l.status().active);
            l.enable();
            assert!(l.status().active);
        }

        #[test]
        fn status_distinguishes_disabled_from_idle() {
            let mut idle = learner_enabled();
            assert_eq!(
                idle.status().state,
                LearnerState::IdleNoQualifyingSamplesYet
            ); // opted in, nothing learned yet
            feed(&mut idle, 1.045, 20);
            assert_eq!(idle.status().state, LearnerState::Learning);
            idle.disable();
            assert_eq!(idle.status().state, LearnerState::Disabled); // frozen ≠ idle

            let off = ScaleLearner::new(
                ScaleLearnerOpts {
                    enabled: Some(false),
                    ..Default::default()
                },
                false,
            );
            assert_eq!(off.status().state, LearnerState::Disabled); // not opted in
        }

        #[test]
        fn reset_reverts_to_the_shipped_defaults_and_clears_the_window() {
            let mut l = learner_enabled();
            feed(&mut l, 1.05, 20);
            assert_ne!(l.current_scale(Axis::Y), DEFAULT_CURVE_SCALE_Y);
            l.reset();
            assert_eq!(l.current_scale(Axis::Y), DEFAULT_CURVE_SCALE_Y);
            assert_eq!(l.status().y.window_size, 0);
            assert_eq!(l.status().y.accepted, 0);
        }

        #[test]
        fn off_by_default_not_opted_in_inert_true_no_op() {
            let mut l = ScaleLearner::new(
                ScaleLearnerOpts {
                    enabled: Some(false),
                    ..Default::default()
                },
                false,
            );
            assert!(!l.is_active());
            assert!(!l.is_feature_enabled());
            assert_eq!(
                l.record_sample(Axis::Y, 800.0, 900.0, 1.0364, SampleMeta::default()),
                RecordOutcome::RejectedDisabled
            );
            assert_eq!(l.current_scale(Axis::Y), DEFAULT_CURVE_SCALE_Y); // true no-op — static default
            let status = l.status();
            assert!(!status.feature_enabled);
            assert!(!status.active);
            assert!(status.experimental);
        }

        #[test]
        fn reads_the_opt_in_from_the_caller_supplied_env_flag_when_no_explicit_opts_enabled() {
            assert!(ScaleLearner::new(ScaleLearnerOpts::default(), true).is_feature_enabled());
            assert!(!ScaleLearner::new(ScaleLearnerOpts::default(), false).is_feature_enabled()); // default OFF
                                                                                                  // an explicit opts.enabled always wins over the env flag
            assert!(!ScaleLearner::new(
                ScaleLearnerOpts {
                    enabled: Some(false),
                    ..Default::default()
                },
                true
            )
            .is_feature_enabled());
        }

        #[test]
        fn load_snapshot_clamps_an_out_of_band_persisted_value_snapshot_round_trips() {
            let mut l = learner_enabled();
            l.load_snapshot(None, Some((9.9, Some(5)))); // corrupt/huge
            assert!(l.current_scale(Axis::Y) <= DEFAULT_CURVE_SCALE_Y * 1.01 + 1e-9); // clamped to +1%, not injected

            let mut l2 = learner_enabled();
            l2.load_snapshot(None, Some((1.031, Some(5))));
            assert!((l2.current_scale(Axis::Y) - 1.031).abs() < 1e-5);
            assert!((l2.snapshot().1 .0 - 1.031).abs() < 1e-5);
        }

        #[test]
        fn counters_are_session_scoped_after_a_load() {
            let mut l = learner_enabled();
            // a restore only sets the learned scale — NOT a cumulative
            // accepted alongside a session-zero seen.
            l.load_snapshot(Some((1.0, Some(5))), Some((1.031, Some(9))));
            for axis in [Axis::X, Axis::Y] {
                let s = self_status_for(&l, axis);
                assert_eq!(s.seen, 0);
                assert_eq!(s.accepted, 0);
                assert_eq!(s.rejected, 0);
                assert!(s.accepted + s.rejected <= s.seen); // invariant, always
            }
            // and it holds after real traffic too
            for _ in 0..10 {
                let s = l.current_scale(Axis::Y);
                l.record_sample(Axis::Y, 800.0, 820.0, s, SampleMeta::default());
            }
            for _ in 0..5 {
                l.record_sample(Axis::Y, 80.0, 82.0, 1.0, SampleMeta::default());
                // sub-floor rejects
            }
            let y = l.status().y;
            assert!(y.accepted + y.rejected <= y.seen);
        }

        fn self_status_for(l: &ScaleLearner, axis: Axis) -> AxisStatus {
            match axis {
                Axis::X => l.status().x,
                Axis::Y => l.status().y,
            }
        }
    }

    mod fault_discrimination {
        use super::*;

        #[test]
        fn warns_on_a_sustained_constant_landing_intercept() {
            let mut l = learner_enabled();
            // achieved = planned + 20px CONSTANT offset (distance-independent) across varied P
            for p in [200.0, 300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 850.0] {
                let s = l.current_scale(Axis::Y);
                l.record_sample(Axis::Y, p, p + 20.0, s, SampleMeta::default());
            }
            let status = l.status();
            let warnings = status.y.warnings.join(" ");
            assert!(
                warnings.to_lowercase().contains("constant")
                    && warnings.to_lowercase().contains("detector")
            );
            assert!(status.y.intercept.unwrap() > 10.0);
        }

        #[test]
        fn warns_when_the_estimate_diverges_beyond_2_percent_from_the_shipped_default() {
            let mut l = learner_enabled();
            feed(&mut l, 1.13, 400); // applied is clamped to +1%, but the UNCLAMPED estimate (~1.13) drives the warning
            let status = l.status();
            assert!(status
                .y
                .warnings
                .join(" ")
                .to_lowercase()
                .contains("from shipped default"));
            assert!((status.y.estimated_scale.unwrap() - 1.13).abs() < 1e-2);
        }

        #[test]
        fn defect_a_regression_sub_150px_moves_do_not_trigger_the_detector_alarm() {
            let mut l = learner_enabled();
            for _ in 0..20 {
                l.record_sample(Axis::X, 80.0, 82.0, 1.0, SampleMeta::default());
                // all below the floor = normal traffic
            }
            let status = l.status();
            assert!(!status
                .x
                .warnings
                .join(" ")
                .to_lowercase()
                .contains("detector"));
            assert_eq!(status.x.rejected, 20);
        }

        #[test]
        fn a_high_prefilter_reject_rate_among_qualified_moves_flags_a_degraded_detector() {
            let mut l = learner_enabled();
            for _ in 0..12 {
                l.record_sample(Axis::X, 800.0, 1600.0, 1.0, SampleMeta::default());
                // implied ~2 → prefilter reject
            }
            for _ in 0..3 {
                l.record_sample(Axis::X, 800.0, 800.0, 1.0, SampleMeta::default());
                // clean
            }
            let status = l.status();
            assert!(status
                .x
                .warnings
                .join(" ")
                .to_lowercase()
                .contains("detector likely degraded"));
        }

        #[test]
        fn defect_b_regression_direction_asymmetry_does_not_masquerade_as_an_intercept_alarm() {
            let mut l = learner_enabled();
            // up-moves overshoot 3.72%, down-moves 3.14% (the real #39
            // asymmetry), NO detector fault.
            for d in [300.0, 500.0, 700.0, 800.0, 850.0] {
                l.record_sample(Axis::Y, d, d * 1.0372, 1.0, SampleMeta::default()); // up: +3.72%
                l.record_sample(Axis::Y, -d, -d * 1.0314, 1.0, SampleMeta::default());
                // down: +3.14% overshoot in the −direction
            }
            let status = l.status();
            assert!(status.y.intercept.unwrap_or(0.0).abs() < 10.0); // asymmetry ≠ a false intercept
            let warnings = status.y.warnings.join(" ").to_lowercase();
            assert!(!warnings.contains("detector") && !warnings.contains("offset"));
        }

        #[test]
        fn a_clean_scale_drift_pure_slope_does_not_raise_the_detector_fault_alarm() {
            let mut l = learner_enabled();
            // consistent multiplicative overshoot (achieved = 1.01·planned),
            // no constant offset ⇒ residual = 0.01·P is pure SLOPE, intercept ≈ 0.
            for p in [200.0, 300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 850.0] {
                let s = l.current_scale(Axis::Y);
                l.record_sample(Axis::Y, p, p * 1.01, s, SampleMeta::default());
            }
            let status = l.status();
            assert!(!status
                .y
                .warnings
                .join(" ")
                .to_lowercase()
                .contains("detector"));
        }
    }

    /// F2 (Round 2 Phase 2): `record_move_sample` was previously
    /// duplicated verbatim in index.ts's move_to handler and
    /// click-at.ts's clickAt(), both reaching directly into the
    /// module-singleton `scaleLearner`. Consolidated here, taking the
    /// learner as a param — these tests exercise it standalone against a
    /// real ScaleLearner instance. No spy framework in Rust, so
    /// call-argument threading is verified via OBSERVABLE effects
    /// (resulting learner state) instead of a mock's recorded call args.
    mod record_move_sample_tests {
        use super::*;

        #[test]
        fn none_learn_sample_is_a_no_op() {
            let mut l = learner_enabled();
            record_move_sample(&mut l, None, 10.0, 20.0, false);
            let status = l.status();
            assert_eq!(status.x.seen, 0);
            assert_eq!(status.y.seen, 0);
        }

        #[test]
        fn populated_learn_sample_updates_both_axes_with_the_right_planned_achieved_applied() {
            let mut l = learner_enabled();
            let learn_sample = MoveLearnSample {
                planned_x: 800.0,
                planned_y: -500.0,
                achieved_x: 820.0,
                achieved_y: -480.0,
                woken: true,
            };
            record_move_sample(&mut l, Some(learn_sample), 1.05, 0.98, true);
            let status = l.status();
            // woken:true → hygiene-rejected on BOTH axes (never reaches the window).
            assert_eq!(status.x.seen, 1);
            assert_eq!(status.y.seen, 1);
            assert_eq!(status.x.window_size, 0);
            assert_eq!(status.y.window_size, 0);
            assert_eq!(status.x.rejected, 1);
            assert_eq!(status.y.rejected, 1);
        }

        #[test]
        fn woken_false_forced_false_are_threaded_through_as_literal_false_not_dropped() {
            let mut l = learner_enabled();
            let learn_sample = MoveLearnSample {
                planned_x: 300.0,
                planned_y: 300.0,
                achieved_x: 300.0,
                achieved_y: 300.0,
                woken: false,
            };
            record_move_sample(&mut l, Some(learn_sample), 1.0, 1.0, false);
            let status = l.status();
            // woken:false, forced:false, planned=300≥150 ⇒ a QUALIFIED sample on both axes.
            assert_eq!(status.x.seen, 1);
            assert_eq!(status.y.seen, 1);
            assert_eq!(status.x.window_size, 1);
            assert_eq!(status.y.window_size, 1);
        }
    }
}
