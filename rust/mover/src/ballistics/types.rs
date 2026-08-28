//! Ballistics's own data types: one measured sample, the persisted
//! profile shape, the measurement-session and per-cluster-pair-selection
//! option structs, and the noise-baseline result.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use pikvm_mcp_detection_vision::cursor_detect::DetectionConfig;
use pikvm_mcp_kvmd_client::client::ScreenResolution;

use crate::slam::Axis;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pace {
    Fast,
    Slow,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BallisticsSample {
    pub axis: Axis,
    pub magnitude: f64,
    pub pace: Pace,
    pub call_count: u32,
    pub mickeys_emitted: f64,
    pub pixels_measured: f64,
    pub px_per_mickey: f64,
    pub rep: u32,
}

/// Faithful port of the TS `version: 1` literal type. Unlike
/// `scale_persist.rs`'s self-validating `PersistedVersion` (which makes an
/// out-of-band version un-deserializable at all), this stays a plain `u8`:
/// `loadProfile`'s TS behavior is JSON-parse-then-check with a specific
/// custom error message (`Unsupported ballistics profile version: N`),
/// not a generic deserialize failure — `persist.rs`'s `load_profile`
/// reproduces that exact two-step shape, so the type itself must not
/// enforce the check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BallisticsProfile {
    pub version: u8,
    pub created_at: String,
    pub resolution: ScreenResolution,
    pub samples: Vec<BallisticsSample>,
    /// Per-axis/pace/magnitude median of `pxPerMickey`, pre-aggregated for
    /// quick lookups. Keyed as `"{axis}:{pace}:{magnitude}"` — see
    /// `lookup::median_key`.
    pub medians: HashMap<String, f64>,
}

#[derive(Debug, Clone)]
pub struct MeasureBallisticsOptions {
    pub magnitudes: Vec<f64>,
    pub paces: Vec<Pace>,
    pub axes: Vec<Axis>,
    pub reps: u32,
    /// Calls of `magnitude` per rep.
    pub calls_per_cell: u32,
    pub slow_pace_ms: u64,
    /// Baseline frames for noise capture.
    pub noise_frames: u32,
    /// Gap between baseline frames.
    pub noise_interval_ms: u64,
    /// Radius (px) around a noise centroid to exclude.
    pub noise_exclude_radius: f64,
    /// Full-struct override, not a partial merge — same individually-
    /// justified simplification `slam::SlamOptions.detection` already
    /// made (see its own doc): no test in this file's real TS suite
    /// exercises a partial override, and a full-struct default is the
    /// more idiomatic Rust shape.
    pub detection: DetectionConfig,
    /// `None` defaults to `persist::default_profile_path()`.
    pub profile_path: Option<std::path::PathBuf>,
    pub verbose: bool,
}

impl Default for MeasureBallisticsOptions {
    fn default() -> Self {
        Self {
            magnitudes: vec![5.0, 10.0, 20.0, 40.0, 80.0, 127.0],
            paces: vec![Pace::Fast, Pace::Slow],
            axes: vec![Axis::X, Axis::Y],
            reps: 2,
            calls_per_cell: 5,
            slow_pace_ms: 30,
            noise_frames: 4,
            noise_interval_ms: 500,
            noise_exclude_radius: 30.0,
            detection: DetectionConfig::default(),
            profile_path: None,
            verbose: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MeasureBallisticsResult {
    pub success: bool,
    pub profile: Option<BallisticsProfile>,
    pub profile_path: std::path::PathBuf,
    pub samples_accepted: usize,
    pub samples_rejected: usize,
    pub duration_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NoiseCentroid {
    pub x: i64,
    pub y: i64,
    pub size: usize,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NoiseBaseline {
    pub centroids: Vec<NoiseCentroid>,
    pub frames: u32,
}

/// Options for `measure::order_clusters_by_direction`'s cursor-sized-pair
/// selection.
#[derive(Debug, Clone, Copy)]
pub struct PairSelectionOptions {
    /// Min pixel count for a cluster to be a candidate. Below this is
    /// noise.
    pub cursor_min_pixels: usize,
    /// Max pixel count for a cluster to be a candidate. Above this is
    /// usually a widget or large UI region, not the cursor.
    pub cursor_max_pixels: usize,
    /// Two cursor positions (before/after) should have similar visual
    /// signatures, so their pixel counts should be close. Max ratio
    /// larger/smaller allowed.
    pub size_ratio_limit: f64,
    /// Maximum off-axis displacement, as a fraction of on-axis
    /// displacement. The cursor moves nearly straight when commanded +x
    /// or +y; a pair with large off-axis drift is probably two unrelated
    /// clusters.
    pub off_axis_tolerance_ratio: f64,
    /// Minimum absolute on-axis displacement (px). Smaller than this is
    /// probably two samples of the same near-stationary cluster.
    pub min_on_axis_px: f64,
}

impl Default for PairSelectionOptions {
    fn default() -> Self {
        Self {
            cursor_min_pixels: 12,
            cursor_max_pixels: 150,
            size_ratio_limit: 2.5,
            off_axis_tolerance_ratio: 0.35,
            min_on_axis_px: 25.0,
        }
    }
}
