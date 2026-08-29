//! `moveToPixel`'s own body for the non-`curve-one-shot` strategies
//! (`detect-then-move`/`slam-then-move`/`assume-at`): calibration probe,
//! open-loop emission, the open-loop landing cascade
//! (motion→template→shape→predicted), the correction-pass loop (gross +
//! linear regimes, blind-pass circuit breaker, oscillation guard,
//! icon-tolerance exit, linear bailout), bail-to-best-pass, the V8
//! authoritative fallback, result-message assembly.
//!
//! Faithful port of `moveToPixel` (`src/pikvm/move-to.ts` lines
//! 1467-2711, minus the `strategy==='curve-one-shot'` early dispatch —
//! that lives in `move_to.rs`'s root, delegating to `curve_mover`). Kept
//! as ONE function per `docs/rust-port-plan.md` v17: the correction loop
//! and the open-loop cascade preceding it read/mutate ~15 shared local
//! variables across one continuous sequence — splitting further would
//! relocate that coupling across files, not reduce it.
//!
//! **Deliberately scoped out** (v13): the `PIKVM_USE_LEARNED_BALLISTICS`
//! opt-in forward-model path (`learnedBallisticsEnabled`/
//! `learnedBallisticsPxPerMickey`, move-to.ts lines 78-171) — off by
//! default, gated behind a model file this repo doesn't bundle,
//! `pointer_accel_bridge.rs` not yet built. When present, this replaces
//! the constant `fallback`/profile-lookup ratio before the open-loop
//! plan; its absence here means that env var is currently a no-op on
//! this path (same behavior as the profile/fallback path with the flag
//! unset). Faithful-port discipline still applies eventually — this is
//! an individually-justified, documented gap, not a silent drop.
//!
//! **Dropped as dead code** (confirmed via grep of the full TS
//! function): `warmupMickeys` (move-to.ts:1521, assigned, never read
//! again) and an early `predicted` local (move-to.ts:1661, computed
//! then immediately shadowed in effect by `predictedPostOpen` — never
//! itself read). Neither omission changes behavior.

use std::sync::Arc;

use pikvm_mcp_cursor_belief::Point as BeliefPoint;
use pikvm_mcp_detection_vision::cursor_detect::{
    decode_screenshot, find_cursor_by_template_set, FindCursorOptions, Point as DetPoint,
};
use pikvm_mcp_detection_vision::cursor_ml_detect::{
    build_ml_hints, find_cursor_by_ml_multi_hint, find_cursor_by_v8_full_frame, MlMultiHintOptions,
    V8FullFrameOptions,
};
use pikvm_mcp_detection_vision::cursor_shape_detect::{find_cursor_by_shape, ShapeOptions};
use pikvm_mcp_detection_vision::orientation::get_last_good_bounds;
use pikvm_mcp_detection_vision::template_set::DEFAULT_TEMPLATE_DIR;
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::ballistics::take_raw_screenshot;
use crate::gesture::emit_chunked;

use super::correction_math::{
    cap_correction_mickeys, clamp, clamp_mickeys_to_screen, is_stale_template_match,
    pick_bail_pass, should_abort_blind_corrections, DEFAULT_CLAMP_MARGIN,
};
use super::motion_diff::detect_motion;
use super::origin::discover_origin;
use super::template_cache::{get_cached_templates, maybe_persist_template};
use super::types::{
    CorrectionPass, DetectionMode, MovePassDiagnostic, MoveStrategy, MoveToOptions, MoveToResult,
    Point,
};
use super::wiggle_verify::{ml_wiggle_verify, try_open_loop_shape_detect, wiggle_verify_candidate};

/// Phase 317 tautology threshold — `move-to.ts:692` = 30. Shared with
/// `origin.rs`'s own copy (same TS module-level constant, used by two
/// different functions in the source file); duplicated rather than
/// hoisted to `types.rs` because it's a single `f64` literal with no
/// other shared meaning — the duplication IS the faithful mirror of the
/// TS shape, not drift risk (both sites cite the same TS line).
const TAUTOLOGY_PROX_THRESHOLD: f64 = 30.0;

fn dist(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    (ax - bx).hypot(ay - by)
}

fn mode_str(m: DetectionMode) -> &'static str {
    match m {
        DetectionMode::Motion => "motion",
        DetectionMode::Template => "template",
        DetectionMode::Predicted => "predicted",
        DetectionMode::Shape => "shape",
    }
}

/// Faithful port of `moveToPixel`'s legacy (non-`curve-one-shot`) body.
// `unused_assignments`: the oscillation-guard branch assigns `current_pos`
// immediately before its own `break` — dead by the time control leaves
// the loop (only `final_detected_position` is read afterward), same as
// TS's own `currentPos = {...}; finalDetectedPosition = {...}; break;`
// pair at that spot. Kept for 1:1 fidelity with the source rather than
// dropped.
#[allow(clippy::too_many_lines, unused_assignments)]
pub(super) async fn move_to_pixel_legacy(
    client: &Arc<PiKVMClient>,
    target: Point,
    options: &MoveToOptions,
) -> anyhow::Result<MoveToResult> {
    let resolution = client.get_resolution(true).await?;
    let resolved = super::resolved_options::resolve_options(options, resolution);
    let verbose = resolved.verbose;

    let target_x = clamp(
        target.x.round(),
        0.0,
        (resolution.width as f64 - 1.0).max(0.0),
    );
    let target_y = clamp(
        target.y.round(),
        0.0,
        (resolution.height as f64 - 1.0).max(0.0),
    );

    // 1. Origin discovery.
    let discovered = discover_origin(client, options).await?;
    let origin = discovered.point;
    let actual_strategy = discovered.method;

    // Phase 192-C: feed bounds + origin into the cursor belief.
    // discoverOrigin's return is our most-trusted cursor position at
    // this point — slam landed it at a known corner, or
    // locateCursor/template-match measured it. Push it as a high-
    // confidence reset so subsequent predict()s start from truth.
    if let Some(b) = get_last_good_bounds() {
        client.set_belief_bounds(Some(pikvm_mcp_cursor_belief::Bounds {
            x: b.x as f64,
            y: b.y as f64,
            width: b.width as f64,
            height: b.height as f64,
        }));
    }
    client.reset_belief(BeliefPoint {
        x: origin.x,
        y: origin.y,
    });

    let dx_px = target_x - origin.x;
    let dy_px = target_y - origin.y;
    let raw_mickeys_x = (dx_px.abs() / resolved.px_per_mickey_x).round();
    let raw_mickeys_y = (dy_px.abs() / resolved.px_per_mickey_y).round();
    let sign_x = if dx_px >= 0.0 { 1.0 } else { -1.0 };
    let sign_y = if dy_px >= 0.0 { 1.0 } else { -1.0 };
    let _ = (raw_mickeys_x, sign_x, raw_mickeys_y, sign_y); // superseded by the post-calibration replan below (TS's own `predicted` local — dead, see module doc)

    // 2. Calibration probe — measure iPadOS effective px/mickey ratio
    //    fresh BEFORE the open-loop emission.
    let calib_probe_mickeys = options.calibration_probe_mickeys.unwrap_or(40.0);
    let warmup_axis_is_x = dx_px.abs() >= dy_px.abs();
    let warmup_sign = if warmup_axis_is_x { sign_x } else { sign_y };

    let mut calibrated_ratio_x = resolved.px_per_mickey_x;
    let mut calibrated_ratio_y = resolved.px_per_mickey_y;

    // Phase 14: when discoverOrigin used the locateCursor X-axis probe,
    // it already measured the X px/mickey ratio for free.
    let mut skip_calibration_probe = false;
    if let Some(m) = &discovered.probe_measurement {
        if m.mickeys.x != 0.0 {
            let r = m.offset_px.x.abs() / m.mickeys.x.abs();
            if r >= resolved.ratio_clamp_lo && r <= resolved.ratio_clamp_hi {
                calibrated_ratio_x = r;
                if warmup_axis_is_x {
                    calibrated_ratio_y = r; // symmetric guess for the small Y leg
                    skip_calibration_probe = true;
                }
                if verbose {
                    eprintln!(
                        "[move-to] CALIBRATION X ratio from probe: {r:.3}; {}",
                        if warmup_axis_is_x {
                            "skip redundant calibration probe".to_string()
                        } else {
                            "still need Y probe (move is Y-dominant)".to_string()
                        }
                    );
                }
            }
        }
    }

    // Phase 2 + 3: fetch the cached cursor template SET once.
    let session_templates = get_cached_templates(DEFAULT_TEMPLATE_DIR).await;

    // shotA-pre captured BEFORE the calibration probe; shotA captured AFTER.
    let shot_a_pre = decode_screenshot(&take_raw_screenshot(client).await?)?;

    let calib_x = if skip_calibration_probe || !warmup_axis_is_x {
        0.0
    } else {
        calib_probe_mickeys * warmup_sign
    };
    let calib_y = if skip_calibration_probe || warmup_axis_is_x {
        0.0
    } else {
        calib_probe_mickeys * warmup_sign
    };
    if (calib_x != 0.0 || calib_y != 0.0) && calib_probe_mickeys > 0.0 {
        emit_chunked(client, calib_x, calib_y, 20.0, 30).await?;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }

    // 3. Screenshot A — captured AFTER calibration probe.
    let shot_a = decode_screenshot(&take_raw_screenshot(client).await?)?;

    let calib_expected_end = (
        origin.x + calib_x * resolved.px_per_mickey_x,
        origin.y + calib_y * resolved.px_per_mickey_y,
    );

    if !skip_calibration_probe && calib_probe_mickeys > 0.0 && resolved.do_correct {
        let calib_result = detect_motion(
            &shot_a_pre,
            &shot_a,
            (origin.x, origin.y),
            calib_expected_end,
            (calib_x, calib_y),
            resolved.pre_window,
            resolved.post_window.max(200.0),
            verbose,
            super::resolved_options::CLUSTER_MIN_PX as usize,
            super::resolved_options::CLUSTER_MAX_PX as usize,
            100,
            true,
            &session_templates,
        )?;
        if let Some(pair) = &calib_result.pair {
            let measured = pair.live_px_per_mickey;
            if measured >= resolved.ratio_clamp_lo && measured <= resolved.ratio_clamp_hi {
                if warmup_axis_is_x {
                    calibrated_ratio_y = measured;
                } else {
                    calibrated_ratio_x = measured;
                }
                if warmup_axis_is_x {
                    calibrated_ratio_x = measured;
                } else {
                    calibrated_ratio_y = measured;
                }
                if verbose {
                    eprintln!(
                        "[move-to] CALIBRATION: {calib_probe_mickeys}-mickey {} probe measured ratio={measured:.3} (was using fallback {})",
                        if warmup_axis_is_x { "x" } else { "y" },
                        resolved.fallback_px_per_mickey,
                    );
                }
            }
        }
    }

    // Re-plan open-loop using calibrated ratio.
    let dx_px_now = target_x - (origin.x + calib_x * calibrated_ratio_x);
    let dy_px_now = target_y - (origin.y + calib_y * calibrated_ratio_y);
    let plan_ratio_x = calibrated_ratio_x;
    let plan_ratio_y = calibrated_ratio_y;
    let raw_mickeys_x_now = (dx_px_now.abs() / plan_ratio_x).round();
    let raw_mickeys_y_now = (dy_px_now.abs() / plan_ratio_y).round();
    let sign_x_now = if dx_px_now >= 0.0 { 1.0 } else { -1.0 };
    let sign_y_now = if dy_px_now >= 0.0 { 1.0 } else { -1.0 };

    let post_calib_pos = (
        origin.x + calib_x * calibrated_ratio_x,
        origin.y + calib_y * calibrated_ratio_y,
    );
    // Phase 6: clamp open-loop to keep projected cursor landing inside
    // the screen.
    let clamped_open = clamp_mickeys_to_screen(
        post_calib_pos,
        sign_x_now * raw_mickeys_x_now,
        sign_y_now * raw_mickeys_y_now,
        plan_ratio_x,
        plan_ratio_y,
        (resolution.width as f64, resolution.height as f64),
        DEFAULT_CLAMP_MARGIN,
    );
    // Phase 22: progressiveOpenLoop zeros the open-loop emit so the
    // correction loop carries the entire move via small chunks.
    let open_mickeys_x = if options.progressive_open_loop {
        0.0
    } else {
        clamped_open.0
    };
    let open_mickeys_y = if options.progressive_open_loop {
        0.0
    } else {
        clamped_open.1
    };
    let predicted_post_open = (
        post_calib_pos.0 + open_mickeys_x * plan_ratio_x,
        post_calib_pos.1 + open_mickeys_y * plan_ratio_y,
    );

    let post_warmup_expected = post_calib_pos;

    if verbose
        && (open_mickeys_x != sign_x_now * raw_mickeys_x_now
            || open_mickeys_y != sign_y_now * raw_mickeys_y_now)
    {
        eprintln!(
            "[move-to] open-loop CLAMPED to keep cursor on-screen: ({},{}) -> ({open_mickeys_x},{open_mickeys_y})",
            sign_x_now * raw_mickeys_x_now,
            sign_y_now * raw_mickeys_y_now,
        );
    }

    // 4. Open-loop emission.
    let chunk_count = emit_chunked(
        client,
        open_mickeys_x,
        open_mickeys_y,
        resolved.chunk_magnitude,
        resolved.chunk_pace_ms,
    )
    .await?;

    if resolved.post_move_settle_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(
            resolved.post_move_settle_ms,
        ))
        .await;
    }

    // 5. Screenshot B.
    let shot_b = decode_screenshot(&take_raw_screenshot(client).await?)?;

    // 6. Motion diff (open-loop).
    let mut corrections: Vec<CorrectionPass> = Vec::new();
    let mut diagnostics: Vec<MovePassDiagnostic> = Vec::new();
    let mut final_detected_position: Option<Point> = None;
    let mut observed_ratio_x = calibrated_ratio_x;
    let mut observed_ratio_y = calibrated_ratio_y;
    let mut current_pos: (f64, f64);
    let open_loop_mode: DetectionMode;
    let open_loop_reason: Option<String>;
    let mut passes_since_last_verification: u32;

    let debug_dir = &options.debug_dir;
    if let Some(dir) = debug_dir {
        tokio::fs::create_dir_all(dir).await?;
        tokio::fs::write(dir.join("01-shotAPre-preCalib.jpg"), &shot_a_pre.buffer).await?;
        tokio::fs::write(dir.join("02-shotA-postCalib.jpg"), &shot_a.buffer).await?;
        tokio::fs::write(dir.join("03-shotB-postOpenLoop.jpg"), &shot_b.buffer).await?;
        let meta = format!(
            "Target: ({target_x},{target_y})\n\
             Origin (claimed): ({},{}) via {actual_strategy:?}\n\
             Calibration probe: {calib_x} X, {calib_y} Y mickeys\n\
             Open-loop emit: {open_mickeys_x} X, {open_mickeys_y} Y mickeys\n\
             Plan ratio: ({plan_ratio_x:.3}, {plan_ratio_y:.3})\n\
             Predicted post-open-loop: ({},{})\n",
            origin.x.round(),
            origin.y.round(),
            predicted_post_open.0.round(),
            predicted_post_open.1.round(),
        );
        tokio::fs::write(dir.join("META.txt"), meta).await?;
    }

    let motion_result = if resolved.do_correct {
        Some(detect_motion(
            &shot_a,
            &shot_b,
            post_warmup_expected,
            predicted_post_open,
            (open_mickeys_x, open_mickeys_y),
            resolved.pre_window,
            resolved.post_window,
            verbose,
            super::resolved_options::CLUSTER_MIN_PX as usize,
            super::resolved_options::CLUSTER_MAX_PX as usize,
            100,
            true,
            &session_templates,
        )?)
    } else {
        None
    };

    // Phase 212/213: reject a motion-diff pair that lands on a static
    // feature already observed at the same spot.
    let open_motion_rejected_as_stationary = motion_result
        .as_ref()
        .and_then(|r| r.pair.as_ref())
        .map(|p| {
            client.would_reject_as_stationary(
                BeliefPoint {
                    x: p.post.centroid_x as f64,
                    y: p.post.centroid_y as f64,
                },
                None,
            )
        })
        .unwrap_or(false);

    if let Some(pair) = motion_result
        .as_ref()
        .and_then(|r| r.pair.as_ref())
        .filter(|_| !open_motion_rejected_as_stationary)
    {
        current_pos = (pair.post.centroid_x as f64, pair.post.centroid_y as f64);
        if open_mickeys_x.abs() > open_mickeys_y.abs() {
            observed_ratio_x = pair.displacement.0.abs() / open_mickeys_x.abs().max(1.0);
        } else {
            observed_ratio_y = pair.displacement.1.abs() / open_mickeys_y.abs().max(1.0);
        }
        if observed_ratio_x < resolved.ratio_clamp_lo || observed_ratio_x > resolved.ratio_clamp_hi
        {
            observed_ratio_x = resolved.fallback_px_per_mickey;
        }
        if observed_ratio_y < resolved.ratio_clamp_lo || observed_ratio_y > resolved.ratio_clamp_hi
        {
            observed_ratio_y = resolved.fallback_px_per_mickey;
        }
        final_detected_position = Some(Point {
            x: current_pos.0,
            y: current_pos.1,
        });
        open_loop_mode = DetectionMode::Motion;
        open_loop_reason = Some(format!("live ratio {:.3}", pair.live_px_per_mickey));
        client.observe_cursor(
            BeliefPoint {
                x: current_pos.0,
                y: current_pos.1,
            },
            0.85,
            None,
        );
        maybe_persist_template(
            DEFAULT_TEMPLATE_DIR,
            &shot_b,
            DetPoint {
                x: current_pos.0,
                y: current_pos.1,
            },
            Some(&shot_a),
        )
        .await;
    } else {
        let motion_fail_reason = if open_motion_rejected_as_stationary {
            "static-feature cluster lock-in (Phase 213, open-loop)".to_string()
        } else {
            motion_result
                .as_ref()
                .and_then(|r| r.reason.clone())
                .unwrap_or_else(|| "correction disabled".to_string())
        };
        if verbose && resolved.do_correct {
            eprintln!("[move-to] motion-diff returned null: {motion_fail_reason}");
        }
        if !session_templates.is_empty() {
            let found = find_cursor_by_template_set(
                &shot_b,
                &session_templates,
                &FindCursorOptions {
                    search_centre: Some(DetPoint {
                        x: predicted_post_open.0,
                        y: predicted_post_open.1,
                    }),
                    search_window: Some(resolved.post_window),
                    expected_near: Some(DetPoint {
                        x: predicted_post_open.0,
                        y: predicted_post_open.1,
                    }),
                    expected_near_radius: Some(200.0),
                    require_within_radius: true,
                    top_k: options.top_k.map(|k| k as usize),
                    verbose,
                    ..Default::default()
                },
            );
            if let Some(found) = found {
                current_pos = (found.position.x, found.position.y);
                final_detected_position = Some(Point {
                    x: current_pos.0,
                    y: current_pos.1,
                });
                open_loop_mode = DetectionMode::Template;
                open_loop_reason = Some(format!(
                    "template-match score={:.3} tpl#{}/{} (motion: {motion_fail_reason})",
                    found.score,
                    found.template_index,
                    session_templates.len(),
                ));
                client.observe_cursor(
                    BeliefPoint {
                        x: current_pos.0,
                        y: current_pos.1,
                    },
                    found.score,
                    None,
                );
            } else if let Some(shape) = try_open_loop_shape_detect(
                client.clone(),
                super::origin::make_locator_deps(client.clone()),
                clone_decoded(&shot_b),
                predicted_post_open,
            )
            .await
            {
                current_pos = shape.pos;
                open_loop_mode = DetectionMode::Shape;
                open_loop_reason = Some(format!(
                    "shape score={:.3} prox={:.0} (motion: {motion_fail_reason}, template: null)",
                    shape.score, shape.prox,
                ));
                client.observe_cursor(
                    BeliefPoint {
                        x: current_pos.0,
                        y: current_pos.1,
                    },
                    (shape.score * 5.0).clamp(0.3, 0.9),
                    None,
                );
                final_detected_position = Some(Point {
                    x: current_pos.0,
                    y: current_pos.1,
                });
            } else {
                current_pos = predicted_post_open;
                open_loop_mode = DetectionMode::Predicted;
                open_loop_reason = Some(format!(
                    "template-match below threshold across {} templates (motion: {motion_fail_reason})",
                    session_templates.len(),
                ));
            }
        } else if let Some(shape) = try_open_loop_shape_detect(
            client.clone(),
            super::origin::make_locator_deps(client.clone()),
            clone_decoded(&shot_b),
            predicted_post_open,
        )
        .await
        {
            current_pos = shape.pos;
            open_loop_mode = DetectionMode::Shape;
            open_loop_reason = Some(format!(
                "shape score={:.3} prox={:.0} (motion: {motion_fail_reason}, no templates)",
                shape.score, shape.prox,
            ));
            client.observe_cursor(
                BeliefPoint {
                    x: current_pos.0,
                    y: current_pos.1,
                },
                (shape.score * 5.0).clamp(0.3, 0.9),
                None,
            );
            final_detected_position = Some(Point {
                x: current_pos.0,
                y: current_pos.1,
            });
        } else {
            current_pos = predicted_post_open;
            open_loop_mode = DetectionMode::Predicted;
            open_loop_reason = Some(format!("no template cached (motion: {motion_fail_reason})"));
        }
    }

    // Phase 24: open-loop is the first thing that could verify the cursor.
    passes_since_last_verification = if open_loop_mode == DetectionMode::Predicted {
        1
    } else {
        0
    };

    let mut last_template_match: Option<(f64, f64)> = if open_loop_mode == DetectionMode::Template {
        Some(current_pos)
    } else {
        None
    };

    diagnostics.push(MovePassDiagnostic {
        pass: 0,
        mode: open_loop_mode,
        detected_at: Point {
            x: current_pos.0,
            y: current_pos.1,
        },
        residual_px: dist(current_pos.0, current_pos.1, target_x, target_y),
        ratio_used: (observed_ratio_x, observed_ratio_y),
        reason: open_loop_reason,
        linear_phase: false,
    });

    // 7. Correction passes.
    let mut prev_shot = shot_b;
    let mut prev_pos = current_pos;
    let mut linear_entered = false;
    let mut total_passes: u32 = 0;

    if resolved.do_correct {
        let mut gross_passes_used: u32 = 0;
        let mut linear_passes_used: u32 = 0;

        'correction: loop {
            let err_x = target_x - current_pos.0;
            let err_y = target_y - current_pos.1;
            let residual = err_x.hypot(err_y);

            // Phase 29 follow-up: icon-tolerance early exit.
            if resolved.icon_tolerance_residual_px > 0.0
                && residual <= resolved.icon_tolerance_residual_px
                && passes_since_last_verification == 0
                && final_detected_position.is_some()
            {
                if verbose {
                    eprintln!(
                        "[move-to] ICON-TOLERANCE EXIT: verified residual {residual:.1}px <= {}px tolerance",
                        resolved.icon_tolerance_residual_px,
                    );
                }
                break 'correction;
            }

            let use_linear = residual <= resolved.linear_trigger_residual_px;
            let pass_limit = if use_linear {
                resolved.linear_max_passes
            } else {
                resolved.max_correction_passes
            };
            let pass_used = if use_linear {
                linear_passes_used
            } else {
                gross_passes_used
            };
            let stop_px = if use_linear {
                resolved.linear_residual_px
            } else {
                resolved.min_residual_px
            };
            let used_chunk_mag = if use_linear {
                resolved.linear_chunk_magnitude
            } else {
                resolved.chunk_magnitude
            };
            let used_chunk_pace_ms = if use_linear {
                resolved.linear_chunk_pace_ms
            } else {
                resolved.chunk_pace_ms
            };

            if residual < stop_px {
                if verbose {
                    eprintln!(
                        "[move-to] pass {total_passes}: residual {residual:.1}px within {} tolerance {stop_px}px; done.",
                        if use_linear { "linear" } else { "gross" },
                    );
                }
                break 'correction;
            }
            if pass_used >= pass_limit {
                if verbose {
                    eprintln!(
                        "[move-to] {} pass budget exhausted at {pass_limit}; remaining residual {residual:.1}px",
                        if use_linear { "linear" } else { "gross" },
                    );
                }
                break 'correction;
            }

            if use_linear && !linear_entered {
                linear_entered = true;
                if verbose {
                    eprintln!(
                        "[move-to] entering LINEAR phase: residual={residual:.1}px <= {}px",
                        resolved.linear_trigger_residual_px,
                    );
                }
            }

            let raw_corr_x = (err_x / observed_ratio_x).round();
            let raw_corr_y = (err_y / observed_ratio_y).round();
            let correction_cap = if use_linear {
                options.linear_correction_cap.unwrap_or(25.0)
            } else {
                80.0
            };
            let (corr_mickeys_x, corr_mickeys_y) =
                cap_correction_mickeys(raw_corr_x, raw_corr_y, correction_cap);
            if corr_mickeys_x == 0.0 && corr_mickeys_y == 0.0 {
                if verbose {
                    eprintln!(
                        "[move-to] pass {}: zero-mickey correction; cannot improve further.",
                        total_passes + 1
                    );
                }
                break 'correction;
            }

            let new_predicted = (
                current_pos.0 + corr_mickeys_x * observed_ratio_x,
                current_pos.1 + corr_mickeys_y * observed_ratio_y,
            );

            if verbose {
                eprintln!(
                    "[move-to] {} pass {}: err=({err_x:.1},{err_y:.1}) -> mickeys=({corr_mickeys_x},{corr_mickeys_y}) @ ratio=({observed_ratio_x:.3},{observed_ratio_y:.3})",
                    if use_linear { "linear" } else { "gross" },
                    total_passes + 1,
                );
            }

            emit_chunked(
                client,
                corr_mickeys_x,
                corr_mickeys_y,
                used_chunk_mag,
                used_chunk_pace_ms,
            )
            .await?;
            tokio::time::sleep(std::time::Duration::from_millis(
                resolved.post_move_settle_ms,
            ))
            .await;
            let shot_c = decode_screenshot(&take_raw_screenshot(client).await?)?;
            if let Some(dir) = debug_dir {
                let tag = format!("{:02}", total_passes + 1);
                let phase_tag = if use_linear { "L" } else { "G" };
                tokio::fs::write(
                    dir.join(format!("{tag}-{phase_tag}-pass-shotC.jpg")),
                    &shot_c.buffer,
                )
                .await?;
            }

            let c_result = detect_motion(
                &prev_shot,
                &shot_c,
                prev_pos,
                new_predicted,
                (corr_mickeys_x, corr_mickeys_y),
                resolved.pre_window,
                resolved.post_window,
                verbose,
                super::resolved_options::CLUSTER_MIN_PX as usize,
                super::resolved_options::CLUSTER_MAX_PX as usize,
                100,
                true,
                &session_templates,
            )?;

            let mut pass_mode = DetectionMode::Predicted;
            let mut pass_reason: Option<String> = None;

            let motion_rejected_as_stationary = c_result
                .pair
                .as_ref()
                .map(|p| {
                    client.would_reject_as_stationary(
                        BeliefPoint {
                            x: p.post.centroid_x as f64,
                            y: p.post.centroid_y as f64,
                        },
                        None,
                    )
                })
                .unwrap_or(false);

            if let Some(c_motion) = c_result
                .pair
                .as_ref()
                .filter(|_| !motion_rejected_as_stationary)
            {
                current_pos = (
                    c_motion.post.centroid_x as f64,
                    c_motion.post.centroid_y as f64,
                );
                if corr_mickeys_x.abs() > corr_mickeys_y.abs() {
                    let r = c_motion.displacement.0.abs() / corr_mickeys_x.abs().max(1.0);
                    if r >= resolved.ratio_clamp_lo && r <= resolved.ratio_clamp_hi {
                        observed_ratio_x = r;
                    }
                } else {
                    let r = c_motion.displacement.1.abs() / corr_mickeys_y.abs().max(1.0);
                    if r >= resolved.ratio_clamp_lo && r <= resolved.ratio_clamp_hi {
                        observed_ratio_y = r;
                    }
                }
                final_detected_position = Some(Point {
                    x: current_pos.0,
                    y: current_pos.1,
                });
                pass_mode = DetectionMode::Motion;
                pass_reason = Some(format!("live ratio {:.3}", c_motion.live_px_per_mickey));
                client.observe_cursor(
                    BeliefPoint {
                        x: current_pos.0,
                        y: current_pos.1,
                    },
                    0.85,
                    None,
                );
            } else {
                let motion_fail_reason = if motion_rejected_as_stationary {
                    "static-feature cluster lock-in (Phase 212)".to_string()
                } else {
                    c_result
                        .reason
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string())
                };
                let mut templated = false;
                if !session_templates.is_empty() {
                    let found = find_cursor_by_template_set(
                        &shot_c,
                        &session_templates,
                        &FindCursorOptions {
                            search_centre: Some(DetPoint {
                                x: new_predicted.0,
                                y: new_predicted.1,
                            }),
                            search_window: Some(resolved.post_window),
                            expected_near: Some(DetPoint {
                                x: prev_pos.0,
                                y: prev_pos.1,
                            }),
                            expected_near_radius: Some(150.0),
                            min_score: Some(0.88),
                            require_within_radius: true,
                            top_k: options.top_k.map(|k| k as usize),
                            verbose,
                            ..Default::default()
                        },
                    );
                    if let Some(found) = found {
                        let emitted_mag = corr_mickeys_x.hypot(corr_mickeys_y);
                        let found_pos = (found.position.x, found.position.y);
                        if is_stale_template_match(found_pos, last_template_match, emitted_mag) {
                            if verbose {
                                eprintln!(
                                    "[move-to] WARN pass {}: template-match returned stale position ({},{}) after {emitted_mag:.0} mickeys emitted — rejecting",
                                    total_passes + 1, found_pos.0, found_pos.1,
                                );
                            }
                            pass_mode = DetectionMode::Predicted;
                            pass_reason = Some(format!(
                                "template-match stale at ({},{}) after {emitted_mag:.0} mickeys",
                                found_pos.0, found_pos.1,
                            ));
                            current_pos = new_predicted;
                            templated = true;
                        } else {
                            current_pos = found_pos;
                            final_detected_position = Some(Point {
                                x: current_pos.0,
                                y: current_pos.1,
                            });
                            last_template_match = Some(found_pos);
                            pass_mode = DetectionMode::Template;
                            pass_reason = Some(format!(
                                "template score={:.3} (motion: {motion_fail_reason})",
                                found.score,
                            ));
                            templated = true;
                            client.observe_cursor(
                                BeliefPoint {
                                    x: current_pos.0,
                                    y: current_pos.1,
                                },
                                found.score,
                                None,
                            );
                        }
                    }
                }
                if !templated {
                    // Phase 267/299: shape-detector + ML fallback when
                    // both motion-diff and NCC template-match failed.
                    // Best-effort — any failure here falls through to
                    // predicted, matching TS's `catch { /* fall through */ }`.
                    if let Ok(shape_shot_raw) = client.screenshot_keeping_cursor_alive(None).await {
                        if let Ok(shape_dec) = decode_screenshot(&shape_shot_raw.buffer) {
                            let belief_pos = {
                                let belief = *client.belief.lock().unwrap();
                                Some(DetPoint {
                                    x: belief.position.x,
                                    y: belief.position.y,
                                })
                            };
                            let correction_hints = build_ml_hints(
                                DetPoint {
                                    x: new_predicted.0,
                                    y: new_predicted.1,
                                },
                                shape_dec.width as f64,
                                shape_dec.height as f64,
                                belief_pos,
                            );
                            let ml_correction_raw = find_cursor_by_ml_multi_hint(
                                &shape_dec.buffer,
                                shape_dec.width,
                                shape_dec.height,
                                &correction_hints,
                                MlMultiHintOptions {
                                    min_confidence: Some(0.5),
                                },
                            )
                            .unwrap_or(None);
                            let correction_prox = ml_correction_raw
                                .map(|m| dist(m.x, m.y, new_predicted.0, new_predicted.1))
                                .unwrap_or(f64::INFINITY);
                            let ml_correction = if let Some(raw) = ml_correction_raw {
                                if correction_prox <= TAUTOLOGY_PROX_THRESHOLD {
                                    ml_wiggle_verify(client.clone(), raw).await
                                } else {
                                    Some(raw)
                                }
                            } else {
                                None
                            };
                            if let Some(ml) = ml_correction {
                                let prox = dist(ml.x, ml.y, new_predicted.0, new_predicted.1);
                                current_pos = (ml.x, ml.y);
                                final_detected_position = Some(Point {
                                    x: current_pos.0,
                                    y: current_pos.1,
                                });
                                pass_mode = DetectionMode::Shape;
                                pass_reason = Some(format!(
                                    "ML conf={:.3} prox={prox:.0} wiggle-verified (motion: {motion_fail_reason}, template: null)",
                                    ml.confidence,
                                ));
                                templated = true;
                                client.observe_cursor(
                                    BeliefPoint {
                                        x: current_pos.0,
                                        y: current_pos.1,
                                    },
                                    ml.confidence,
                                    None,
                                );
                                if verbose {
                                    eprintln!(
                                        "[move-to] correction pass {}: ML recovered cursor at ({},{}) conf={:.3} prox={prox:.0}",
                                        total_passes + 1, current_pos.0, current_pos.1, ml.confidence,
                                    );
                                }
                                // N1 (Round 2 Phase 5) fix: NO early `break`
                                // here. `templated = true` already guards
                                // the fall-through to the shared pass-
                                // completion bookkeeping below (corrections/
                                // diagnostics push, circuit breaker,
                                // oscillation guard) — see
                                // move-to.correctionCascade.test.ts and this
                                // file's own doc comment. A prior TS commit
                                // (0456943) put an unscoped `break` here that
                                // exited the ENTIRE outer correction loop,
                                // skipping that bookkeeping for every
                                // ML-recovered pass; confirmed a genuine bug
                                // via git archaeology, fixed by deleting it.
                                // Not reproduced here in the first place.
                            }

                            if !templated {
                                let proximate = |p: (f64, f64)| {
                                    dist(p.0, p.1, new_predicted.0, new_predicted.1)
                                };
                                let dark = find_cursor_by_shape(
                                    &shape_dec.rgb,
                                    shape_dec.width,
                                    shape_dec.height,
                                    &ShapeOptions {
                                        expected_near: Some(DetPoint {
                                            x: new_predicted.0,
                                            y: new_predicted.1,
                                        }),
                                        expected_near_radius: Some(100.0),
                                        ..Default::default()
                                    },
                                );
                                let bright = find_cursor_by_shape(
                                    &shape_dec.rgb,
                                    shape_dec.width,
                                    shape_dec.height,
                                    &ShapeOptions {
                                        expected_near: Some(DetPoint {
                                            x: new_predicted.0,
                                            y: new_predicted.1,
                                        }),
                                        expected_near_radius: Some(100.0),
                                        bright_threshold: Some(120),
                                        ..Default::default()
                                    },
                                );
                                struct Cand {
                                    pos: (f64, f64),
                                    score: f64,
                                    prox: f64,
                                    source: &'static str,
                                }
                                let mut cands: Vec<Cand> = Vec::new();
                                if let Some(d) = dark {
                                    let pos = (d.centroid_x as f64, d.centroid_y as f64);
                                    let prox = proximate(pos);
                                    if d.shape_score >= 0.05 || prox <= 30.0 {
                                        cands.push(Cand {
                                            pos,
                                            score: d.shape_score,
                                            prox,
                                            source: "dark",
                                        });
                                    }
                                }
                                if let Some(b) = bright {
                                    let pos = (b.centroid_x as f64, b.centroid_y as f64);
                                    let prox = proximate(pos);
                                    let same_as_dark = cands
                                        .iter()
                                        .any(|c| dist(c.pos.0, c.pos.1, pos.0, pos.1) <= 5.0);
                                    if !same_as_dark && (b.shape_score >= 0.05 || prox <= 30.0) {
                                        cands.push(Cand {
                                            pos,
                                            score: b.shape_score,
                                            prox,
                                            source: "bright",
                                        });
                                    }
                                }
                                cands.sort_by(|a, b| b.score.total_cmp(&a.score));
                                for c in &cands {
                                    if let Some(verified) = wiggle_verify_candidate(
                                        client.clone(),
                                        observed_ratio_x,
                                        observed_ratio_y,
                                        c.pos,
                                        c.score,
                                    )
                                    .await
                                    {
                                        current_pos = verified.pos;
                                        final_detected_position = Some(Point {
                                            x: current_pos.0,
                                            y: current_pos.1,
                                        });
                                        pass_mode = DetectionMode::Shape;
                                        pass_reason = Some(format!(
                                            "shape+wiggle ({}) score={:.3} prox={:.0} (motion: {motion_fail_reason}, template: null)",
                                            c.source, c.score, c.prox,
                                        ));
                                        templated = true;
                                        client.observe_cursor(
                                            BeliefPoint {
                                                x: current_pos.0,
                                                y: current_pos.1,
                                            },
                                            (c.score * 5.0).clamp(0.3, 0.9),
                                            None,
                                        );
                                        if verbose {
                                            eprintln!(
                                                "[move-to] pass {}: shape-detect+wiggle ({}) recovered cursor at ({},{}) score={:.3} prox={:.0}",
                                                total_passes + 1, c.source, current_pos.0, current_pos.1, c.score, c.prox,
                                            );
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                if !templated {
                    current_pos = new_predicted;
                    pass_mode = DetectionMode::Predicted;
                    pass_reason = Some(format!(
                        "motion: {motion_fail_reason}; no template fallback"
                    ));
                    if verbose {
                        eprintln!(
                            "[move-to] WARN pass {}: motion-diff failed ({motion_fail_reason}) AND template-match unavailable; trusting prediction",
                            total_passes + 1,
                        );
                    }
                }
            }

            // Phase 29 follow-up: linear-phase predicted-mode bailout.
            if use_linear
                && pass_mode == DetectionMode::Predicted
                && !options.disable_linear_bailout
            {
                if verbose {
                    eprintln!(
                        "[move-to] LINEAR BAILOUT: pass {} went predicted; reverting to last verified ({},{})",
                        total_passes + 1, prev_pos.0, prev_pos.1,
                    );
                }
                current_pos = prev_pos;
                corrections.push(CorrectionPass {
                    detected_cursor: Point {
                        x: current_pos.0.round(),
                        y: current_pos.1.round(),
                    },
                    live_px_per_mickey: c_result
                        .pair
                        .as_ref()
                        .map(|p| p.live_px_per_mickey)
                        .unwrap_or((observed_ratio_x + observed_ratio_y) / 2.0),
                    correction_mickeys: (corr_mickeys_x, corr_mickeys_y),
                    mode: DetectionMode::Predicted,
                    reason: Some(format!(
                        "{}; linear-bailout (reverted to last verified)",
                        pass_reason.unwrap_or_default(),
                    )),
                });
                break 'correction;
            }

            // Phase 24: update verification-lag counter.
            if matches!(
                pass_mode,
                DetectionMode::Motion | DetectionMode::Template | DetectionMode::Shape
            ) {
                passes_since_last_verification = 0;
            } else {
                passes_since_last_verification += 1;
            }

            corrections.push(CorrectionPass {
                detected_cursor: c_result
                    .pair
                    .as_ref()
                    .map(|p| Point {
                        x: p.post.centroid_x as f64,
                        y: p.post.centroid_y as f64,
                    })
                    .unwrap_or(Point {
                        x: current_pos.0.round(),
                        y: current_pos.1.round(),
                    }),
                live_px_per_mickey: c_result
                    .pair
                    .as_ref()
                    .map(|p| p.live_px_per_mickey)
                    .unwrap_or((observed_ratio_x + observed_ratio_y) / 2.0),
                correction_mickeys: (corr_mickeys_x, corr_mickeys_y),
                mode: pass_mode,
                reason: pass_reason.clone(),
            });

            diagnostics.push(MovePassDiagnostic {
                pass: total_passes + 1,
                mode: pass_mode,
                detected_at: Point {
                    x: current_pos.0,
                    y: current_pos.1,
                },
                residual_px: dist(current_pos.0, current_pos.1, target_x, target_y),
                ratio_used: (observed_ratio_x, observed_ratio_y),
                reason: pass_reason,
                linear_phase: use_linear,
            });

            prev_shot = shot_c;
            prev_pos = current_pos;
            total_passes += 1;
            if use_linear {
                linear_passes_used += 1;
            } else {
                gross_passes_used += 1;
            }

            // Phase 4: blind-pass circuit breaker.
            if should_abort_blind_corrections(&diagnostics) {
                if verbose {
                    eprintln!(
                        "[move-to] CIRCUIT BREAKER: 2 consecutive predicted passes; aborting. residual={:.1}px",
                        diagnostics.last().unwrap().residual_px,
                    );
                }
                break 'correction;
            }

            // Phase 29 follow-up: oscillation / regression detection.
            let last_diag = diagnostics.last().unwrap();
            if diagnostics.len() >= 3 {
                let prev_diag = &diagnostics[diagnostics.len() - 2];
                if last_diag.mode != DetectionMode::Predicted
                    && prev_diag.mode != DetectionMode::Predicted
                    && last_diag.residual_px > prev_diag.residual_px * 1.5
                {
                    if verbose {
                        eprintln!(
                            "[move-to] OSCILLATION GUARD: pass {total_passes} verified residual {:.1}px > prev {:.1}px x 1.5; reverting",
                            last_diag.residual_px, prev_diag.residual_px,
                        );
                    }
                    let revert_to = prev_diag.detected_at;
                    current_pos = (revert_to.x, revert_to.y);
                    final_detected_position = Some(revert_to);
                    break 'correction;
                }
            }
        }
    }

    let shot = client.screenshot(None).await?;

    // Phase 285: bail-with-best-pass-landing.
    let mut bailed_to_best_pass = false;
    let mut bailed_from_pass_idx: i64 = -1;
    let current_final_residual_for_bail = final_detected_position
        .map(|p| dist(p.x, p.y, target_x, target_y))
        .unwrap_or(f64::INFINITY);
    let bail_idx = pick_bail_pass(&diagnostics, current_final_residual_for_bail);
    if bail_idx != -1 {
        final_detected_position = Some(diagnostics[bail_idx as usize].detected_at);
        bailed_to_best_pass = true;
        bailed_from_pass_idx = bail_idx;
        passes_since_last_verification = (diagnostics.len() as i64 - 1 - bail_idx) as u32;
    }

    // V8 authoritative fallback (2026-07-19). Consulted ONLY when the
    // cascade above produced no position, so nothing that already works
    // is disturbed.
    if final_detected_position.is_none() {
        if let Some(v8) = find_cursor_by_v8_full_frame(
            &shot.buffer,
            shot.screenshot_width,
            shot.screenshot_height,
            V8FullFrameOptions::default(),
        )? {
            final_detected_position = Some(Point { x: v8.x, y: v8.y });
            if verbose {
                eprintln!(
                    "[move-to] v8 fallback: cascade returned null; v8 found cursor at ({},{}) presence={:.3}",
                    v8.x, v8.y, v8.presence,
                );
            }
        }
    }

    let final_residual_px = final_detected_position.map(|p| dist(p.x, p.y, target_x, target_y));

    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("Target ({target_x},{target_y})."));
    parts.push(format!(
        "Origin via {actual_strategy:?} at ({},{}).",
        origin.x.round(),
        origin.y.round()
    ));
    parts.push(format!(
        "Open-loop emitted {}X+{}Y mickeys in {chunk_count} chunk(s); default px/mickey=({:.2},{:.2}).",
        open_mickeys_x.abs(),
        open_mickeys_y.abs(),
        resolved.px_per_mickey_x,
        resolved.px_per_mickey_y,
    ));
    parts.push(format!(
        "Open-loop landing via {}: {}.",
        mode_str(open_loop_mode),
        diagnostics[0].reason.as_deref().unwrap_or("n/a"),
    ));
    if !corrections.is_empty() {
        let gross_count = corrections
            .iter()
            .enumerate()
            .filter(|(i, _)| {
                diagnostics
                    .get(i + 1)
                    .map(|d| !d.linear_phase)
                    .unwrap_or(true)
            })
            .count();
        let linear_count = corrections.len() - gross_count;
        let last = corrections.last().unwrap();
        parts.push(format!(
            "{} correction pass(es) ({gross_count} gross, {linear_count} linear); last applied ({},{}) mickeys.",
            corrections.len(),
            last.correction_mickeys.0,
            last.correction_mickeys.1,
        ));
        let last_failures = corrections
            .iter()
            .filter(|c| c.mode != DetectionMode::Motion)
            .count();
        if last_failures > 0 {
            parts.push(format!(
                "{last_failures}/{} pass(es) used template/predicted fallback (motion-diff blind).",
                corrections.len(),
            ));
        }
    }
    if linear_entered {
        parts.push(format!(
            "Linear approach engaged; final ratio ~= ({:.2}, {:.2}).",
            observed_ratio_x, observed_ratio_y,
        ));
    }
    if let (Some(pos), Some(residual)) = (final_detected_position, final_residual_px) {
        let stale = if passes_since_last_verification > 0 {
            format!(
                " (last verified {passes_since_last_verification} pass(es) ago — {} since; cursor may have drifted, accuracy uncertain)",
                if passes_since_last_verification == 1 {
                    "1 predicted pass".to_string()
                } else {
                    format!("{passes_since_last_verification} predicted passes")
                },
            )
        } else {
            String::new()
        };
        let bail = if bailed_to_best_pass {
            format!(
                " (bailed to earlier verified pass {bailed_from_pass_idx} — Phase 285; final pass either failed detection or had worse residual)"
            )
        } else {
            String::new()
        };
        parts.push(format!(
            "Final cursor at ({},{}); residual ({},{}) = {residual:.1}px{stale}{bail}.",
            pos.x,
            pos.y,
            pos.x - target_x,
            pos.y - target_y,
        ));
    } else if resolved.do_correct {
        parts.push("Final position not detected — click accuracy uncertain.".to_string());
    }
    if actual_strategy == MoveStrategy::SlamThenMove
        && options.strategy == Some(MoveStrategy::DetectThenMove)
    {
        parts.push(
            "WARNING: detect-origin fell back to slam; iPad may have re-locked via hot corner."
                .to_string(),
        );
    }

    Ok(MoveToResult {
        screenshot: shot.buffer,
        screenshot_width: shot.screenshot_width,
        screenshot_height: shot.screenshot_height,
        target: Point {
            x: target_x,
            y: target_y,
        },
        predicted: Point {
            x: predicted_post_open.0,
            y: predicted_post_open.1,
        },
        emitted_mickeys: (open_mickeys_x.abs(), open_mickeys_y.abs()),
        used_px_per_mickey: (observed_ratio_x, observed_ratio_y),
        chunk_count,
        strategy: actual_strategy,
        corrections,
        diagnostics,
        final_detected_position,
        final_residual_px,
        passes_since_last_verification,
        bailed_to_best_pass,
        resolution,
        message: parts.join(" "),
        learn_sample: None,
    })
}

fn clone_decoded(
    s: &pikvm_mcp_detection_vision::cursor_detect::DecodedScreenshot,
) -> pikvm_mcp_detection_vision::cursor_detect::DecodedScreenshot {
    pikvm_mcp_detection_vision::cursor_detect::DecodedScreenshot {
        buffer: s.buffer.clone(),
        rgb: s.rgb.clone(),
        width: s.width,
        height: s.height,
    }
}

#[cfg(test)]
mod tests;
