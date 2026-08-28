//! Shared `auto_calibrate` data shapes: the config/result structs and the
//! small internal `Point`/`CalibrationSample` types the sampling algorithm
//! threads through its state.
//!
//! Split out of `auto_calibrate.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use pikvm_mcp_kvmd_client::client::ScreenResolution;

#[derive(Debug, Clone, Copy)]
pub struct AutoCalibrationConfig {
    pub rounds: u32,
    pub verify_rounds: u32,
    pub move_delay_ms: u64,
    pub diff_threshold: i32,
    pub min_cluster_size: usize,
    pub max_cluster_size: usize,
    pub max_retries: u32,
    pub merge_radius: f64,
    pub min_samples: usize,
    pub max_ratio_divergence: f64,
    pub verbose: bool,
}

impl Default for AutoCalibrationConfig {
    fn default() -> Self {
        Self {
            rounds: 5,
            verify_rounds: 5,
            move_delay_ms: 300,
            diff_threshold: 30,
            min_cluster_size: 4,
            max_cluster_size: 2500,
            max_retries: 3,
            merge_radius: 30.0,
            min_samples: 3,
            max_ratio_divergence: 0.5,
            verbose: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AutoCalibrationResult {
    pub success: bool,
    pub factor_x: f64,
    pub factor_y: f64,
    pub resolution: ScreenResolution,
    /// 0-1.
    pub confidence: f64,
    pub verification_score: i32,
    pub valid_samples: usize,
    pub total_rounds: u32,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Point {
    pub(super) x: f64,
    pub(super) y: f64,
}

pub(super) struct CalibrationSample {
    // Faithfully preserved from the TS source's own `CalibrationSample`
    // interface: `detectedDelta` is stored on every sample there too but
    // never read back out of the `samples` array afterward (checked
    // against the actual source, not assumed) — not a Rust-port omission.
    #[allow(dead_code)]
    pub(super) detected_delta: Point,
    pub(super) commanded_delta: Point,
    pub(super) ratio_x: f64,
    pub(super) ratio_y: f64,
}
