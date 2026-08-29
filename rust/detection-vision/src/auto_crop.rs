//! Cross-validated auto-crop of iPad letterboxing from returned
//! screenshots. **NEW — not a port of any TS source.** Backs
//! `pikvm_screenshot`'s auto-crop feature (task_f04c3909db11), designed
//! and critically reviewed with `pikvm-mcp-server@georgs-mac-mini` before
//! implementation (see that task's notes 44/45/47 for the full design
//! history, the rejected stateful-coordinate alternative, and the
//! empirical tolerance calibration this file's constant comes from).
//!
//! Corroborates `orientation::detect_ipad_bounds_from_buffer` (full-res
//! scan, the pixel-accurate detector already trusted for slam-origin/
//! unlock defaults) against `ipad_region_detect::detect_ipad_region`
//! (independent 240px-downscale algorithm) on the SAME frame before
//! trusting a crop — closes the "wrong-but-plausible detection on the
//! very first call, no cache to fall back on" gap neither detector's own
//! individual safety net covers alone.

use crate::ipad_region_detect::detect_ipad_region;
use crate::orientation::{detect_ipad_bounds_from_buffer, DetectOptions, IpadBounds};

/// Per-edge agreement tolerance, as a fraction of the corresponding frame
/// dimension. **Empirically calibrated, not guessed**: measured via
/// `rust/detection-vision/examples/calibrate_crop_tolerance.rs` against
/// all 35 real captured 1920×1080 frames already in this repo (data/
/// bg-real, data/openloopshape-real, data/seeds/eval-frames, benches/
/// fixtures — genuine hardware captures). Across the 22 frames where
/// BOTH detectors produced a genuine sub-frame region (13/35 hit the
/// region detector's own fallback — see [`detect_cross_validated_crop`]'s
/// doc — and are excluded from this measurement, not counted as
/// disagreement), the measured max per-edge delta was 4.63% (~89px @
/// 1920 wide; the worst case, data/bg-real/tv.jpg, is a genuine
/// algorithmic disagreement about top/bottom letterbox, not measurement
/// noise). This constant is set with real margin above that measured
/// max, not picked to feel right — the design's first draft asserted 5%
/// without measuring anything, which would have left near-zero margin
/// against the actual worst real case found once measured.
pub const CROSS_VALIDATION_TOLERANCE_FRACTION: f64 = 0.08;

/// Result of attempting a cross-validated auto-crop.
#[derive(Debug, Clone, Copy)]
pub enum AutoCropOutcome {
    /// Safe to crop to `IpadBounds` — either both detectors agree within
    /// tolerance, or the secondary detector had no independent opinion to
    /// offer (see [`detect_cross_validated_crop`]'s fallback handling).
    Cropped(IpadBounds),
    /// The two detectors produced genuinely different sub-frame regions
    /// beyond tolerance — refuse to guess; the caller should ship the
    /// full, uncropped frame instead.
    Disagreement,
}

/// Attempt a cross-validated auto-crop of `screenshot_jpeg`. Only a
/// genuine decode/detection failure propagates as `Err` — an inability
/// to safely CROP is a normal, expected, non-error outcome
/// ([`AutoCropOutcome::Disagreement`]), the same way "letterbox bounds
/// look insane, fall back to the cache" is a normal path inside
/// `detect_ipad_bounds_from_buffer` itself, not a thrown error.
///
/// `detect_ipad_region`'s own `<30%-of-frame-area` heuristic (its
/// documented "detection failed" signal) returns the FULL frame as a
/// region — real calibration data showed this fires on 13/35 (37%) of
/// real frames, almost all plain icon-grid home screens where the 240px
/// downscale doesn't catch enough per-column brightness signal. Treating
/// that as "disagreement" would make cross-validation reject the crop on
/// well over a third of ordinary real content — so a full-frame-shaped
/// region result is treated as "no corroborating signal", and the
/// primary (full-res) detector is trusted alone in that case, exactly as
/// every other existing caller of `detect_ipad_bounds_from_buffer`
/// already does (relying on ITS OWN aspect-sanity + last-good-cache
/// fallback).
pub fn detect_cross_validated_crop(screenshot_jpeg: &[u8]) -> anyhow::Result<AutoCropOutcome> {
    detect_cross_validated_crop_with_tolerance(screenshot_jpeg, CROSS_VALIDATION_TOLERANCE_FRACTION)
}

/// Same as [`detect_cross_validated_crop`] with an explicit tolerance —
/// split out so tests can exercise the disagreement branch against a
/// real frame without needing a synthetic frame that happens to exceed
/// the production constant (see this module's own tests: the single
/// worst-agreement real frame in the calibration corpus is, by design,
/// still WITHIN the production tolerance — that's what "set with margin
/// above the measured max" means).
fn detect_cross_validated_crop_with_tolerance(
    screenshot_jpeg: &[u8],
    tolerance_fraction: f64,
) -> anyhow::Result<AutoCropOutcome> {
    let bounds = detect_ipad_bounds_from_buffer(screenshot_jpeg, DetectOptions::default())?;
    let region = detect_ipad_region(screenshot_jpeg)?;

    let region_is_fallback =
        region.x == 0 && region.y == 0 && region.w == region.frame_w && region.h == region.frame_h;
    if region_is_fallback {
        return Ok(AutoCropOutcome::Cropped(bounds));
    }

    let frame_w = bounds.resolution.0 as f64;
    let frame_h = bounds.resolution.1 as f64;
    let bounds_right = bounds.x + bounds.width;
    let bounds_bottom = bounds.y + bounds.height;
    let region_right = region.x + region.w;
    let region_bottom = region.y + region.h;

    let edge_deltas = [
        (bounds.x as f64 - region.x as f64).abs() / frame_w,
        (bounds.y as f64 - region.y as f64).abs() / frame_h,
        (bounds_right as f64 - region_right as f64).abs() / frame_w,
        (bounds_bottom as f64 - region_bottom as f64).abs() / frame_h,
    ];

    if edge_deltas.into_iter().all(|d| d <= tolerance_fraction) {
        Ok(AutoCropOutcome::Cropped(bounds))
    } else {
        Ok(AutoCropOutcome::Disagreement)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orientation::clear_orientation_cache;
    use image::{ImageBuffer, Rgb};

    // Both `detect_ipad_bounds_from_buffer` (via orientation.rs's process-
    // wide last-good-bounds cache) touch shared static state — serialize
    // via the SAME lock orientation.rs's own tests use (not a second,
    // independent one, which wouldn't actually exclude these tests from
    // each other — see that module's own doc on this).
    use crate::orientation::tests::TEST_LOCK;

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
    fn crops_when_a_clean_letterboxed_frame_gives_both_detectors_the_same_answer() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // A large, clearly-bounded content block — both detectors should
        // land on essentially the same rectangle regardless of the
        // downscale-vs-full-res difference.
        let jpeg = letterbox_jpeg(1920, 1080, 610, 1300, 40, 1040, 200);
        let outcome = detect_cross_validated_crop(&jpeg).unwrap();
        match outcome {
            AutoCropOutcome::Cropped(bounds) => {
                assert!((bounds.x as i64 - 610).abs() <= 10);
                assert!(((bounds.x + bounds.width) as i64 - 1300).abs() <= 10);
            }
            AutoCropOutcome::Disagreement => {
                panic!("expected agreement on a clean letterboxed frame")
            }
        }
        clear_orientation_cache();
    }

    /// Real captured frames from `calibrate_crop_tolerance.rs`'s own
    /// corpus, used directly rather than trying to synthesize the exact
    /// fallback/disagreement shapes by hand — those are real JPEG-
    /// compression and downscale-quantization artifacts on genuine
    /// hardware captures, not something a hand-built synthetic frame
    /// reliably reproduces. Both files are already committed to the repo
    /// and their exact behavior against these two detectors is documented
    /// in task_f04c3909db11's note 47.
    fn repo_asset(relative: &str) -> Vec<u8> {
        let path =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).join(relative);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    #[test]
    fn trusts_the_primary_detector_alone_when_the_secondary_falls_back() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // Real calibration finding: this plain icon-grid home-screen
        // capture trips `detect_ipad_region`'s own <30%-area fallback
        // (13/35 real frames did, all `data/bg-real/*`) while the full-res
        // detector still finds a perfectly good crop.
        let jpeg = repo_asset("data/bg-real/appstore.jpg");
        let outcome = detect_cross_validated_crop(&jpeg).unwrap();
        assert!(matches!(outcome, AutoCropOutcome::Cropped(_)));
        clear_orientation_cache();
    }

    #[test]
    fn reports_disagreement_when_the_two_detectors_give_incompatible_sub_frame_regions() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // Real calibration finding: this frame is the single worst-
        // agreement case across the whole 35-frame corpus (top/bottom
        // edge delta ~4.6%) — the region detector found no top/bottom
        // letterbox at all while the full-res detector correctly found
        // one. At the empirically-calibrated production tolerance (8%)
        // this specific frame is actually still WITHIN tolerance — that's
        // what "set with margin above the measured max" means, and is
        // itself asserted by `production_tolerance_accepts_the_known_
        // worst_case_with_margin` below. This test instead exercises the
        // disagreement branch directly against a tighter tolerance,
        // proving the branch is reachable and correct without needing a
        // frame that exceeds the real (deliberately generous) production
        // constant.
        let jpeg = repo_asset("data/bg-real/tv.jpg");
        let outcome = detect_cross_validated_crop_with_tolerance(&jpeg, 0.03).unwrap();
        assert!(matches!(outcome, AutoCropOutcome::Disagreement));
        clear_orientation_cache();
    }

    #[test]
    fn production_tolerance_accepts_the_known_worst_case_with_margin() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // The whole point of calibrating against real data first: the
        // chosen production constant must actually accept the worst real
        // case it was calibrated against, not just exceed it on paper.
        let jpeg = repo_asset("data/bg-real/tv.jpg");
        let outcome = detect_cross_validated_crop(&jpeg).unwrap();
        assert!(matches!(outcome, AutoCropOutcome::Cropped(_)));
        clear_orientation_cache();
    }
}
