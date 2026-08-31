//! Single-shot absolute-coordinate move-then-verify for real desktop/
//! absolute-mode targets (`HidPolicy.mouse_absolute == true`).
//!
//! Faithful to the design in
//! `docs/move-to-pixel-absolute-mode-fix-design.md`: absolute-mode
//! positioning needs none of `legacy_move`'s relative-mickey
//! calibration/correction machinery — an absolute HID coordinate maps
//! directly and deterministically to a screen pixel. Root cause this
//! fixes: `legacy_move::move_to_pixel_legacy` (and `src/pikvm/move-to.ts`,
//! the TS original it's a faithful port of) exclusively emits RELATIVE
//! HID reports via `client.mouse_move_relative()`, which per ADR-0002 is
//! a documented silent no-op into an absolute-assembled gadget — real,
//! currently-shipping bug in both codebases, confirmed live
//! (task_4b034fc4e018, it-03400/IT-02634).

use std::sync::Arc;

use pikvm_mcp_detection_vision::cursor_detect::{
    decode_screenshot, find_cursor_by_template_set, FindCursorOptions, Point as DetPoint,
};
use pikvm_mcp_detection_vision::template_set::DEFAULT_TEMPLATE_DIR;
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::ballistics::take_raw_screenshot;

use super::template_cache::get_cached_templates;
use super::types::{MoveStrategy, MoveToOptions, MoveToResult, Point};

/// Radius (px) within which a post-move cursor-template match counts as
/// "landed at the target" rather than a stray far-away false positive.
/// Generous compared to the relative-mode correction loop's tolerances
/// (Phase 29's 40px `icon_tolerance_residual_px`) because absolute
/// positioning has no accumulation error to correct for — a match this
/// far out is either a genuine landing at a slightly-offset render
/// point (cursor hotspot vs. sprite origin) or a real problem (dead/
/// unattached gadget, task_e96aa0e3bff6), not something worth an
/// iterative retry over.
const VERIFY_RADIUS_PX: f64 = 60.0;

pub(super) async fn move_to_pixel_absolute(
    client: &Arc<PiKVMClient>,
    target: Point,
    options: &MoveToOptions,
) -> anyhow::Result<MoveToResult> {
    let resolution = client.get_resolution(true).await?;
    let target_x = target
        .x
        .round()
        .clamp(0.0, (resolution.width as f64 - 1.0).max(0.0));
    let target_y = target
        .y
        .round()
        .clamp(0.0, (resolution.height as f64 - 1.0).max(0.0));

    client.mouse_move(target_x, target_y).await?;

    let settle_ms = options.post_move_settle_ms.unwrap_or(300);
    tokio::time::sleep(std::time::Duration::from_millis(settle_ms)).await;

    let after_raw = take_raw_screenshot(client).await?;
    let after = decode_screenshot(&after_raw)?;

    // Single verification pass — no correction loop. Locality-aware
    // template match (same discipline `find_cursor_by_template_set`'s
    // own doc already describes for `legacy_move.rs`'s calibration
    // probe): require a match within VERIFY_RADIUS_PX of the target,
    // rather than accepting the highest-scoring match anywhere on
    // screen (the iPad UI's own false-positive pattern doesn't apply to
    // a desktop target, but the same locality principle still holds —
    // don't report success against a coincidentally cursor-shaped UI
    // element elsewhere on the frame).
    let templates = get_cached_templates(DEFAULT_TEMPLATE_DIR).await;
    let verified = find_cursor_by_template_set(
        &after,
        &templates,
        &FindCursorOptions {
            expected_near: Some(DetPoint {
                x: target_x,
                y: target_y,
            }),
            expected_near_radius: Some(VERIFY_RADIUS_PX),
            require_within_radius: true,
            verbose: options.verbose,
            ..Default::default()
        },
    );

    let (final_detected_position, final_residual_px, message) = match verified {
        Some(hit) => {
            let residual = (hit.position.x - target_x).hypot(hit.position.y - target_y);
            (
                Some(Point {
                    x: hit.position.x,
                    y: hit.position.y,
                }),
                Some(residual),
                format!(
                    "Absolute move to ({target_x}, {target_y}) verified (residual {residual:.1}px, score {:.3})",
                    hit.score
                ),
            )
        }
        None => (
            None,
            None,
            format!(
                "Absolute move to ({target_x}, {target_y}) sent, but no cursor match found within {VERIFY_RADIUS_PX}px of target — verification failed (possible dead/unattached gadget, see task_e96aa0e3bff6)"
            ),
        ),
    };

    Ok(MoveToResult {
        screenshot: after.buffer,
        screenshot_width: after.width,
        screenshot_height: after.height,
        target: Point {
            x: target_x,
            y: target_y,
        },
        predicted: Point {
            x: target_x,
            y: target_y,
        },
        // Not applicable — absolute positioning emits zero relative HID
        // reports by design; these are not measurements of anything.
        // See docs/move-to-pixel-absolute-mode-fix-design.md §2b-i.
        emitted_mickeys: (0.0, 0.0),
        used_px_per_mickey: (0.0, 0.0),
        chunk_count: 0,
        strategy: MoveStrategy::AbsoluteMove,
        // Not applicable — single-shot move-then-verify, not an
        // iterative correction loop.
        corrections: Vec::new(),
        diagnostics: Vec::new(),
        final_detected_position,
        final_residual_px,
        // Genuinely accurate for a single-shot path, not sentinels:
        // there is no "earlier pass" to have bailed to or be behind.
        passes_since_last_verification: 0,
        bailed_to_best_pass: false,
        resolution,
        message,
        learn_sample: None,
    })
}

#[cfg(test)]
mod tests;
