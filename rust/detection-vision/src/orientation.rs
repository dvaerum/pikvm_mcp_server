//! Detect the iPad's content bounds and orientation within an HDMI screenshot.
//!
//! Faithful port of `src/pikvm/orientation.ts`.
//!
//! PiKVM captures the full HDMI frame (e.g. 1920×1080), but an iPad
//! displayed in portrait fills only a vertical strip in the middle, with
//! black letterbox bars on either side. In landscape, the iPad fills (or
//! nearly fills) the frame. The slam-target corner, unlock-swipe centre X,
//! and home-indicator Y all depend on knowing where the actual iPad
//! content lives.
//!
//! Detection: walk inward from each HDMI edge looking for the first
//! column/row that contains any pixel above a brightness threshold. iPadOS
//! lock and home screens always have visible UI (status bar, home
//! indicator, widgets) brighter than the letterbox bars, so the first
//! non-uniform column/row marks the iPad edge.
//!
//! Dark-mode foreground apps with mostly black canvas can swallow one or
//! more edges, producing an aspect ratio that doesn't match an iPad. We
//! sanity-check the result and fall back to the most recent good detection
//! (cached in module state) when the current frame doesn't yield reliable
//! bounds.
//!
//! `detect_ipad_bounds`/`detect_bounds_or_null` (the `PiKVMClient`-taking
//! wrappers in the TS original) are ported below alongside the
//! buffer-based core — module 2's kvmd-client crate is now available, and
//! `slam.rs` (module 4) needed a second copy of this exact logic (its own
//! `detect_bounds_or_null`), so it's shared here rather than duplicated.

use std::sync::Mutex;

use crate::decode::decode_to_rgb;
use pikvm_mcp_kvmd_client::client::PiKVMClient;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IpadOrientation {
    Portrait,
    Landscape,
}

/// Hardcoded fallback for the post-slam top-left origin when bounds
/// detection fails. Calibrated against the reference iPad's portrait
/// letterbox in a 1920×1080 HDMI frame.
pub const LEGACY_PORTRAIT_SLAM_ORIGIN: (i64, i64) = (625, 65);

/// Hardcoded fallback for the unlock-swipe start point when bounds
/// detection fails. Same reference iPad as above.
pub const LEGACY_PORTRAIT_UNLOCK_START: (i64, i64) = (955, 1035);

// Cache the most recent sane detection. Detection from a dark-content app
// (e.g. Files in dark mode with all-black canvas) can falsely shrink the
// vertical bounds because the iPad's solid-black render is
// indistinguishable from HDMI letterbox black. Reusing a previously-good
// detection is the simplest robust fallback.
static LAST_GOOD_BOUNDS: Mutex<Option<IpadBounds>> = Mutex::new(None);

/// Aspect-ratio sanity check. iPad displays are 4:3 or 3:2 — short/long
/// side ratio between ~0.62 and ~0.75. A detection well outside that range
/// probably missed a black edge.
///
/// The bounds [0.55, 0.85] are wider than the strict iPad aspect range on
/// purpose: minor letterbox crop variance + JPEG compression noise can
/// push a real iPad detection toward the edges of the strict range. Phase
/// 157 (v0.5.147) exported this so the bounds are regression-pinned —
/// narrowing them silently rejects valid iPad detections; widening them
/// lets non-iPad screens slip through.
///
/// Pure: deterministic, no I/O.
pub fn aspect_looks_sane(w: u32, h: u32) -> bool {
    let r = w.min(h) as f64 / w.max(h) as f64;
    (0.55..=0.85).contains(&r)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IpadBounds {
    /// Left edge of iPad content within the HDMI frame.
    pub x: u32,
    /// Top edge.
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub center_x: u32,
    pub center_y: u32,
    pub orientation: IpadOrientation,
    /// Full HDMI screenshot resolution.
    pub resolution: (u32, u32),
}

#[derive(Clone, Copy, Debug)]
pub struct DetectOptions {
    /// Per-channel sum (R+G+B) above which a pixel counts as iPad content
    /// rather than letterbox black. Default 60 — well above JPEG noise on
    /// near-black bars (~5–15) and below the dimmest visible UI elements.
    pub brightness_sum: u32,
    /// Minimum number of pixels per column/row that must exceed
    /// `brightness_sum` for the column/row to count as iPad content.
    /// Default 10. Phase 320 (v0.5.247): lock-screen JPEG noise put
    /// 1-pixel-bright columns in the letterbox region, which the previous
    /// "any 1 pixel above threshold" rule mis-identified as content —
    /// inflating bounds to nearly full frame and breaking the
    /// portrait/landscape decision. Content columns have 945/1050 pixels
    /// above threshold (~90%); noise columns have ≤1.
    pub min_content_pixels: u32,
    pub verbose: bool,
}

impl Default for DetectOptions {
    fn default() -> Self {
        Self {
            brightness_sum: 60,
            min_content_pixels: 10,
            verbose: false,
        }
    }
}

pub fn detect_ipad_bounds_from_buffer(
    buffer: &[u8],
    options: DetectOptions,
) -> anyhow::Result<IpadBounds> {
    let decoded = decode_to_rgb(buffer)?;
    let (data, width, height) = (&decoded.data, decoded.width, decoded.height);
    let threshold = options.brightness_sum;
    let min_content_pixels = options.min_content_pixels;

    // Strategy: find letterbox (entirely-uniform-black) columns/rows on
    // each side. Letterbox bars are pure HDMI black with zero pixel
    // variance; iPad content has at least some non-black pixel somewhere
    // (status bar, home indicator, app chrome — even in dark-mode apps).
    // This is more robust than a pure brightness-bounding-box because
    // dark-themed apps with mostly black canvas still get correctly
    // bounded by the iPad's edge UI.
    let is_content_column = |x: u32| -> bool {
        let mut n = 0u32;
        for y in 0..height {
            let i = ((y * width + x) * 3) as usize;
            if data[i] as u32 + data[i + 1] as u32 + data[i + 2] as u32 > threshold {
                n += 1;
                if n >= min_content_pixels {
                    return true;
                }
            }
        }
        false
    };
    let is_content_row = |y: u32| -> bool {
        let row_off = (y * width * 3) as usize;
        let mut n = 0u32;
        for x in 0..width {
            let i = row_off + (x * 3) as usize;
            if data[i] as u32 + data[i + 1] as u32 + data[i + 2] as u32 > threshold {
                n += 1;
                if n >= min_content_pixels {
                    return true;
                }
            }
        }
        false
    };

    let mut min_x: Option<u32> = None;
    for x in 0..width {
        if is_content_column(x) {
            min_x = Some(x);
            break;
        }
    }
    let Some(min_x) = min_x else {
        anyhow::bail!(
            "Could not detect iPad content bounds — entire screenshot is black/below threshold. \
             The HDMI input may be disconnected or the iPad may be off."
        );
    };
    let mut max_x = min_x;
    for x in (min_x + 1..width).rev() {
        if is_content_column(x) {
            max_x = x;
            break;
        }
    }
    let mut min_y = 0u32;
    for y in 0..height {
        if is_content_row(y) {
            min_y = y;
            break;
        }
    }
    let mut max_y = min_y;
    for y in (min_y + 1..height).rev() {
        if is_content_row(y) {
            max_y = y;
            break;
        }
    }

    let w = max_x - min_x + 1;
    let h = max_y - min_y + 1;
    let orientation = if w > h {
        IpadOrientation::Landscape
    } else {
        IpadOrientation::Portrait
    };

    let detected = IpadBounds {
        x: min_x,
        y: min_y,
        width: w,
        height: h,
        center_x: min_x + w / 2,
        center_y: min_y + h / 2,
        orientation,
        resolution: (width, height),
    };

    // If the aspect ratio looks like an iPad (4:3 or 3:2), trust the
    // detection and update the cache. Otherwise prefer the last good
    // detection (likely from a brighter context like the lock or home
    // screen) — the current screen probably has solid-black content that's
    // eating one or more edges.
    if aspect_looks_sane(w, h) {
        *LAST_GOOD_BOUNDS.lock().unwrap() = Some(detected);
        return Ok(detected);
    }

    Ok(LAST_GOOD_BOUNDS.lock().unwrap().unwrap_or(detected))
}

/// Take a fresh screenshot and detect iPad bounds from it. Errors on a
/// screenshot failure (propagated from `PiKVMClient`) or an undetectable
/// (all-black) frame — see `detect_bounds_or_null` for a best-effort
/// variant that never fails the caller.
pub async fn detect_ipad_bounds(
    client: &PiKVMClient,
    options: DetectOptions,
) -> anyhow::Result<IpadBounds> {
    let shot = client.screenshot(None).await?;
    detect_ipad_bounds_from_buffer(&shot.buffer, options)
}

/// Best-effort wrapper around `detect_ipad_bounds`. Returns `None` on
/// failure (e.g. all-black HDMI capture) instead of erroring, optionally
/// logging the failure with a caller-supplied prefix when verbose.
/// Encapsulates the try/catch pattern that both `ipad_unlock` and
/// `cursor_anchor`'s origin discovery use.
pub async fn detect_bounds_or_null(
    client: &PiKVMClient,
    options: DetectOptions,
    log_prefix: &str,
) -> Option<IpadBounds> {
    match detect_ipad_bounds(client, options).await {
        Ok(b) => Some(b),
        Err(e) => {
            if options.verbose {
                eprintln!("[{log_prefix}] bounds detection failed: {e}");
            }
            None
        }
    }
}

/// For tests / fresh-process scenarios. Drops the cached bounds so the next
/// detection is always recomputed from the current screenshot.
pub fn clear_orientation_cache() {
    *LAST_GOOD_BOUNDS.lock().unwrap() = None;
}

/// Read the most recent successful detection without triggering a new one.
/// Returns `None` if no detection has succeeded yet in this process.
pub fn get_last_good_bounds() -> Option<IpadBounds> {
    *LAST_GOOD_BOUNDS.lock().unwrap()
}

/// Buffer analog of the client-taking `detect_bounds_or_null`: best-effort
/// detection from an already-captured frame. Returns `None` on failure
/// (all-black capture, non-iPad target) instead of erroring. Callers that
/// have a screenshot in hand (e.g. a brightness precheck reusing its own
/// frame) use this so they don't re-capture.
pub fn detect_bounds_from_buffer_or_null(
    buffer: &[u8],
    options: DetectOptions,
) -> Option<IpadBounds> {
    detect_ipad_bounds_from_buffer(buffer, options).ok()
}

/// **NEW — not a port of any TS source.** True when `(x, y)` falls inside
/// the HDMI frame but OUTSIDE the most-recently-detected iPad content
/// bounds — i.e. in the known black letterbox. Backs the auto-crop
/// design's dead-zone guard (task_f04c3909db11, added during review by
/// `pikvm-mcp-server@georgs-mac-mini`): a forgotten `pikvm_screenshot`
/// crop offset isn't a near-miss click, it's a ~600px miss (the iPad
/// content inset) landing on a completely different, possibly
/// destructive icon — and nobody legitimately targets the black bar, so
/// a target inside it is a near-certain signature of exactly that bug.
///
/// Reads the SAME cache `detect_ipad_bounds_from_buffer` already
/// maintains — zero new state, zero new computation on the hot path.
/// Returns `false` (no warning) when no detection has landed yet this
/// process, matching every other cache-reading caller's own
/// fail-open-to-inert default; this is an advisory guard, not a hard
/// refusal, so a cold cache should never block a legitimate first click.
///
/// Intended caller: `pikvm_mouse_move_to`/`pikvm_mouse_click_at`
/// (`rust/mover`'s `move_to.rs`/`click_at.rs`, not yet merged into this
/// branch as of this writing — see task_f04c3909db11's notes for the
/// handoff to `pikvm-mcp-server@georgs-mac-mini`, who owns those call
/// sites and their mandatory real-hardware gate).
pub fn point_in_known_letterbox(x: f64, y: f64) -> bool {
    let Some(bounds) = get_last_good_bounds() else {
        return false;
    };
    let (frame_w, frame_h) = bounds.resolution;
    let in_frame = x >= 0.0 && y >= 0.0 && x < frame_w as f64 && y < frame_h as f64;
    if !in_frame {
        return false; // off-frame entirely is a different (existing) validation concern
    }
    let in_content = x >= bounds.x as f64
        && x < (bounds.x + bounds.width) as f64
        && y >= bounds.y as f64
        && y < (bounds.y + bounds.height) as f64;
    !in_content
}

/// The iPad content rectangle as a crop region — the shape
/// `analyze_brightness`/`save_snapshot` accept. The one place bounds are
/// narrowed to a region, so the conversion isn't re-spelled at every call.
pub fn bounds_to_region(bounds: &IpadBounds) -> (u32, u32, u32, u32) {
    (bounds.x, bounds.y, bounds.width, bounds.height)
}

/// Best-effort iPad-content region from a frame, or `None` when bounds
/// can't be detected (non-iPad target or dark/uniform screen) — callers
/// then analyse the full frame. Consolidates the "detect bounds → narrow
/// to a brightness region, full-frame on failure" pipeline that the
/// click-at and click-verify brightness prechecks each open-coded.
pub fn ipad_content_region_from_buffer(
    buffer: &[u8],
    options: DetectOptions,
) -> Option<(u32, u32, u32, u32)> {
    detect_bounds_from_buffer_or_null(buffer, options).map(|b| bounds_to_region(&b))
}

/// Compute the slam-anchor origin in HDMI coordinates. After slamToCorner
/// with the 'top-left' corner, the cursor lands inside the iPad content
/// just past the dead-zone, near (bounds.x + dz, bounds.y + dz) where dz is
/// the iPadOS edge dead zone (~5–10 px). Use a small inset so move-to
/// starts from a known interior point regardless of orientation/letterbox.
pub fn slam_origin_from_bounds(bounds: &IpadBounds) -> (u32, u32) {
    let inset = 8;
    (bounds.x + inset, bounds.y + inset)
}

/// Compute the unlock-swipe start point. iPadOS unlocks via a bottom-up
/// swipe starting near the home indicator bar (which sits at the bottom
/// centre of the iPad's display, both portrait and landscape).
pub fn unlock_start_from_bounds(bounds: &IpadBounds) -> (u32, u32) {
    // Home indicator sits ~45 px above the bottom edge.
    let above_indicator = 45u32;
    let y = if bounds.height > above_indicator {
        bounds.y + bounds.height - above_indicator
    } else {
        bounds.y
    };
    (bounds.center_x, y.max(bounds.y))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use std::sync::Mutex as StdMutex;

    // The orientation cache is process-wide static state (Mutex<Option<IpadBounds>>),
    // so tests that touch it must not interleave -- serialize via a lock, same
    // discipline as the TS test suite's own clearOrientationCache() calls between tests.
    // `pub(crate)` (not private): `auto_crop.rs`'s own tests also call
    // `detect_ipad_bounds_from_buffer` and need to serialize against THIS
    // same cache, not a second independent lock that wouldn't actually
    // exclude these tests from each other — same "one shared lock, not
    // one per file" finding `mover`'s `test_support::GLOBAL_STATE_LOCK`
    // already documents for itself.
    pub(crate) static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn letterbox_jpeg(
        frame_w: u32,
        frame_h: u32,
        x0: u32,
        x1: u32,
        y0: u32,
        y1: u32,
        bright: u8,
    ) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(frame_w, frame_h, |x, y| {
            if x >= x0 && x < x1 && y >= y0 && y < y1 {
                Rgb([bright, bright, bright])
            } else {
                Rgb([0, 0, 0])
            }
        });
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
        encoder.encode_image(&img).unwrap();
        buf
    }

    #[test]
    fn aspect_looks_sane_accepts_ipad_like_ratios() {
        assert!(aspect_looks_sane(680, 968)); // ~0.70, portrait-ish
        assert!(aspect_looks_sane(1024, 768)); // 4:3
    }

    #[test]
    fn aspect_looks_sane_rejects_extreme_ratios() {
        assert!(!aspect_looks_sane(1920, 100)); // way too wide/thin
        assert!(!aspect_looks_sane(100, 100)); // perfect square, too far from iPad range
    }

    #[test]
    fn detect_ipad_bounds_from_buffer_locates_content_inside_letterbox() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // A portrait-ish content block, well within the sane aspect range.
        let jpeg = letterbox_jpeg(1920, 1080, 610, 1300, 40, 1040, 200);
        let bounds = detect_ipad_bounds_from_buffer(&jpeg, DetectOptions::default()).unwrap();
        assert_eq!(bounds.resolution, (1920, 1080));
        // Slop for JPEG compression noise at the edges.
        assert!((bounds.x as i64 - 610).abs() <= 5);
        assert!(((bounds.x + bounds.width) as i64 - 1300).abs() <= 5);
        assert_eq!(bounds.orientation, IpadOrientation::Portrait);
        clear_orientation_cache();
    }

    #[test]
    fn detect_ipad_bounds_from_buffer_errors_on_uniformly_black_frame() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        let jpeg = letterbox_jpeg(1920, 1080, 0, 0, 0, 0, 0); // no content region at all
        let result = detect_ipad_bounds_from_buffer(&jpeg, DetectOptions::default());
        assert!(result.is_err());
        clear_orientation_cache();
    }

    #[test]
    fn detect_ipad_bounds_from_buffer_falls_back_to_cache_on_bad_aspect() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // First: a real, sane iPad-shaped detection, populates the cache.
        let good = letterbox_jpeg(1920, 1080, 610, 1300, 40, 1040, 200);
        let first = detect_ipad_bounds_from_buffer(&good, DetectOptions::default()).unwrap();

        // Second: a dark-mode-like frame whose bright region is a thin sliver
        // (bad aspect ratio) -- must fall back to the cached good bounds, not
        // the new bad-aspect detection.
        let bad_aspect = letterbox_jpeg(1920, 1080, 900, 920, 40, 1040, 200); // 20px wide, tall
        let second = detect_ipad_bounds_from_buffer(&bad_aspect, DetectOptions::default()).unwrap();
        assert_eq!(
            second, first,
            "bad-aspect detection must fall back to the cached good bounds"
        );
        clear_orientation_cache();
    }

    #[test]
    fn get_last_good_bounds_is_none_after_clearing_cache() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        assert!(get_last_good_bounds().is_none());
    }

    #[test]
    fn get_last_good_bounds_reflects_the_most_recent_sane_detection() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        let jpeg = letterbox_jpeg(1920, 1080, 610, 1300, 40, 1040, 200);
        let detected = detect_ipad_bounds_from_buffer(&jpeg, DetectOptions::default()).unwrap();
        assert_eq!(get_last_good_bounds(), Some(detected));
        clear_orientation_cache();
    }

    #[test]
    fn detect_bounds_from_buffer_or_null_returns_none_instead_of_erroring() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        let jpeg = letterbox_jpeg(1920, 1080, 0, 0, 0, 0, 0);
        assert!(detect_bounds_from_buffer_or_null(&jpeg, DetectOptions::default()).is_none());
        clear_orientation_cache();
    }

    #[test]
    fn bounds_to_region_extracts_the_crop_rectangle() {
        let bounds = IpadBounds {
            x: 10,
            y: 20,
            width: 300,
            height: 400,
            center_x: 160,
            center_y: 220,
            orientation: IpadOrientation::Portrait,
            resolution: (1920, 1080),
        };
        assert_eq!(bounds_to_region(&bounds), (10, 20, 300, 400));
    }

    #[test]
    fn slam_origin_from_bounds_insets_by_8px() {
        let bounds = IpadBounds {
            x: 100,
            y: 50,
            width: 300,
            height: 400,
            center_x: 250,
            center_y: 250,
            orientation: IpadOrientation::Portrait,
            resolution: (1920, 1080),
        };
        assert_eq!(slam_origin_from_bounds(&bounds), (108, 58));
    }

    #[test]
    fn unlock_start_from_bounds_sits_above_the_home_indicator() {
        let bounds = IpadBounds {
            x: 100,
            y: 50,
            width: 300,
            height: 400,
            center_x: 250,
            center_y: 250,
            orientation: IpadOrientation::Portrait,
            resolution: (1920, 1080),
        };
        let start = unlock_start_from_bounds(&bounds);
        assert_eq!(start.0, bounds.center_x);
        assert_eq!(start.1, bounds.y + bounds.height - 45);
    }

    #[test]
    fn unlock_start_from_bounds_clamps_when_height_is_smaller_than_indicator_offset() {
        let bounds = IpadBounds {
            x: 100,
            y: 50,
            width: 300,
            height: 20, // smaller than the 45px indicator offset
            center_x: 250,
            center_y: 60,
            orientation: IpadOrientation::Portrait,
            resolution: (1920, 1080),
        };
        let start = unlock_start_from_bounds(&bounds);
        assert_eq!(
            start.1, bounds.y,
            "must clamp to bounds.y, never go above the top edge"
        );
    }

    // -- point_in_known_letterbox --

    #[test]
    fn point_in_known_letterbox_false_when_no_bounds_are_cached_yet() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        assert!(!point_in_known_letterbox(5.0, 5.0));
    }

    #[test]
    fn point_in_known_letterbox_false_for_a_point_inside_the_content_region() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        let jpeg = letterbox_jpeg(1920, 1080, 610, 1300, 40, 1040, 200);
        detect_ipad_bounds_from_buffer(&jpeg, DetectOptions::default()).unwrap();
        assert!(!point_in_known_letterbox(950.0, 400.0)); // well inside the detected content
        clear_orientation_cache();
    }

    #[test]
    fn point_in_known_letterbox_true_for_a_point_in_the_black_bar() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        let jpeg = letterbox_jpeg(1920, 1080, 610, 1300, 40, 1040, 200);
        detect_ipad_bounds_from_buffer(&jpeg, DetectOptions::default()).unwrap();
        assert!(point_in_known_letterbox(50.0, 400.0)); // left of the detected content
        assert!(point_in_known_letterbox(1800.0, 400.0)); // right of the detected content
        clear_orientation_cache();
    }

    #[test]
    fn point_in_known_letterbox_false_when_off_frame_entirely() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        let jpeg = letterbox_jpeg(1920, 1080, 610, 1300, 40, 1040, 200);
        detect_ipad_bounds_from_buffer(&jpeg, DetectOptions::default()).unwrap();
        assert!(!point_in_known_letterbox(-10.0, 400.0));
        assert!(!point_in_known_letterbox(400.0, 2000.0));
        clear_orientation_cache();
    }
}
