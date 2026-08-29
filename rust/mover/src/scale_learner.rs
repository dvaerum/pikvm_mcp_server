//! Passive continuous curve-scale learner (task #41).
//!
//! Every real first-shot move yields a FREE per-axis sample from the
//! detector the mover already runs: planned P (target−start) vs achieved
//! A (landed−start). The implied scale is `s = sApplied × (A / P)` (an
//! overshoot A>P needs a LARGER scale, because scale DIVIDES the
//! requested distance in `planAxisEmits`). Real moves are paced bursts,
//! so samples sit in the correct velocity regime by construction — the
//! isolated-ratio trap (phase-0) cannot occur here. The learner
//! accumulates these and adapts curveScaleX/Y gradually, warm-started
//! from the shipped defaults.
//!
//! Estimator + guard parameters are validated in
//! `scratch/yscale-estimator-sim.ts`. Design signed off by georg
//! 2026-07-31. `maxResidualPx` and the mover's own math are untouched;
//! this only chooses the per-axis scale the mover applies.
//!
//! ⚠️ EXPERIMENTAL, OFF BY DEFAULT (georg's #41 decision, 2026-07-31). On
//! the real iPad rig the auto-adaptation did NOT beat a one-time human
//! measurement: the median estimator is ~1% biased low (a constant
//! along-travel offset c biases implied=s+c/P), and the unbiased
//! regression-slope estimator WANDERS ±2-3% because the rig's traffic
//! gives each axis only two distinct |planned| values, so the
//! two-cluster slope is noisy and the rate cap converts that noise
//! directly into applied-value wander (it caps, it does not average).
//! So we ship the STABLE median, tightly CLAMPED to ±1% of the shipped
//! default so even when enabled it cannot materially hurt — but the
//! feature is OPT-IN only (`PIKVM_MOVER_LEARN=1`). When off (the
//! default) the learner is inert, the 3 `pikvm_mover_scale_*` tools are
//! not registered, and the mover uses the static shipped
//! `DEFAULT_CURVE_SCALE_Y` exactly as before — a true no-op. The drift
//! DETECTION (divergence / detector-fault warnings) is the more reliable
//! half; it ships coupled to the feature (also off by default). The two
//! changes that WOULD make adaptation converge — an EMA/damping on the
//! applied value, and a distance-diversity gate so a two-cluster window
//! can't drive a fit — are the documented path IF anyone revisits it.
//!
//! The whole thing is a fail-safe: unwritable state → learn in-memory;
//! not opted in, or disabled mid-session (MCP tool) → freeze at the
//! shipped default; any garbage sample (faded-cursor-wake start, forced
//! click, abort, low-confidence detection, correction shot) → rejected
//! before it can move the scale.
//!
//! Faithful port of `src/pikvm/scale-learner.ts`.
//!
//! Split into `types` (the estimator's own data + constants),
//! `learner` (the `ScaleLearner` state machine + its tests), and
//! `move_sample` (`record_move_sample`, re-exporting `move_to`'s
//! `MoveLearnSample` rather than duplicating it) — idiomatic Rust 2018+
//! module layout, one responsibility per file, rather than one file
//! mirroring the single TS source.

mod learner;
mod move_sample;
mod types;

pub use learner::ScaleLearner;
pub use move_sample::{record_move_sample, MoveLearnSample};
pub use types::{
    Axis, AxisStatus, LearnerState, LearnerStatus, RecordOutcome, SampleMeta, ScaleLearnerOpts,
    WindowBalance, CLAMP_FRACTION, DIVERGENCE_WARN, INTERCEPT_ALARM_PX, MIN_PLANNED_PX,
    MIN_SAMPLES_PER_DIRECTION, MOVER_SCALE_TOOL_NAMES, PREFILTER_HI, PREFILTER_LO, RATE_LIMIT,
    REJECT_RATE_ALARM, SE_APPLY_THRESHOLD, SIGMA_DETECT_PX, WINDOW_MAX,
};
