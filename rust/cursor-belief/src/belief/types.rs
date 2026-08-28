//! `CursorBelief`'s own data types: the public position/velocity/bounds
//! vocabulary callers construct and read, plus the private per-field
//! variance/ratio/last-emit bookkeeping the estimator itself owns.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// A relative-mouse emit: (dx, dy) in HID mickeys.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Emit {
    pub dx: f64,
    pub dy: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BeliefRegion {
    pub cx: f64,
    pub cy: f64,
    pub rx: f64,
    pub ry: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BeliefEdges {
    pub north: bool,
    pub south: bool,
    pub east: bool,
    pub west: bool,
}

/// Per-axis (x, y) pair — used for ratio priors/variances in options
/// where the TS side takes a plain `{ x, y }` object.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Axes {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RatioClamp {
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct CursorBeliefOptions {
    pub initial_position: Point,
    /// Initial position variance per axis (px²). Default 25 (σ=5px).
    pub initial_position_variance: Option<f64>,
    /// Calibration prior for px/mickey. Default 1.3 on each axis (iPad fleet).
    pub ratio_prior: Option<Axes>,
    /// Variance on the ratio prior. Default 0.1 each axis (σ≈0.32 px/mickey).
    pub ratio_variance_prior: Option<Axes>,
    /// Screen bounds for clip-and-inflate behaviour. Optional.
    pub bounds: Option<Bounds>,
    /// Process noise scale: variance added per |emit|. Default 0.5.
    pub process_noise_scale: Option<f64>,
    /// Variance contributed to the position when cursor lands at an edge —
    /// we don't know where on the edge it actually sits. Per emit. Default 100.
    pub edge_clip_variance: Option<f64>,
    /// Sanity floor/ceiling on live-measured ratio (px/mickey). The ratio
    /// belief never updates past these. Default [0.5, 3.0] (matches the
    /// live observed range 1.25-1.75 with safety margin).
    pub ratio_clamp: Option<RatioClamp>,
}

impl CursorBeliefOptions {
    /// Convenience constructor mirroring the TS call sites that only ever
    /// set `initialPosition` (everything else takes its documented default).
    pub fn new(initial_position: Point) -> Self {
        Self {
            initial_position,
            initial_position_variance: None,
            ratio_prior: None,
            ratio_variance_prior: None,
            bounds: None,
            process_noise_scale: None,
            edge_clip_variance: None,
            ratio_clamp: None,
        }
    }
}

/// Options to gate `observe()` against static-feature lock-in (the "same
/// pixel returned across consecutive detections after a real emit"
/// pattern). See `CursorBelief::observe`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ObserveOptions {
    pub reject_stationary: bool,
    /// Drift threshold (px). Default 5 — matches `isStaleTemplateMatch`.
    pub stationary_drift_px: Option<f64>,
    /// Minimum emit magnitude (mickeys) between observations for the
    /// stationary check to fire. Default 30.
    pub stationary_min_emit_mickeys: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct WouldRejectOptions {
    pub drift_px: Option<f64>,
    pub min_emit_mickeys: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Variance {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) vx: f64,
    pub(super) vy: f64,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct RatioState {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) vx: f64,
    pub(super) vy: f64,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct LastEmit {
    pub(super) dx: f64,
    pub(super) dy: f64,
    pub(super) clipped_x: bool,
    pub(super) clipped_y: bool,
    pub(super) pre_pos_x: f64,
    pub(super) pre_pos_y: f64,
}
