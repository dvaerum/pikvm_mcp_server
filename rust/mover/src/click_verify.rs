//! The rest of `src/pikvm/click-verify.ts` — `default_chunk_pace_ms_for`/
//! `default_max_residual_px_for`/`run_dismiss_recipe`/
//! `format_dismiss_result` already live in
//! `pikvm-mcp-ipad-primitives::click_verify` (shared with `hid-mode.ts`'s
//! port and `pikvm_dismiss_popup`, pulled in early — see that file's own
//! header). Everything else — the pixel-diff verification proper, and
//! click-at.ts's own tap-bias/residual-skip helpers, which TS keeps in
//! this same source file — lands here now that `move_to.rs` exists.
//!
//! Deliberately NOT ported: `chunkMickeys` (exported, tested, but no real
//! caller anywhere in the TS codebase — confirmed via grep) and the
//! `findCursorByTemplateSet` import (also unused in this file). Both
//! genuinely dead in the TS source, not a porting gap.

use pikvm_mcp_detection_vision::cursor_detect::{
    decode_screenshot, diff_pixels, DecodedScreenshot,
};

use crate::move_to::Point;

#[derive(Debug, Clone, Copy)]
pub struct ClickVerification {
    pub changed_pixels: usize,
    pub total_pixels: usize,
    pub changed_fraction: f64,
    pub screen_changed: bool,
}

impl ClickVerification {
    /// Faithful port of `verifyClickByDecodedFrames`'s `message` field,
    /// split out as a method rather than a stored `String` so the type
    /// stays `Copy` — nothing here needs the message pre-rendered.
    pub fn message(&self, scoped: bool, min_changed_fraction: f64) -> String {
        let pct = self.changed_fraction * 100.0;
        let scope = if scoped { "ROI" } else { "screen" };
        if self.screen_changed {
            format!("Click triggered visible screen change ({pct:.2}% of {scope} pixels changed).")
        } else {
            format!(
                "Click did not trigger a visible screen change ({pct:.2}% of {scope} pixels changed, below {:.2}% threshold). The click may have missed its target.",
                min_changed_fraction * 100.0,
            )
        }
    }
}

/// An explicit rectangular ROI in screenshot px, top-left origin — takes
/// precedence over `region` when both are set.
#[derive(Debug, Clone, Copy)]
pub struct RegionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A square window centered on a point, in screenshot px.
#[derive(Debug, Clone, Copy)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub half_width: f64,
    pub half_height: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ClickVerifyOptions {
    /// Default 60.
    pub pixel_threshold: Option<i32>,
    /// Default 0.005.
    pub min_changed_fraction: Option<f64>,
    pub region: Option<Region>,
    /// Takes precedence over `region` when both are set.
    pub region_rect: Option<RegionRect>,
}

/// Faithful port of `verifyClickByDecodedFrames`. Pure variant taking
/// already-decoded RGB frames.
pub fn verify_click_by_decoded_frames(
    pre: &DecodedScreenshot,
    post: &DecodedScreenshot,
    options: ClickVerifyOptions,
) -> anyhow::Result<ClickVerification> {
    if pre.width != post.width || pre.height != post.height {
        anyhow::bail!(
            "screenshot size mismatch: pre={}x{} post={}x{}",
            pre.width,
            pre.height,
            post.width,
            post.height
        );
    }

    let pixel_threshold = options.pixel_threshold.unwrap_or(60);
    let min_changed_fraction = options.min_changed_fraction.unwrap_or(0.005);

    let mask = diff_pixels(
        &pre.rgb,
        &post.rgb,
        pre.width,
        pre.height,
        pixel_threshold,
        0,
        0,
    );

    let mut changed_pixels = 0usize;
    let mut total_pixels = 0usize;
    let scoped;

    if let Some(r) = options.region_rect {
        // M6 expectRegion: half-open [x0,x1)x[y0,y1), clamped to frame bounds.
        let x0 = r.x.max(0.0).round() as usize;
        let x1 = (r.x + r.width).round().min(pre.width as f64).max(0.0) as usize;
        let y0 = r.y.max(0.0).round() as usize;
        let y1 = (r.y + r.height).round().min(pre.height as f64).max(0.0) as usize;
        for y in y0..y1 {
            for x in x0..x1 {
                total_pixels += 1;
                if mask[y * pre.width as usize + x] {
                    changed_pixels += 1;
                }
            }
        }
        scoped = true;
    } else if let Some(r) = options.region {
        let x0 = (r.x - r.half_width).max(0.0).round() as usize;
        let x1 = (r.x + r.half_width + 1.0)
            .round()
            .min(pre.width as f64)
            .max(0.0) as usize;
        let y0 = (r.y - r.half_height).max(0.0).round() as usize;
        let y1 = (r.y + r.half_height + 1.0)
            .round()
            .min(pre.height as f64)
            .max(0.0) as usize;
        for y in y0..y1 {
            for x in x0..x1 {
                total_pixels += 1;
                if mask[y * pre.width as usize + x] {
                    changed_pixels += 1;
                }
            }
        }
        scoped = true;
    } else {
        total_pixels = (pre.width as usize) * (pre.height as usize);
        changed_pixels = mask.iter().filter(|&&m| m).count();
        scoped = false;
    }

    let changed_fraction = if total_pixels > 0 {
        changed_pixels as f64 / total_pixels as f64
    } else {
        0.0
    };
    let screen_changed = changed_fraction >= min_changed_fraction;

    let result = ClickVerification {
        changed_pixels,
        total_pixels,
        changed_fraction,
        screen_changed,
    };
    let _ = scoped; // used via .message(scoped, ...) at the call site
    Ok(result)
}

/// Faithful port of `verifyClickByDiff`. Convenience variant: decodes raw
/// (JPEG/PNG) buffers then delegates to [`verify_click_by_decoded_frames`].
pub fn verify_click_by_diff(
    pre_buffer: &[u8],
    post_buffer: &[u8],
    options: ClickVerifyOptions,
) -> anyhow::Result<ClickVerification> {
    let pre = decode_screenshot(pre_buffer)?;
    let post = decode_screenshot(post_buffer)?;
    verify_click_by_decoded_frames(&pre, &post, options)
}

/// Faithful port of `isScreenTooDimForCursorDetection` (Phase 153/48).
/// The two-condition AND is load-bearing: dropping the severity check
/// would re-introduce a dark-mode false-positive (low mean, high stddev
/// from UI contrast — perfectly clickable, must NOT abort).
pub fn is_screen_too_dim_for_cursor_detection(
    mean: f64,
    severity: pikvm_mcp_detection_vision::brightness::Severity,
    min_brightness: f64,
) -> bool {
    mean < min_brightness && severity == pikvm_mcp_detection_vision::brightness::Severity::VeryDim
}

/// The measured detected→ACTUAL-TAP offset on iPad: a left click
/// registers ~5.9px ABOVE (smaller Y) the detected pointer position
/// (bias = tap - detected = (+0.2, -5.9), N=36 onTapEvent ground truth,
/// 2026-07-31). Y-only — the +0.2px X was noise. Distinct from the ~13px
/// centroid-vs-tip offset in autolabelled TRAINING data (a detector-
/// internal quantity, nothing to do with where a click lands) — do not
/// conflate them.
pub const CLICK_TAP_BIAS_Y_PX: f64 = -5.9;

/// Faithful port of `biasCorrectedAimPoint`. Correct a requested click
/// target to the pointer AIM point: since the tap lands ~5.9px above the
/// detected pointer, aim the pointer that much LOWER (larger Y) so the
/// tap lands on the requested target. Y-only, iPad/relative-mouse only —
/// a desktop absolute target clicks by coordinates, no tap offset.
pub fn bias_corrected_aim_point(target: Point) -> Point {
    Point {
        x: target.x,
        y: target.y - CLICK_TAP_BIAS_Y_PX,
    }
}

/// Faithful port of `residualForSkip` (Phase 88). Returns `None` when no
/// skip is required (residual <= max_residual_px, OR max_residual_px is
/// `None` — opt-out behaviour); `Some(residual)` when the click should be
/// skipped.
pub fn residual_for_skip(
    cursor: Point,
    target: Point,
    max_residual_px: Option<f64>,
) -> Option<f64> {
    let max_residual_px = max_residual_px?;
    let dx = cursor.x - target.x;
    let dy = cursor.y - target.y;
    let residual = dx.hypot(dy);
    (residual > max_residual_px).then_some(residual)
}

#[cfg(test)]
mod tests;
