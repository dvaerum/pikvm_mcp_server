//! The measurement sweep: pick the cursor-sized cluster pair that matches
//! a commanded direction, measure one (axis, magnitude, pace, rep) cell,
//! and orchestrate the full sweep into a profile. Faithful port of
//! `orderClustersByDirection`/`measureCell`/`measureBallistics`.

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_detection_vision::cursor_detect::{diff_screenshots, Cluster};
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::cursor_anchor::{
    anchor_cursor, AnchorGuard, AnchorNudge, AnchorRecoveryPosture, AnchorRequest,
};
use crate::slam::{Axis, Corner, ScreenshotMode};

use super::capture::take_raw_screenshot;
use super::lookup::compute_medians;
use super::noise::{capture_noise_baseline, filter_out_noise, CaptureNoiseBaselineOptions};
use super::persist::{default_profile_path, save_profile};
use super::types::{
    BallisticsProfile, BallisticsSample, MeasureBallisticsOptions, MeasureBallisticsResult,
    NoiseBaseline, Pace, PairSelectionOptions,
};

/// Pick the cluster pair that best matches an expected delta vector.
///
/// Assumes the cursor is a small-to-medium bright cluster whose
/// before-move and after-move signatures have similar pixel counts.
/// Rejects obvious widget regions (too big) and sub-cursor noise (too
/// small) up front, then finds the pair whose displacement aligns with
/// the commanded direction with minimal off-axis drift and matching
/// sizes.
pub(super) fn order_clusters_by_direction(
    clusters: &[Cluster],
    expected_direction: (f64, f64),
    options: PairSelectionOptions,
) -> Option<(Cluster, Cluster)> {
    let candidates: Vec<&Cluster> = clusters
        .iter()
        .filter(|c| c.pixels >= options.cursor_min_pixels && c.pixels <= options.cursor_max_pixels)
        .collect();
    if candidates.len() < 2 {
        return None;
    }

    let (edx, edy) = expected_direction;
    let expected_is_x = edx.abs() >= edy.abs();
    let sign = if expected_is_x {
        edx.signum()
    } else {
        edy.signum()
    };

    let mut best: Option<((Cluster, Cluster), f64)> = None;
    for i in 0..candidates.len() {
        for j in (i + 1)..candidates.len() {
            let a = candidates[i];
            let b = candidates[j];

            let size_ratio = a.pixels.max(b.pixels) as f64 / (a.pixels.min(b.pixels).max(1)) as f64;
            if size_ratio > options.size_ratio_limit {
                continue;
            }

            let dx = (b.centroid_x - a.centroid_x) as f64;
            let dy = (b.centroid_y - a.centroid_y) as f64;
            let axis_disp = if expected_is_x { dx } else { dy };
            let off_axis_abs = if expected_is_x { dy.abs() } else { dx.abs() };
            let on_axis_abs = axis_disp.abs();
            if on_axis_abs < options.min_on_axis_px {
                continue;
            }
            if off_axis_abs > on_axis_abs * options.off_axis_tolerance_ratio {
                continue;
            }

            let aligned_axis = sign * axis_disp;
            if aligned_axis <= 0.0 {
                continue;
            }

            let score = aligned_axis - off_axis_abs - 10.0 * (size_ratio - 1.0);
            if best.as_ref().map(|(_, s)| score > *s).unwrap_or(true) {
                best = Some(((a.clone(), b.clone()), score));
            }
        }
    }

    best.map(|(pair, _)| pair)
}

/// Measure one (axis, magnitude, pace, rep) cell. `None` means the cell
/// was rejected (caller counts it, doesn't retry — `measureBallistics`
/// resamples via `reps` instead).
#[allow(clippy::too_many_arguments)]
async fn measure_cell(
    client: &Arc<PiKVMClient>,
    axis: Axis,
    magnitude: f64,
    pace: Pace,
    rep: u32,
    noise: Option<&NoiseBaseline>,
    options: &MeasureBallisticsOptions,
) -> anyhow::Result<Option<BallisticsSample>> {
    // Reset: slam to top-left, then nudge past the edge dead zone so the
    // cursor sits in open space where movement registers and detection
    // is clean. captureVerification:true (2026-08-24, live-confirmed by
    // the #60 gate: the very first production-shape measureBallistics
    // run hit a genuine iPad lock screen mid-sweep) — without this, a
    // slam interrupted by a system-gesture reinterpretation reads as
    // ordinary near-zero-displacement noise, silently poisoning the cell
    // rather than failing loudly. recovery:InspectOnly: measure_cell
    // reads `verified` itself and rejects the cell outright on failure —
    // no retry (unlike unlockIpad, which can't call itself to recover) —
    // ballistics already resamples via `reps`, so a rejected cell is a
    // cheap, no-new-risk response. guard:NoneCalibration — synthetic
    // scene, no iPad-lock risk, no bounds detection.
    let anchor_result = anchor_cursor(AnchorRequest {
        client: client.clone(),
        allow_keyboard_wake_after: false, // see docs/corner-control-allow-keyboard-wake-decision.md
        allow_keyboard_wake_before: false, // see docs/corner-control-allow-keyboard-wake-decision.md
        corner: Some(Corner::TopLeft),
        guard: AnchorGuard::NoneCalibration,
        // ADR 0001: this module's own non-nudging capture — the same one
        // slam_to_corner's verify_motion uses, and the one this
        // function's own before/after measurement pair below still uses
        // directly (that pair is NOT verification, it's the actual
        // ballistics measurement — kept entirely separate per ADR 0001's
        // asymmetric-nudge rule).
        screenshot: ScreenshotMode::Raw,
        capture_verification: true,
        recovery: AnchorRecoveryPosture::InspectOnly,
        nudge: Some(AnchorNudge {
            away: Some(Corner::TopLeft),
            only_axis: Some(if axis == Axis::X { Axis::Y } else { Axis::X }),
        }),
        pace_ms: None,
        slam_origin_px: None,
        slam_calls: None,
        verbose: false,
    })
    .await?;
    if anchor_result.verified == Some(false) {
        if options.verbose {
            eprintln!("[cell {axis:?}/{magnitude}/{pace:?}/r{rep}] slam motion not verified — rejecting cell");
        }
        return Ok(None);
    }

    // Warm-up probe: a small move right before screenshot A so the
    // cursor is guaranteed visible (iPadOS fades the cursor ~300ms after
    // movement stops). The probe itself contributes negligibly to the
    // measurement.
    client.mouse_move_relative(5.0, 0.0).await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let before = take_raw_screenshot(client).await?;

    let dx = if axis == Axis::X { magnitude } else { 0.0 };
    let dy = if axis == Axis::Y { magnitude } else { 0.0 };
    let pace_ms = if pace == Pace::Fast {
        0
    } else {
        options.slow_pace_ms
    };

    for _ in 0..options.calls_per_cell {
        client.mouse_move_relative(dx, dy).await?;
        if pace_ms > 0 {
            tokio::time::sleep(Duration::from_millis(pace_ms)).await;
        }
    }
    // Screenshot B immediately — the cursor was just moved and is still
    // rendered, before iPadOS has a chance to fade it.
    let after = take_raw_screenshot(client).await?;

    let clusters = match diff_screenshots(&before, &after, &options.detection) {
        Ok(c) => c,
        Err(e) => {
            if options.verbose {
                eprintln!("[cell {axis:?}/{magnitude}/{pace:?}/r{rep}] diff threw: {e}");
            }
            return Ok(None);
        }
    };

    let clusters = filter_out_noise(clusters, noise, options.noise_exclude_radius);
    if clusters.len() < 2 {
        if options.verbose {
            eprintln!(
                "[cell {axis:?}/{magnitude}/{pace:?}/r{rep}] only {} cluster(s) after noise filter",
                clusters.len()
            );
        }
        return Ok(None);
    }

    let Some((pre, post)) =
        order_clusters_by_direction(&clusters, (dx, dy), PairSelectionOptions::default())
    else {
        if options.verbose {
            eprintln!("[cell {axis:?}/{magnitude}/{pace:?}/r{rep}] no cluster pair aligned with ({dx},{dy})");
        }
        return Ok(None);
    };

    let displaced = if axis == Axis::X {
        (post.centroid_x - pre.centroid_x) as f64
    } else {
        (post.centroid_y - pre.centroid_y) as f64
    };
    if displaced <= 0.0 {
        if options.verbose {
            eprintln!(
                "[cell {axis:?}/{magnitude}/{pace:?}/r{rep}] non-positive displacement {displaced}"
            );
        }
        return Ok(None);
    }

    let mickeys_emitted = magnitude * options.calls_per_cell as f64;
    let px_per_mickey = displaced / mickeys_emitted;

    if options.verbose {
        eprintln!(
            "[cell {axis:?}/{magnitude}/{pace:?}/r{rep}] pre=({},{}) post=({},{}) mickeys={mickeys_emitted} px={displaced} ratio={px_per_mickey:.4}",
            pre.centroid_x, pre.centroid_y, post.centroid_x, post.centroid_y
        );
    }

    Ok(Some(BallisticsSample {
        axis,
        magnitude,
        pace,
        call_count: options.calls_per_cell,
        mickeys_emitted,
        pixels_measured: displaced,
        px_per_mickey,
        rep,
    }))
}

/// Faithful port of `new Date().toISOString()` for `BallisticsProfile.
/// createdAt`. Hand-rolled (Howard Hinnant's `civil_from_days`) rather
/// than pulling in a datetime crate for one timestamp field — see its
/// own tests for pinned epoch↔date pairs.
fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.as_millis() as i64;
    let secs = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let secs_of_day = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let h = secs_of_day / 3600;
    let mi = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z")
}

/// Days-since-epoch → (year, month, day). Howard Hinnant's
/// `civil_from_days` algorithm (public domain,
/// http://howardhinnant.github.io/date_algorithms.html), proleptic
/// Gregorian, valid for the entire `i64` range.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

pub async fn measure_ballistics(
    client: &Arc<PiKVMClient>,
    options: MeasureBallisticsOptions,
) -> anyhow::Result<MeasureBallisticsResult> {
    let started_at = std::time::Instant::now();
    let profile_path = options
        .profile_path
        .clone()
        .unwrap_or_else(default_profile_path);

    let resolution = client.get_resolution(true).await?;

    // Capture the noise baseline before touching the mouse so the cursor
    // isn't moving in any of the baseline frames.
    let noise = capture_noise_baseline(
        client,
        CaptureNoiseBaselineOptions {
            frames: options.noise_frames,
            interval_ms: options.noise_interval_ms,
            detection: options.detection,
            verbose: options.verbose,
        },
    )
    .await?;

    let mut samples: Vec<BallisticsSample> = Vec::new();
    let mut rejected = 0usize;

    for &axis in &options.axes {
        for &magnitude in &options.magnitudes {
            for &pace in &options.paces {
                for rep in 1..=options.reps {
                    match measure_cell(client, axis, magnitude, pace, rep, Some(&noise), &options)
                        .await?
                    {
                        Some(sample) => samples.push(sample),
                        None => rejected += 1,
                    }
                }
            }
        }
    }

    let duration_ms = started_at.elapsed().as_millis() as u64;

    if samples.is_empty() {
        return Ok(MeasureBallisticsResult {
            success: false,
            profile: None,
            profile_path,
            samples_accepted: 0,
            samples_rejected: rejected,
            duration_ms,
            message: "No valid samples collected. Check that the cursor is visible on screen and the display is not going to sleep.".to_string(),
        });
    }

    let medians = compute_medians(&samples);
    let profile = BallisticsProfile {
        version: 1,
        created_at: iso_now(),
        resolution,
        samples,
        medians,
    };

    save_profile(&profile, &profile_path).await?;

    let samples_accepted = profile.samples.len();
    let message = format!(
        "Collected {samples_accepted} samples ({rejected} rejected) in {}s. Profile written to {}.",
        (duration_ms as f64 / 1000.0).round(),
        profile_path.display(),
    );
    Ok(MeasureBallisticsResult {
        success: true,
        profile: Some(profile),
        profile_path,
        samples_accepted,
        samples_rejected: rejected,
        duration_ms,
        message,
    })
}

#[cfg(test)]
mod tests;
