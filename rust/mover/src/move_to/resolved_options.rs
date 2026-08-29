//! Pure option-resolution for the legacy (non-curve-one-shot)
//! `moveToPixel` path. Faithful port of `move-to.ts`'s own upfront
//! `const x = options.foo ?? default` block (move-to.ts:1487-1560,
//! including the ballistics-profile freshness check and the initial
//! px/mickey lookup) — read out of `moveToPixel` on its own because it
//! has no back-coupling into anything after it: everything downstream
//! only ever reads these resolved values, never mutates the inputs that
//! produced them. See `docs/rust-port-plan.md` v17 for why the rest of
//! `moveToPixel` (calibration probe → open-loop cascade → correction
//! loop) does NOT get the same treatment — that part's ~15 local
//! variables are read AND mutated across one continuous sequence, and
//! splitting it would relocate the coupling, not reduce it.
//!
//! Deliberately excludes options that TS itself resolves later, at their
//! own point of use rather than upfront (`calibrationProbeMickeys`,
//! `debugDir`, `topK`, `linearCorrectionCap`, `disableLinearBailout`,
//! `progressiveOpenLoop`, `forbidSlamFallback`, `forbidSlamOnIpad`) —
//! those stay plain `options.foo.unwrap_or(default)` reads in the stages
//! that actually use them, matching the source structure instead of
//! inventing an upfront resolution TS never had.

use pikvm_mcp_kvmd_client::client::ScreenResolution;

use crate::ballistics::{lookup_px_per_mickey, profile_is_fresh_for, BallisticsProfile, Pace};
use crate::slam::Axis as BallisticsAxis;

use super::types::MoveToOptions;

/// Cursor cluster size range accepted by `detect_motion` (move-to.ts:
/// 1555-1556, "Phase B: widened from 10-60 to 8-90... Loosened to 4").
/// Not caller-configurable in TS either — a fixed pair of constants, not
/// a default-able option.
pub(super) const CLUSTER_MIN_PX: f64 = 4.0;
pub(super) const CLUSTER_MAX_PX: f64 = 90.0;

#[derive(Debug, Clone)]
pub(super) struct ResolvedMoveOptions {
    pub fallback_px_per_mickey: f64,
    pub chunk_magnitude: f64,
    pub chunk_pace_ms: u64,
    pub post_move_settle_ms: u64,
    pub do_correct: bool,
    pub max_correction_passes: u32,
    pub min_residual_px: f64,
    pub pre_window: f64,
    pub post_window: f64,
    pub verbose: bool,
    pub ratio_clamp_lo: f64,
    pub ratio_clamp_hi: f64,
    pub linear_chunk_magnitude: f64,
    pub linear_chunk_pace_ms: u64,
    pub linear_trigger_residual_px: f64,
    pub linear_residual_px: f64,
    pub linear_max_passes: u32,
    pub icon_tolerance_residual_px: f64,
    /// `None` when the caller passed no profile, or passed one whose
    /// resolution doesn't match the current device (dropped with a
    /// verbose warning, same as TS). Kept on the struct for fidelity to
    /// TS's own `profile` local even though `legacy_move.rs` — like TS's
    /// `moveToPixel` — only ever reads it indirectly, via the
    /// `px_per_mickey_x/y` lookup already performed above; nothing reads
    /// the profile itself again afterward in either implementation.
    #[allow(dead_code)]
    pub profile: Option<BallisticsProfile>,
    /// Initial px/mickey estimate per axis — profile lookup at
    /// `chunk_magnitude`/`Pace::Slow` when a fresh profile is present,
    /// else `fallback_px_per_mickey`. Refined later by the calibration
    /// probe; this is only the pre-calibration starting point.
    pub px_per_mickey_x: f64,
    pub px_per_mickey_y: f64,
}

pub(super) fn resolve_options(
    options: &MoveToOptions,
    resolution: ScreenResolution,
) -> ResolvedMoveOptions {
    let verbose = options.verbose;
    let fallback = options.fallback_px_per_mickey.unwrap_or(1.0);
    let chunk_magnitude = options.chunk_magnitude.unwrap_or(20.0);
    let progressive_open_loop = options.progressive_open_loop;

    // Phase B: validate ballistics profile freshness against current
    // resolution. A profile measured on a different device silently
    // mis-predicts every move; better to drop it and warn.
    let profile = options.profile.clone().filter(|p| {
        let fresh = profile_is_fresh_for(Some(p), resolution);
        if !fresh && verbose {
            eprintln!(
                "[move-to] WARN profile resolution {}×{} does not match current {}×{}; \
                 dropping profile, using fallback {fallback}",
                p.resolution.width, p.resolution.height, resolution.width, resolution.height,
            );
        }
        fresh
    });

    let px_per_mickey_x = profile
        .as_ref()
        .and_then(|p| lookup_px_per_mickey(p, BallisticsAxis::X, chunk_magnitude, Pace::Slow))
        .unwrap_or(fallback);
    let px_per_mickey_y = profile
        .as_ref()
        .and_then(|p| lookup_px_per_mickey(p, BallisticsAxis::Y, chunk_magnitude, Pace::Slow))
        .unwrap_or(fallback);

    ResolvedMoveOptions {
        fallback_px_per_mickey: fallback,
        chunk_magnitude,
        chunk_pace_ms: options.chunk_pace_ms.unwrap_or(30),
        post_move_settle_ms: options.post_move_settle_ms.unwrap_or(300),
        do_correct: options.correct.unwrap_or(true),
        max_correction_passes: options
            .max_correction_passes
            .unwrap_or(if progressive_open_loop { 12 } else { 5 }),
        min_residual_px: options.min_residual_px.unwrap_or(8.0),
        pre_window: options.pre_window.unwrap_or(120.0),
        post_window: options.post_window.unwrap_or(600.0),
        verbose,
        ratio_clamp_lo: options.ratio_clamp_lo.unwrap_or(0.3),
        ratio_clamp_hi: options.ratio_clamp_hi.unwrap_or(5.0),
        linear_chunk_magnitude: options.linear_chunk_magnitude.unwrap_or(8.0),
        linear_chunk_pace_ms: options.linear_chunk_pace_ms.unwrap_or(60),
        linear_trigger_residual_px: options.linear_trigger_residual_px.unwrap_or(100.0),
        linear_residual_px: options.linear_residual_px.unwrap_or(3.0),
        linear_max_passes: options.linear_max_passes.unwrap_or(4),
        icon_tolerance_residual_px: options.icon_tolerance_residual_px.unwrap_or(25.0),
        profile,
        px_per_mickey_x,
        px_per_mickey_y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn res(width: u32, height: u32) -> ScreenResolution {
        ScreenResolution { width, height }
    }

    fn fresh_profile(resolution: ScreenResolution) -> BallisticsProfile {
        BallisticsProfile {
            version: 1,
            created_at: "2026-08-29T00:00:00.000Z".to_string(),
            resolution,
            samples: Vec::new(),
            medians: HashMap::from([
                ("x:slow:20".to_string(), 1.5),
                ("y:slow:20".to_string(), 1.7),
            ]),
        }
    }

    #[test]
    fn defaults_match_the_ts_literals_when_no_options_are_set() {
        let r = resolve_options(&MoveToOptions::default(), res(1920, 1080));
        assert_eq!(r.fallback_px_per_mickey, 1.0);
        assert_eq!(r.chunk_magnitude, 20.0);
        assert_eq!(r.chunk_pace_ms, 30);
        assert_eq!(r.post_move_settle_ms, 300);
        assert!(r.do_correct);
        assert_eq!(r.max_correction_passes, 5);
        assert_eq!(r.min_residual_px, 8.0);
        assert_eq!(r.pre_window, 120.0);
        assert_eq!(r.post_window, 600.0);
        assert!(!r.verbose);
        assert_eq!(r.ratio_clamp_lo, 0.3);
        assert_eq!(r.ratio_clamp_hi, 5.0);
        assert_eq!(r.linear_chunk_magnitude, 8.0);
        assert_eq!(r.linear_chunk_pace_ms, 60);
        assert_eq!(r.linear_trigger_residual_px, 100.0);
        assert_eq!(r.linear_residual_px, 3.0);
        assert_eq!(r.linear_max_passes, 4);
        assert_eq!(r.icon_tolerance_residual_px, 25.0);
        assert!(r.profile.is_none());
        assert_eq!(r.px_per_mickey_x, 1.0);
        assert_eq!(r.px_per_mickey_y, 1.0);
    }

    #[test]
    fn progressive_open_loop_raises_the_default_max_correction_passes_to_12() {
        let o = MoveToOptions {
            progressive_open_loop: true,
            ..Default::default()
        };
        let r = resolve_options(&o, res(1920, 1080));
        assert_eq!(r.max_correction_passes, 12);
    }

    #[test]
    fn caller_supplied_max_correction_passes_wins_even_with_progressive_open_loop() {
        let o = MoveToOptions {
            progressive_open_loop: true,
            max_correction_passes: Some(3),
            ..Default::default()
        };
        let r = resolve_options(&o, res(1920, 1080));
        assert_eq!(r.max_correction_passes, 3);
    }

    #[test]
    fn correct_false_is_threaded_through_as_do_correct_false() {
        let o = MoveToOptions {
            correct: Some(false),
            ..Default::default()
        };
        let r = resolve_options(&o, res(1920, 1080));
        assert!(!r.do_correct);
    }

    #[test]
    fn a_profile_matching_the_current_resolution_is_kept_and_looked_up() {
        let resolution = res(1920, 1080);
        let o = MoveToOptions {
            profile: Some(fresh_profile(resolution)),
            ..Default::default()
        };
        let r = resolve_options(&o, resolution);
        assert!(r.profile.is_some());
        assert_eq!(r.px_per_mickey_x, 1.5);
        assert_eq!(r.px_per_mickey_y, 1.7);
    }

    #[test]
    fn a_profile_from_a_different_resolution_is_dropped_and_fallback_is_used() {
        let o = MoveToOptions {
            profile: Some(fresh_profile(res(1280, 720))),
            fallback_px_per_mickey: Some(2.5),
            ..Default::default()
        };
        let r = resolve_options(&o, res(1920, 1080));
        assert!(r.profile.is_none());
        assert_eq!(r.px_per_mickey_x, 2.5);
        assert_eq!(r.px_per_mickey_y, 2.5);
    }

    #[test]
    fn a_profile_with_no_median_for_the_requested_magnitude_falls_back_per_axis() {
        let resolution = res(1920, 1080);
        let mut profile = fresh_profile(resolution);
        // Only an X median at magnitude 20 — Y has nothing at all, so
        // lookup_px_per_mickey has no neighbours to interpolate from.
        profile.medians.remove("y:slow:20");
        let o = MoveToOptions {
            profile: Some(profile),
            fallback_px_per_mickey: Some(3.0),
            ..Default::default()
        };
        let r = resolve_options(&o, resolution);
        assert_eq!(r.px_per_mickey_x, 1.5);
        assert_eq!(r.px_per_mickey_y, 3.0);
    }

    #[test]
    fn cluster_bounds_are_the_fixed_ts_constants_not_caller_configurable() {
        assert_eq!(CLUSTER_MIN_PX, 4.0);
        assert_eq!(CLUSTER_MAX_PX, 90.0);
    }
}
