//! `ScaleLearner`'s own types, constants, and the small pure helpers
//! (`shipped_default`, `clamp_to_band`) that don't need `&self`.

use serde::{Deserialize, Serialize};

use crate::curve_mover::DEFAULT_CURVE_SCALE_Y;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
}

pub(super) fn shipped_default(axis: Axis) -> f64 {
    match axis {
        Axis::X => 1.0,
        Axis::Y => DEFAULT_CURVE_SCALE_Y,
    }
}

/// The 3 experimental control tools index.ts registers ONLY when opted
/// in (#41).
pub const MOVER_SCALE_TOOL_NAMES: [&str; 3] = [
    "pikvm_mover_scale_status",
    "pikvm_mover_scale_control",
    "pikvm_mover_scale_reset",
];

// ── validated constants (scratch/yscale-estimator-sim.ts) ──────────────
/// Measured landing noise per endpoint (georgs n=79).
pub const SIGMA_DETECT_PX: f64 = 5.1;
/// Accept floor; below this σ_i/P is noise not signal.
pub const MIN_PLANNED_PX: f64 = 150.0;
/// Keep the most recent N samples.
pub const WINDOW_MAX: usize = 70;
/// Apply an update only when window SE < 0.5%.
pub const SE_APPLY_THRESHOLD: f64 = 0.005;
/// Reject implied scales outside this range (kills gross FPs).
pub const PREFILTER_LO: f64 = 0.7;
pub const PREFILTER_HI: f64 = 1.4;
/// The applied scale is clamped to ±1% of the SHIPPED DEFAULT (per-axis),
/// not an absolute band. Experimental-safety bound (georg's #41
/// decision): even opted-in, the learner cannot move the mover more than
/// 1% off the hand-measured value. Tighter than the estimator's own
/// noise by design — we trust the shipped default more than the loop.
pub const CLAMP_FRACTION: f64 = 0.01;
/// ≤2% movement per update.
pub const RATE_LIMIT: f64 = 0.02;
/// Require a BALANCED ±direction mix before an update. The implied scale
/// is direction-dependent (measured: up 3.72% vs down 3.14% overshoot),
/// so the window MEDIAN is only an accurate estimate of the
/// compromise-optimum once BOTH directions are represented.
pub const MIN_SAMPLES_PER_DIRECTION: usize = 8;
/// >2% from default → "re-measure/re-bake" warning.
pub const DIVERGENCE_WARN: f64 = 0.02;
/// Sustained constant offset ⇒ detector/pacing fault, not geometry.
pub const INTERCEPT_ALARM_PX: f64 = 10.0;
/// Reject-rate spike ⇒ detector degraded.
pub const REJECT_RATE_ALARM: f64 = 0.5;

/// Clamp a scale to ±`CLAMP_FRACTION` of THIS axis's shipped default.
pub(super) fn clamp_to_band(axis: Axis, v: f64) -> f64 {
    let d = shipped_default(axis);
    v.max(d * (1.0 - CLAMP_FRACTION))
        .min(d * (1.0 + CLAMP_FRACTION))
}

/// Per-move provenance so garbage never trains the scale. A sample is
/// learned ONLY when all of these are false.
#[derive(Debug, Clone, Copy, Default)]
pub struct SampleMeta {
    /// Start came from the M2 faded-cursor wake (jiggled position, not a
    /// clean rest).
    pub woken: bool,
    /// Click was force:true (unverified landing).
    pub forced: bool,
    /// Move was skipped/aborted (gate, brightness, not-landed).
    pub aborted: bool,
    /// Detection confidence below the learn bar.
    pub low_confidence: bool,
    /// This is the correction shot, not the first shot (starts elsewhere
    /// → pollutes).
    pub is_correction_shot: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordOutcome {
    Accepted,
    AcceptedUpdated,
    RejectedHygiene,
    RejectedGate,
    RejectedPrefilter,
    RejectedDisabled,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Sample {
    pub(super) implied: f64,
    pub(super) planned: f64,
    pub(super) sigma: f64,
    pub(super) residual: f64,
    pub(super) sign: f64,
}

pub(super) struct AxisState {
    pub(super) applied: f64,
    pub(super) window: Vec<Sample>,
    pub(super) seen: u64,
    pub(super) accepted: u64,
    pub(super) rejected: u64,
    // Detector-degraded signal: the reject rate AMONG QUALIFIED samples
    // (those that passed hygiene + the ≥150px gate and reached the
    // pre-filter). A sub-floor move (rejected-gate) is EXPECTED normal
    // traffic — on WB pad ~50% of moves are under the floor — so it
    // must NOT count here, or the alarm fires permanently.
    pub(super) recent_qualified: u64,
    pub(super) recent_prefilter_rejects: u64,
    pub(super) last_update: Option<u64>,
}

impl AxisState {
    pub(super) fn fresh(axis: Axis) -> Self {
        Self {
            applied: shipped_default(axis),
            window: Vec::new(),
            seen: 0,
            accepted: 0,
            rejected: 0,
            recent_qualified: 0,
            recent_prefilter_rejects: 0,
            last_update: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowBalance {
    pub up: u64,
    pub down: u64,
}

#[derive(Debug, Clone)]
pub struct AxisStatus {
    pub applied: f64,
    /// Window-median implied scale (UNCLAMPED drift read); `None` until
    /// ≥5 samples.
    pub estimated_scale: Option<f64>,
    pub shipped_default: f64,
    /// (estimate-default)/default — the drift signal, not the clamped
    /// applied value.
    pub divergence_from_default: f64,
    pub seen: u64,
    pub accepted: u64,
    pub rejected: u64,
    pub window_size: usize,
    /// ±direction counts — an update needs ≥8 each.
    pub window_balance: WindowBalance,
    /// 1.25·median(σ_i)/√N, `None` until enough samples.
    pub window_se: Option<f64>,
    pub last_update: Option<u64>,
    /// Residual-vs-planned fit.
    pub slope: Option<f64>,
    pub intercept: Option<f64>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LearnerState {
    Disabled,
    /// Human-readable so a reader can tell DISABLED apart from merely
    /// IDLE — a frozen learner and a learner with nothing to learn from
    /// both sit at warm-start defaults with 0 samples, which otherwise
    /// look identical (it-03400 / georgs, 2026-07-31).
    IdleNoQualifyingSamplesYet,
    Learning,
}

#[derive(Debug, Clone)]
pub struct LearnerStatus {
    /// #41: off-by-default opt-in; does not reliably converge.
    pub experimental: bool,
    /// Opted in via `PIKVM_MOVER_LEARN=1` (else the whole feature is
    /// inert).
    pub feature_enabled: bool,
    /// `feature_enabled` AND not frozen by the control tool.
    pub active: bool,
    pub state: LearnerState,
    pub x: AxisStatus,
    pub y: AxisStatus,
}

#[derive(Default)]
pub struct ScaleLearnerOpts {
    pub now: Option<Box<dyn Fn() -> u64 + Send + Sync>>,
    /// Override the env opt-in (tests). `None` ⇒ the feature is ON only
    /// when the caller-provided env says `PIKVM_MOVER_LEARN=1` (OFF by
    /// default — georg's #41 decision).
    pub enabled: Option<bool>,
}
