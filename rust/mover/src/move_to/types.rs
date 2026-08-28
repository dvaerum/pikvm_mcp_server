//! `move_to`'s own data vocabulary: the strategy enum, this file's own
//! per-axis `Axis` (deliberately NOT unified with `slam::Axis` or
//! `scale_learner::Axis` — see this module's own doc comment), the large
//! options struct, and the result/diagnostic shapes every strategy
//! (including `curve_mover`'s) returns.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveStrategy {
    DetectThenMove,
    SlamThenMove,
    AssumeAt,
    CurveOneShot,
}

/// `move-to.ts`'s own per-axis type (line 173) — structurally identical
/// to but deliberately NOT unified with `slam::Axis` or
/// `scale_learner::Axis`. `cursor-anchor.ts`'s own header comment already
/// named this exact three-way split as a known, deliberately-out-of-scope
/// TS property; this port keeps all three independent for the same
/// reason the other two already do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Default)]
pub struct MoveToOptions {
    /// Cursor origin discovery.
    pub strategy: Option<MoveStrategy>,
    pub assume_cursor_at: Option<Point>,
    pub slam_origin_px: Option<Point>,
    pub slam_first: Option<bool>,

    pub profile: Option<crate::ballistics::BallisticsProfile>,
    pub fallback_px_per_mickey: Option<f64>,
    pub chunk_magnitude: Option<f64>,
    pub chunk_pace_ms: Option<u64>,
    pub post_move_settle_ms: Option<u64>,

    /// Enable closed-loop correction (default true).
    pub correct: Option<bool>,

    /// strategy='curve-one-shot' only: V8 presence gate for detection
    /// (default 0.5).
    pub min_presence: Option<f64>,
    /// strategy='curve-one-shot' only: when set, run ONE correction shot
    /// if the post-shot residual exceeds this many px. `None` = derive
    /// from the acceptance gate (see `accept_gate_px`) so a residual in
    /// the dead band is re-shot, not skipped.
    pub one_shot_correct_gate_px: Option<f64>,
    /// strategy='curve-one-shot' only: the caller's acceptance gate
    /// (`maxResidualPx`). Threaded so the mover derives its correction
    /// gate strictly below it — the two can't silently drift.
    pub accept_gate_px: Option<f64>,
    /// strategy='curve-one-shot' only: per-axis curve scale (the passive
    /// learner's current value; defaults to the shipped constant inside
    /// the mover when absent).
    pub curve_scale_x: Option<f64>,
    pub curve_scale_y: Option<f64>,
    /// Max correction passes. Default 2.
    pub max_correction_passes: Option<u32>,
    /// Tolerance for early-exit (px). If observed |residual| below this
    /// in both axes, stop. Default 25.
    pub min_residual_px: Option<f64>,

    /// Warmup move emitted before screenshot A so the cursor is rendered.
    /// Mickeys; default 8.
    pub warmup_mickeys: Option<f64>,
    /// Max distance (px) from origin where the "pre" cluster may be.
    /// Default 120.
    pub pre_window: Option<f64>,
    /// Max distance (px) from predicted landing where the "post" cluster
    /// may be. Default 600 — wide enough to tolerate 2× acceleration
    /// variance on an iPad-size target.
    pub post_window: Option<f64>,

    /// Forwarded to `slam_to_corner` when the slam strategy is used.
    pub slam_pace_ms: Option<u64>,
    pub verbose: bool,

    // -- Phase C: linear-region final approach ---------------------------
    /// Per-call mickey size during the linear-region approach. Default 8
    /// — small enough that iPadOS doesn't kick acceleration in.
    pub linear_chunk_magnitude: Option<f64>,
    /// Inter-call pace during the linear approach. Default 60ms — slow
    /// enough that consecutive deltas don't accumulate into a fast burst.
    pub linear_chunk_pace_ms: Option<u64>,
    /// Residual at which we drop into the linear regime. Default 100px.
    pub linear_trigger_residual_px: Option<f64>,
    /// Convergence target during the linear regime. Default 3px.
    pub linear_residual_px: Option<f64>,
    /// Max linear-regime passes (independent of `max_correction_passes`).
    /// Default 4.
    pub linear_max_passes: Option<u32>,
    /// Phase 64 — per-pass mickey cap during linear-regime corrections.
    /// Default 25.
    pub linear_correction_cap: Option<f64>,
    /// Phase 64 — disable the LINEAR BAILOUT safety mechanism. Default
    /// false (keep the safety check).
    pub disable_linear_bailout: bool,
    /// Phase 29: residual at which a verified position is "good enough"
    /// to click on. Default 40px. Set to 0 to disable.
    pub icon_tolerance_residual_px: Option<f64>,
    /// Per-axis sanity bounds for the live ratio update. Default
    /// [0.3, 5].
    pub ratio_clamp_lo: Option<f64>,
    pub ratio_clamp_hi: Option<f64>,

    /// When set, every frame captured during this move is written to
    /// this directory as a JPEG. Debug only.
    pub debug_dir: Option<std::path::PathBuf>,

    /// Calibration probe size in mickeys. Default 40. Set to 0 to
    /// disable.
    pub calibration_probe_mickeys: Option<f64>,

    /// When true, refuse to fall back to slam-to-corner if
    /// detect-then-move fails. Throw instead. Default false.
    pub forbid_slam_fallback: bool,
    /// Phase 32: when true (default), refuse to perform slam-to-corner
    /// when iPad-portrait letterbox is detected, even if the caller
    /// explicitly passed strategy='slam-then-move'. Default true.
    pub forbid_slam_on_ipad: Option<bool>,

    /// Phase 251: diagnostic top-K, threaded into
    /// `find_cursor_by_template_set` calls. Does NOT change selection.
    pub top_k: Option<u32>,

    /// Phase 22: when true, the big open-loop emit is zeroed out; the
    /// correction loop emits the full distance via small verifiable
    /// chunks. Default false.
    pub progressive_open_loop: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectionMode {
    Motion,
    Template,
    Predicted,
    Shape,
}

#[derive(Debug, Clone)]
pub struct CorrectionPass {
    pub detected_cursor: Point,
    pub live_px_per_mickey: f64,
    pub correction_mickeys: (f64, f64),
    /// How the post-correction position was determined.
    pub mode: DetectionMode,
    /// Free-form diagnostic: failure reason when motion-diff returned
    /// null, template-match score when fallback fired, etc.
    pub reason: Option<String>,
}

/// A single step in `move_to_pixel`'s per-pass accounting. Tracks both
/// the open-loop probe and every correction so the caller can see
/// exactly where convergence stalled.
#[derive(Debug, Clone)]
pub struct MovePassDiagnostic {
    /// 0 = the initial open-loop emission; 1..N = correction passes.
    pub pass: u32,
    /// Which detection path produced the post-position estimate.
    pub mode: DetectionMode,
    /// Position estimate after this pass.
    pub detected_at: Point,
    /// Euclidean residual to target.
    pub residual_px: f64,
    /// px/mickey ratio used to plan this pass's emission.
    pub ratio_used: (f64, f64),
    /// Why the chosen mode was used.
    pub reason: Option<String>,
    /// True if this pass was emitted in the slow/small linear-region
    /// approach mode (Phase C).
    pub linear_phase: bool,
}

/// (#41) First-shot passive-learning sample: planned (target−start) vs
/// achieved (FIRST-shot landing − start, before any correction) per
/// axis, for the scale learner. `curve-one-shot` only; other strategies
/// leave it `None`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoveLearnSample {
    pub planned_x: f64,
    pub planned_y: f64,
    pub achieved_x: f64,
    pub achieved_y: f64,
    pub woken: bool,
}

#[derive(Debug, Clone)]
pub struct MoveToResult {
    pub screenshot: Vec<u8>,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    pub target: Point,
    pub predicted: Point,
    pub emitted_mickeys: (f64, f64),
    pub used_px_per_mickey: (f64, f64),
    pub chunk_count: u32,
    pub strategy: MoveStrategy,
    pub corrections: Vec<CorrectionPass>,
    /// Per-pass accounting (open-loop + each correction).
    pub diagnostics: Vec<MovePassDiagnostic>,
    /// Best-known cursor position after all moves. `None` if no
    /// detection ever succeeded.
    pub final_detected_position: Option<Point>,
    /// Final residual (Euclidean px from target to
    /// `final_detected_position`). `None` when that's `None`.
    pub final_residual_px: Option<f64>,
    /// How many predicted-mode passes ran AFTER the most recent verified
    /// detection (motion-diff or template-match). 0 means the last
    /// position update was verified.
    pub passes_since_last_verification: u32,
    /// Phase 285: true when the algorithm returned an earlier pass's
    /// verified position because the final pass either failed detection
    /// or had a substantially worse residual than an earlier verified
    /// landing.
    pub bailed_to_best_pass: bool,
    pub resolution: pikvm_mcp_kvmd_client::client::ScreenResolution,
    pub message: String,
    /// (#41) First-shot passive-learning sample. `curve-one-shot` only;
    /// other strategies leave it `None`.
    pub learn_sample: Option<MoveLearnSample>,
}
