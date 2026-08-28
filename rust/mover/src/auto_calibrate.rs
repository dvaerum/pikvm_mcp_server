//! Auto-calibration via visual cursor detection.
//!
//! Moves the mouse a known distance, diffs two screenshots to find the
//! cursor, and computes calibration factors from detected vs expected
//! positions.
//!
//! Faithful port of `src/pikvm/auto-calibrate.ts`. Crate placement:
//! `rust/mover`, matching the plan's own original filing — unlike
//! cursor-anchor.ts/ipad-unlock.ts/gesture.ts, this file's imports
//! (`client.ts`, `cursor-detect.ts`, `util.ts`) never pointed anywhere
//! else, so no crate-boundary correction was needed here.

use pikvm_mcp_detection_vision::cursor_detect::{diff_screenshots, Cluster, DetectionConfig};
use pikvm_mcp_foundation::util::median;
use pikvm_mcp_kvmd_client::client::{PiKVMClient, ScreenResolution};

mod types;

pub use types::{AutoCalibrationConfig, AutoCalibrationResult};
use types::{CalibrationSample, Point};

// ============================================================================
// Image diffing — delegated to detection-vision's cursor_detect
// ============================================================================

fn detection_config_from(config: &AutoCalibrationConfig) -> DetectionConfig {
    DetectionConfig {
        diff_threshold: config.diff_threshold,
        min_cluster_size: config.min_cluster_size,
        max_cluster_size: config.max_cluster_size,
        merge_radius: config.merge_radius,
        // Absolute-mouse auto-calibrate works on whatever target the PiKVM
        // is attached to (not iPad-specific); don't filter by brightness
        // or saturation there.
        brightness_floor: 0,
        max_channel_delta: 0,
    }
}

fn diff_screenshots_for(
    buf_a: &[u8],
    buf_b: &[u8],
    config: &AutoCalibrationConfig,
) -> anyhow::Result<Vec<Cluster>> {
    diff_screenshots(buf_a, buf_b, &detection_config_from(config))
}

// ============================================================================
// Helpers
// ============================================================================

fn magnitude(p: Point) -> f64 {
    (p.x * p.x + p.y * p.y).sqrt()
}

/// Generate a random start position in the safe zone (central 60% of screen).
fn random_safe_position(resolution: ScreenResolution) -> Point {
    let margin_x = resolution.width as f64 * 0.2;
    let margin_y = resolution.height as f64 * 0.2;
    Point {
        x: (margin_x + rand::random::<f64>() * (resolution.width as f64 - 2.0 * margin_x)).round(),
        y: (margin_y + rand::random::<f64>() * (resolution.height as f64 - 2.0 * margin_y)).round(),
    }
}

/// Generate a random delta for the calibration move (80-150px, varying
/// direction).
fn random_delta(round: u32) -> Point {
    let distance = 80.0 + rand::random::<f64>() * 70.0; // 80-150px
                                                        // Spread directions across rounds.
    let angle =
        (round as f64 * 72.0 + rand::random::<f64>() * 30.0) * (std::f64::consts::PI / 180.0);
    Point {
        x: (distance * angle.cos()).round(),
        y: (distance * angle.sin()).round(),
    }
}

/// Take a raw screenshot (no preview scaling) and return the buffer.
async fn take_raw_screenshot(client: &PiKVMClient) -> anyhow::Result<Vec<u8>> {
    Ok(client.screenshot(None).await?.buffer)
}

// ============================================================================
// Main calibration algorithm
// ============================================================================

pub async fn auto_calibrate(
    client: &PiKVMClient,
    config: AutoCalibrationConfig,
) -> anyhow::Result<AutoCalibrationResult> {
    let mut verbose_log: Vec<String> = Vec::new();
    macro_rules! vlog {
        ($($arg:tt)*) => {
            if config.verbose {
                let msg = format!($($arg)*);
                eprintln!("[auto-cal] {msg}");
                verbose_log.push(msg);
            }
        };
    }
    let verbose_suffix = |log: &[String]| -> String {
        if !log.is_empty() {
            format!("\n\n--- Verbose Log ---\n{}", log.join("\n"))
        } else {
            String::new()
        }
    };

    // Clear existing calibration.
    client.clear_calibration();

    let resolution = client.get_resolution(true).await?;
    let initial_resolution = resolution;
    vlog!("Resolution: {}x{}", resolution.width, resolution.height);

    // Take baseline screenshot (to warm up capture pipeline).
    take_raw_screenshot(client).await?;

    // ---- Sampling phase ----
    let mut samples: Vec<CalibrationSample> = Vec::new();
    let mut consecutive_failures = 0u32;

    'rounds: for round in 0..config.rounds {
        // Check resolution hasn't changed.
        let current_res = client.get_resolution(true).await?;
        if current_res.width != initial_resolution.width
            || current_res.height != initial_resolution.height
        {
            return Ok(AutoCalibrationResult {
                success: false,
                factor_x: 1.0,
                factor_y: 1.0,
                resolution: current_res,
                confidence: 0.0,
                verification_score: 0,
                valid_samples: samples.len(),
                total_rounds: round,
                message: format!(
                    "Resolution changed during calibration. Please try again with a stable display.{}",
                    verbose_suffix(&verbose_log)
                ),
            });
        }

        let start_pos = random_safe_position(resolution);
        let delta = random_delta(round);
        vlog!(
            "Round {}/{}: start=({},{}), delta=({},{})",
            round + 1,
            config.rounds,
            start_pos.x,
            start_pos.y,
            delta.x,
            delta.y
        );

        // Move to start position (raw/uncalibrated).
        client.mouse_move_raw(start_pos.x, start_pos.y).await?;
        tokio::time::sleep(std::time::Duration::from_millis(config.move_delay_ms)).await;
        let screenshot_a = take_raw_screenshot(client).await?;

        // Move by known delta.
        let end_pos = Point {
            x: start_pos.x + delta.x,
            y: start_pos.y + delta.y,
        };
        client.mouse_move_raw(end_pos.x, end_pos.y).await?;
        tokio::time::sleep(std::time::Duration::from_millis(config.move_delay_ms)).await;
        let screenshot_b = take_raw_screenshot(client).await?;

        // Diff screenshots to find cursor positions.
        let clusters = match diff_screenshots_for(&screenshot_a, &screenshot_b, &config) {
            Ok(c) => c,
            Err(_) => {
                vlog!("Round {}: diff failed (exception)", round + 1);
                consecutive_failures += 1;
                if consecutive_failures >= 3 {
                    return Ok(AutoCalibrationResult {
                        success: false,
                        factor_x: 1.0,
                        factor_y: 1.0,
                        resolution: initial_resolution,
                        confidence: 0.0,
                        verification_score: 0,
                        valid_samples: samples.len(),
                        total_rounds: round + 1,
                        message: format!(
                            "Failed to diff screenshots. The display may be off or unresponsive.{}",
                            verbose_suffix(&verbose_log)
                        ),
                    });
                }
                continue 'rounds;
            }
        };

        vlog!("Round {}: {} cluster(s) found", round + 1, clusters.len());

        // We expect exactly 2 cursor-sized clusters (old and new cursor
        // positions).
        if clusters.len() != 2 {
            vlog!(
                "Round {}: REJECTED — wrong cluster count (expected 2, got {})",
                round + 1,
                clusters.len()
            );
            consecutive_failures += 1;
            if consecutive_failures >= 3 {
                return Ok(AutoCalibrationResult {
                    success: false,
                    factor_x: 1.0,
                    factor_y: 1.0,
                    resolution: initial_resolution,
                    confidence: 0.0,
                    verification_score: 0,
                    valid_samples: samples.len(),
                    total_rounds: round + 1,
                    message: format!(
                        "Cursor detection failed: expected 2 clusters but found {}. \
                         The cursor may be hidden, or there may be screen animations. \
                         Try manual calibration with pikvm_calibrate instead.{}",
                        clusters.len(),
                        verbose_suffix(&verbose_log)
                    ),
                });
            }
            continue 'rounds;
        }

        // Reset consecutive failures on valid cluster count.
        consecutive_failures = 0;

        // Determine which cluster is the old vs new position by matching
        // direction.
        let c0 = &clusters[0];
        let c1 = &clusters[1];

        vlog!(
            "Round {}: c0=({},{}) c1=({},{})",
            round + 1,
            c0.centroid_x,
            c0.centroid_y,
            c1.centroid_x,
            c1.centroid_y
        );

        // Vector between clusters.
        let mut detected_delta = Point {
            x: (c1.centroid_x - c0.centroid_x) as f64,
            y: (c1.centroid_y - c0.centroid_y) as f64,
        };

        // Check if vector roughly matches commanded delta (within 30%
        // magnitude).
        let detected_mag = magnitude(detected_delta);
        let commanded_mag = magnitude(delta);
        if commanded_mag == 0.0 {
            vlog!(
                "Round {}: REJECTED — commanded magnitude is zero",
                round + 1
            );
            continue 'rounds;
        }

        let mag_ratio = detected_mag / commanded_mag;
        vlog!(
            "Round {}: detectedDelta=({},{}), magRatio={:.3}",
            round + 1,
            detected_delta.x,
            detected_delta.y,
            mag_ratio
        );
        if !(0.3..=3.0).contains(&mag_ratio) {
            vlog!(
                "Round {}: REJECTED — magnitude mismatch (ratio {:.3} outside 0.3–3.0)",
                round + 1,
                mag_ratio
            );
            continue 'rounds;
        }

        // Check direction roughly matches (dot product positive and angle
        // within ~60 degrees).
        let dot = detected_delta.x * delta.x + detected_delta.y * delta.y;
        if dot <= 0.0 {
            // Might be reversed — try swapping clusters.
            let alt_delta = Point {
                x: -detected_delta.x,
                y: -detected_delta.y,
            };
            let alt_dot = alt_delta.x * delta.x + alt_delta.y * delta.y;
            if alt_dot <= 0.0 {
                vlog!(
                    "Round {}: REJECTED — direction mismatch (dot={}, altDot={})",
                    round + 1,
                    dot,
                    alt_dot
                );
                continue 'rounds;
            }
            // Use swapped direction.
            detected_delta = alt_delta;
        }

        // Compute per-axis ratio: commanded / detected. Avoid division by
        // zero.
        if detected_delta.x.abs() < 2.0 && delta.x.abs() > 10.0 {
            vlog!(
                "Round {}: REJECTED — division-by-zero guard (detectedDelta.x too small)",
                round + 1
            );
            continue 'rounds;
        }
        if detected_delta.y.abs() < 2.0 && delta.y.abs() > 10.0 {
            vlog!(
                "Round {}: REJECTED — division-by-zero guard (detectedDelta.y too small)",
                round + 1
            );
            continue 'rounds;
        }

        let ratio_x = if delta.x.abs() > 5.0 {
            delta.x / detected_delta.x
        } else {
            1.0
        };
        let ratio_y = if delta.y.abs() > 5.0 {
            delta.y / detected_delta.y
        } else {
            1.0
        };

        // Reject rounds where X and Y ratios diverge wildly (indicates
        // noise, not real cursor movement). Only check when both axes
        // contributed real ratios (not the fallback 1.0).
        if delta.x.abs() > 5.0 && delta.y.abs() > 5.0 {
            let divergence = (ratio_x - ratio_y).abs() / ratio_x.abs().max(ratio_y.abs());
            if divergence > config.max_ratio_divergence {
                vlog!(
                    "Round {}: REJECTED — ratio divergence too high ({:.2} > {:.2}): ratioX={:.4}, ratioY={:.4}",
                    round + 1,
                    divergence,
                    config.max_ratio_divergence,
                    ratio_x,
                    ratio_y
                );
                continue 'rounds;
            }
        }

        vlog!(
            "Round {}: ACCEPTED — ratioX={:.4}, ratioY={:.4}",
            round + 1,
            ratio_x,
            ratio_y
        );

        samples.push(CalibrationSample {
            detected_delta,
            commanded_delta: delta,
            ratio_x,
            ratio_y,
        });
    }

    // ---- Factor computation ----
    vlog!(
        "Sampling complete: {}/{} minimum valid samples",
        samples.len(),
        config.min_samples
    );
    if samples.len() < config.min_samples {
        return Ok(AutoCalibrationResult {
            success: false,
            factor_x: 1.0,
            factor_y: 1.0,
            resolution: initial_resolution,
            confidence: 0.0,
            verification_score: 0,
            valid_samples: samples.len(),
            total_rounds: config.rounds,
            message: format!(
                "Insufficient valid samples ({}/{} minimum). \
                 The cursor may be hard to detect. Try manual calibration with pikvm_calibrate instead.{}",
                samples.len(),
                config.min_samples,
                verbose_suffix(&verbose_log)
            ),
        });
    }

    // Compute factors via pure median (inherently outlier-resistant).
    let x_ratios: Vec<f64> = samples
        .iter()
        .filter(|s| s.commanded_delta.x.abs() > 5.0)
        .map(|s| s.ratio_x)
        .collect();
    let y_ratios: Vec<f64> = samples
        .iter()
        .filter(|s| s.commanded_delta.y.abs() > 5.0)
        .map(|s| s.ratio_y)
        .collect();

    vlog!(
        "X ratios ({}): [{}]",
        x_ratios.len(),
        x_ratios
            .iter()
            .map(|r| format!("{r:.4}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    vlog!(
        "Y ratios ({}): [{}]",
        y_ratios.len(),
        y_ratios
            .iter()
            .map(|r| format!("{r:.4}"))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let factor_x = if x_ratios.len() >= 2 {
        median(&x_ratios)
    } else {
        1.0
    };
    let factor_y = if y_ratios.len() >= 2 {
        median(&y_ratios)
    } else {
        1.0
    };

    vlog!("Median factors: X={:.4}, Y={:.4}", factor_x, factor_y);

    // Sanity check.
    if !(0.5..=2.0).contains(&factor_x) || !(0.5..=2.0).contains(&factor_y) {
        return Ok(AutoCalibrationResult {
            success: false,
            factor_x: 1.0,
            factor_y: 1.0,
            resolution: initial_resolution,
            confidence: 0.0,
            verification_score: 0,
            valid_samples: samples.len(),
            total_rounds: config.rounds,
            message: format!(
                "Computed factors out of range: factorX={factor_x:.4}, factorY={factor_y:.4}. \
                 This suggests an unusual display configuration. Try manual calibration with pikvm_calibrate instead.{}",
                verbose_suffix(&verbose_log)
            ),
        });
    }

    // Apply calibration.
    client.set_calibration_factors(factor_x, factor_y)?;

    // ---- Verification phase ----
    let mut hits = 0i32;
    let mut misses = 0i32;

    for round in 0..config.verify_rounds {
        let target = random_safe_position(resolution);
        vlog!(
            "Verify {}/{}: target=({},{})",
            round + 1,
            config.verify_rounds,
            target.x,
            target.y
        );

        // Move to target (now with calibration applied).
        client.mouse_move(target.x, target.y).await?;
        tokio::time::sleep(std::time::Duration::from_millis(config.move_delay_ms)).await;
        let screenshot_c = take_raw_screenshot(client).await?;

        // Move away.
        let away_x = (target.x + 120.0).min(resolution.width as f64 - 20.0);
        let away_y = (target.y + 120.0).min(resolution.height as f64 - 20.0);
        client.mouse_move(away_x, away_y).await?;
        tokio::time::sleep(std::time::Duration::from_millis(config.move_delay_ms)).await;
        let screenshot_d = take_raw_screenshot(client).await?;

        // Diff to find cursor position in C.
        let clusters = match diff_screenshots_for(&screenshot_c, &screenshot_d, &config) {
            Ok(c) => c,
            Err(_) => {
                vlog!("Verify {}: diff failed (exception)", round + 1);
                continue;
            }
        };

        vlog!("Verify {}: {} cluster(s)", round + 1, clusters.len());
        if clusters.len() != 2 {
            vlog!(
                "Verify {}: SKIPPED — wrong cluster count ({}), noisy screen",
                round + 1,
                clusters.len()
            );
            continue;
        }

        // The cursor in screenshot C is the one closer to target.
        let d0 = (clusters[0].centroid_x as f64 - target.x).abs()
            + (clusters[0].centroid_y as f64 - target.y).abs();
        let d1 = (clusters[1].centroid_x as f64 - target.x).abs()
            + (clusters[1].centroid_y as f64 - target.y).abs();
        let cursor_cluster = if d0 < d1 { &clusters[0] } else { &clusters[1] };

        let error_x = (cursor_cluster.centroid_x as f64 - target.x).abs();
        let error_y = (cursor_cluster.centroid_y as f64 - target.y).abs();
        let error = (error_x * error_x + error_y * error_y).sqrt();

        if error <= 20.0 {
            hits += 1;
            vlog!(
                "Verify {}: HIT — cursor=({},{}), error={:.1}px",
                round + 1,
                cursor_cluster.centroid_x,
                cursor_cluster.centroid_y,
                error
            );
        } else {
            misses += 1;
            vlog!(
                "Verify {}: MISS — cursor=({},{}), error={:.1}px",
                round + 1,
                cursor_cluster.centroid_x,
                cursor_cluster.centroid_y,
                error
            );
        }
    }

    let clean_rounds = (hits + misses) as usize;
    let skipped_rounds = config.verify_rounds as i64 - clean_rounds as i64;
    // Confidence based on total attempted rounds, not just clean ones.
    let confidence = if config.verify_rounds > 0 {
        hits as f64 / config.verify_rounds as f64
    } else {
        0.0
    };
    let verification_score = hits - misses;
    vlog!(
        "Verification: {} hits, {} misses, {} skipped out of {} attempted (confidence={:.0}%)",
        hits,
        misses,
        skipped_rounds,
        config.verify_rounds,
        confidence * 100.0
    );

    // Inconclusive if too few clean verify rounds.
    if clean_rounds < config.min_samples {
        // Keep calibration applied (factors may be correct, we just can't
        // verify).
        return Ok(AutoCalibrationResult {
            success: false,
            factor_x,
            factor_y,
            resolution: initial_resolution,
            confidence,
            verification_score,
            valid_samples: samples.len(),
            total_rounds: config.rounds,
            message: format!(
                "Verification inconclusive: only {}/{} minimum clean verify rounds obtained \
                 ({} skipped due to screen noise). \
                 Factors: X={factor_x:.4}, Y={factor_y:.4}. \
                 Calibration reverted. Reduce screen activity and retry, or use pikvm_calibrate.{}",
                clean_rounds,
                config.min_samples,
                skipped_rounds,
                verbose_suffix(&verbose_log)
            ),
        });
    }

    if verification_score > 0 {
        return Ok(AutoCalibrationResult {
            success: true,
            factor_x,
            factor_y,
            resolution: initial_resolution,
            confidence,
            verification_score,
            valid_samples: samples.len(),
            total_rounds: config.rounds,
            message: format!(
                "Auto-calibration successful. \
                 Factors: X={factor_x:.4}, Y={factor_y:.4}. \
                 Verification: {hits}/{} hits ({:.0}% accuracy).{}",
                config.verify_rounds,
                confidence * 100.0,
                verbose_suffix(&verbose_log)
            ),
        });
    }

    // Verification failed — revert.
    client.clear_calibration();
    Ok(AutoCalibrationResult {
        success: false,
        factor_x,
        factor_y,
        resolution: initial_resolution,
        confidence,
        verification_score,
        valid_samples: samples.len(),
        total_rounds: config.rounds,
        message: format!(
            "Auto-calibration verification failed (score: {verification_score}). \
             Factors were: X={factor_x:.4}, Y={factor_y:.4}. \
             Calibration reverted. Try manual calibration with pikvm_calibrate instead.{}",
            verbose_suffix(&verbose_log)
        ),
    })
}

/// Run auto-calibration with retries.
pub async fn auto_calibrate_with_retries(
    client: &PiKVMClient,
    config: AutoCalibrationConfig,
) -> anyhow::Result<AutoCalibrationResult> {
    let mut config = config;
    let max_retries = config.max_retries;

    for attempt in 0..=max_retries {
        let result = auto_calibrate(client, config).await?;
        if result.success {
            return Ok(result);
        }
        // On last attempt, return the failure.
        if attempt == max_retries {
            return Ok(result);
        }
        // Increase move delay for retries (slow capture might be the issue).
        config.move_delay_ms = (config.move_delay_ms + 100).min(800);
    }

    unreachable!("loop always returns on its last iteration (attempt == max_retries)")
}

#[cfg(test)]
mod tests;
