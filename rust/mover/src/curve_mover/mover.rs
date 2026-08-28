//! `CursorLocator` wiring for the `'curve'` profile, the detection seam,
//! `emit_toward`, and `move_by_curve_one_shot` itself — the actual
//! curve-based one-shot mover. Faithful port of the remainder of
//! `curve-mover.ts`.

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_detection_vision::cursor_locator::{CursorLocator, CursorLocatorDeps, LocateProfile};
use pikvm_mcp_detection_vision::cursor_ml_detect::find_cursor_by_v8_full_frame as detect_v8_full_frame;
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use super::curve::{
    derive_correction_gate_px, DEFAULT_CURVE_SCALE_Y, EMIT_CURVE_X, FULL_REPORT_PX, Y_SCALE,
};
use super::types::{CurveOneShotDeps, CurveOneShotOptions, DetectFn};
use super::wake::wake_cursor_and_redetect;
use crate::move_to::{MoveLearnSample, MoveStrategy, MoveToResult, Point};

fn dist(a: Point, b: Point) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

/// Deps for the `'curve'` locator profile, which only touches the
/// belief and the V8 dual-head cascade. Every other profile's dep is a
/// throwing stub — never reached by `locate('curve')` (matches
/// `move_to`'s own `make_locator_deps` stub pattern, once it lands).
/// `find_cursor_by_v8_full_frame` resolves its own model path/cascade
/// config from `Settings` internally (see its own doc comment in
/// `cursor_ml_detect.rs`) — nothing to close over here.
fn make_curve_locator_deps(belief: pikvm_mcp_cursor_belief::CursorBelief) -> CursorLocatorDeps {
    fn not_wired<T: Send + 'static>(
        name: &'static str,
    ) -> super::types::BoxFuture<'static, anyhow::Result<T>> {
        Box::pin(async move {
            anyhow::bail!("cursor-locator: '{name}' dep not wired for the curve profile")
        })
    }

    CursorLocatorDeps {
        belief,
        screenshot: Arc::new(|| not_wired("screenshot")),
        decode: Arc::new(|_| not_wired("decode")),
        mouse_move_relative: Arc::new(|_, _| not_wired("mouseMoveRelative")),
        sleep: Arc::new(|_| Box::pin(async {})),
        get_cached_templates: Arc::new(|| not_wired("getCachedTemplates")),
        is_ml_disabled: Arc::new(|| false),
        find_cursor_by_v8_full_frame: Arc::new(|buf, w, h, options| {
            Box::pin(async move { detect_v8_full_frame(&buf, w, h, options) })
        }),
        locate_cursor: Arc::new(|_| not_wired("locateCursor")),
        find_cursor_by_template_set: Arc::new(|_, _, _| None),
        find_cursor_by_ml_multi_hint: Arc::new(|_, _, _, _, _| {
            not_wired("findCursorByMLMultiHint")
        }),
        build_ml_hints: Arc::new(|predicted, _, _, _| vec![predicted]),
        ml_wiggle_verify: Arc::new(|_| not_wired("mlWiggleVerify")),
        tautology_prox_threshold: 0.0,
    }
}

/// Screenshot + locate the cursor via the single `CursorLocator` front
/// door (C1 P3 curve). Byte-identical to the prior inline call: same
/// screenshot, same `find_cursor_by_v8_full_frame(buffer, w, h, {
/// min_presence })` via `locate('curve')`, also passing `hint`
/// (task_484bed055820) through when the caller has one.
async fn detect(
    client: Arc<PiKVMClient>,
    min_presence: f64,
    hint: Option<Point>,
) -> anyhow::Result<Option<Point>> {
    let shot = client
        .screenshot(Some(pikvm_mcp_kvmd_client::client::ScreenshotOptions {
            quality: Some(80),
            ..Default::default()
        }))
        .await?;
    let belief = *client.belief.lock().unwrap();
    let deps = make_curve_locator_deps(belief);
    let locator = CursorLocator::new(deps);
    let fix = locator
        .locate(
            shot.buffer,
            shot.screenshot_width,
            shot.screenshot_height,
            LocateProfile::Curve,
            hint.map(|p| pikvm_mcp_detection_vision::cursor_detect::Point { x: p.x, y: p.y }),
            Some(min_presence),
        )
        .await?;
    Ok(fix.map(|f| Point {
        x: f.position.x,
        y: f.position.y,
    }))
}

fn default_detect() -> DetectFn {
    Arc::new(|client, min_presence, hint| Box::pin(detect(client, min_presence, hint)))
}

async fn emit_toward(
    client: &Arc<PiKVMClient>,
    from: Point,
    target: Point,
    pace_ms: u64,
    scale_x: f64,
    scale_y: f64,
) -> anyhow::Result<Point> {
    let curve_y: Vec<(f64, f64)> = EMIT_CURVE_X
        .iter()
        .map(|&(m, p)| (m, p * Y_SCALE))
        .collect();
    let ex =
        super::curve::plan_axis_emits(target.x - from.x, FULL_REPORT_PX, EMIT_CURVE_X, scale_x);
    let ey = super::curve::plan_axis_emits(
        target.y - from.y,
        FULL_REPORT_PX * Y_SCALE,
        &curve_y,
        scale_y,
    );
    let mut mx = 0.0;
    let mut my = 0.0;
    for e in ex {
        client.mouse_move_relative(e, 0.0).await?;
        mx += e;
        tokio::time::sleep(Duration::from_millis(pace_ms)).await;
    }
    for e in ey {
        client.mouse_move_relative(0.0, e).await?;
        my += e;
        tokio::time::sleep(Duration::from_millis(pace_ms)).await;
    }
    Ok(Point { x: mx, y: my })
}

/// Detect the cursor once (V8), then move to `target` in a single
/// deterministic curve-based open-loop shot. Optionally one correction
/// shot if `correct_gate_px` is set. Returns a `MoveToResult`-shaped
/// value so existing callers work.
pub async fn move_by_curve_one_shot(
    client: &Arc<PiKVMClient>,
    target: Point,
    options: CurveOneShotOptions,
    deps: CurveOneShotDeps,
) -> anyhow::Result<MoveToResult> {
    let pace_ms = options.emit_pace_ms.unwrap_or(110);
    let settle_ms = options.settle_ms.unwrap_or(250);
    let min_presence = options.min_presence.unwrap_or(0.5);
    let detect_fn = deps.detect.unwrap_or_else(default_detect);
    let resolution = client.get_resolution(true).await?;

    // Detect the cursor. On failure (typically a fully-faded pointer),
    // wake it with a net-neutral relative jiggle and re-detect ONCE
    // before giving up (M2). Detect-failure-only: a visible cursor
    // detects first try and never pays the wake cost.
    let mut start = detect_fn(client.clone(), min_presence, None).await?;
    let mut woken = false;
    if start.is_none() {
        start = wake_cursor_and_redetect(client, min_presence, &detect_fn).await?;
        woken = start.is_some();
    }
    let shot_after_start = client
        .screenshot(Some(pikvm_mcp_kvmd_client::client::ScreenshotOptions {
            quality: Some(80),
            ..Default::default()
        }))
        .await?;

    let Some(start) = start else {
        return Ok(MoveToResult {
            screenshot: shot_after_start.buffer,
            screenshot_width: shot_after_start.screenshot_width,
            screenshot_height: shot_after_start.screenshot_height,
            target,
            predicted: target,
            emitted_mickeys: (0.0, 0.0),
            used_px_per_mickey: (0.0, 0.0),
            chunk_count: 0,
            strategy: MoveStrategy::CurveOneShot,
            corrections: vec![],
            diagnostics: vec![],
            final_detected_position: None,
            final_residual_px: None,
            passes_since_last_verification: 0,
            bailed_to_best_pass: false,
            resolution,
            message: "curve-one-shot: V8 start detection failed (no cursor found, even after faded-cursor wake)".to_string(),
            learn_sample: None,
        });
    };

    // Y defaults to the point-in-time drift compensation (see
    // DEFAULT_CURVE_SCALE_Y); X error was negligible (~-0.7%) so it
    // stays 1. An explicit curve_scale_y overrides.
    let scale_x = options.curve_scale_x.unwrap_or(1.0);
    let scale_y = options.curve_scale_y.unwrap_or(DEFAULT_CURVE_SCALE_Y);
    let m1 = emit_toward(client, start, target, pace_ms, scale_x, scale_y).await?;
    tokio::time::sleep(Duration::from_millis(settle_ms)).await;
    let mut emitted = m1;
    let mut chunk_count = 1;

    // task_484bed055820: we just emitted toward `target`, so it's a real
    // hint — the cascade searches a bounded window around it before
    // falling back to a full-region scan, instead of scanning the whole
    // region on every landing check regardless of how good a guess we
    // already have.
    let mut landed = detect_fn(client.clone(), min_presence, Some(target)).await?;
    // (#41) capture the FIRST-shot landing before any correction shot —
    // the passive learner's free sample (planned vs achieved). `start`
    // is `Some` here.
    let first_landed = landed;

    // One correction shot when the first lands in the PLAUSIBLE miss
    // band [correct_gate_px, correct_max_px] (default 30-80px). See
    // `curve.rs`'s correction-gate-invariant doc for the full rationale.
    let accept_gate_px = match options.accept_gate_px {
        Some(v) if v > 0.0 => v,
        _ => super::curve::DEFAULT_ACCEPT_GATE_PX,
    };
    // Correction gate selection:
    //  - correct_gate_px == Some(INFINITY) -> the explicit "disable the
    //    correction" door for calibration/measurement of the raw
    //    open-loop error (a pure single shot).
    //  - a FINITE override -> honored but CAPPED at the acceptance gate
    //    (a caller can't reopen the dead band with a gate above it).
    //  - anything else, incl. None AND non-finite (NaN) -> DERIVE from
    //    the acceptance gate. Only INFINITY is the sentinel; a garbage
    //    knob must NEVER silently disable the safety net.
    let correct_gate_px = match options.correct_gate_px {
        Some(v) if v.is_infinite() && v > 0.0 => f64::INFINITY,
        Some(v) if v.is_finite() => accept_gate_px.min(v),
        _ => derive_correction_gate_px(options.accept_gate_px),
    };
    let correct_max_px = options.correct_max_px.unwrap_or(80.0);
    let landed_res = landed.map(|l| dist(l, target)).unwrap_or(f64::INFINITY);
    if let Some(l) = landed {
        if landed_res > correct_gate_px && landed_res < correct_max_px {
            let m2 = emit_toward(client, l, target, pace_ms, scale_x, scale_y).await?;
            tokio::time::sleep(Duration::from_millis(settle_ms)).await;
            emitted = Point {
                x: emitted.x + m2.x,
                y: emitted.y + m2.y,
            };
            chunk_count += 1;
            let landed2 = detect_fn(client.clone(), min_presence, Some(target)).await?;
            if let Some(l2) = landed2 {
                landed = Some(l2);
            }
        }
    }

    let final_shot = client
        .screenshot(Some(pikvm_mcp_kvmd_client::client::ScreenshotOptions {
            quality: Some(80),
            ..Default::default()
        }))
        .await?;
    let final_residual_px = landed.map(|l| dist(l, target));
    let message = match landed {
        Some(l) => format!(
            "curve-one-shot: landed {:.1}px from target{}",
            dist(l, target),
            if woken {
                " (after faded-cursor wake)"
            } else {
                ""
            }
        ),
        None => "curve-one-shot: verify detection failed after move".to_string(),
    };
    let learn_sample = first_landed.map(|fl| MoveLearnSample {
        planned_x: target.x - start.x,
        planned_y: target.y - start.y,
        achieved_x: fl.x - start.x,
        achieved_y: fl.y - start.y,
        woken,
    });

    Ok(MoveToResult {
        screenshot: final_shot.buffer,
        screenshot_width: final_shot.screenshot_width,
        screenshot_height: final_shot.screenshot_height,
        target,
        predicted: target,
        emitted_mickeys: (emitted.x, emitted.y),
        used_px_per_mickey: (0.0, 0.0),
        chunk_count,
        strategy: MoveStrategy::CurveOneShot,
        corrections: vec![],
        diagnostics: vec![],
        final_detected_position: landed,
        final_residual_px,
        passes_since_last_verification: 0,
        bailed_to_best_pass: false,
        resolution,
        message,
        learn_sample,
    })
}

#[cfg(test)]
mod tests;
