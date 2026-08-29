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

/// Known iPad screen aspect ratios (portrait width/height — the pair's
/// UNITS don't matter, points or physical pixels give the same ratio),
/// grouped into shape FAMILIES rather than one entry per model, per the
/// manager's own suggestion once the wider set was sourced: several
/// distinct iPad models share (near-)identical panel ratios, so a
/// per-family bucket is both a shorter list and more robust to an
/// older/unlisted model that shares a family's shape without being
/// individually enumerated here. Used as a THIRD, independent safeguard
/// beyond detector-vs-detector agreement — georgs-mac-mini's review
/// addition (task_f04c3909db11 note 45 follow-up): two detectors could
/// in principle agree on the same wrong box, and this catches that case
/// specifically, since a real iPad screen only ever has a handful of
/// known shapes.
///
/// Entry `[0]`'s pair (820×1180) is the ONLY one independently verified
/// against this project's own real hardware: it's `move-to.ts`'s own
/// `POINTER_ACCEL_IPAD_LOGICAL_W/H`, sourced from a real trajectory-bench
/// measurement of the actual iPad on `pikvm01` (this repo's one
/// confirmed iPad rig — see docs/adr/0002-mcp-derives-hid-mode-from-
/// appliance-endpoint.md for the `pikvm01`-vs-`it-03400` rig distinction;
/// `it-03400` is a different, non-iPad appliance rig).
///
/// All three buckets' MEMBERSHIP (which models share which family) and
/// the other two buckets' exact numbers were cross-confirmed 2026-08-29
/// via a real sourced web search (manager, apple.com/ipad-11/specs +
/// apple.com/ipad-pro/specs + itechguides.com's iPad display list) after
/// this agent — which operates offline-only and could not do that lookup
/// itself — flagged the original draft's remaining entries as unverified
/// trained recall. The 11-inch bucket's sourced physical-pixel numbers
/// (iPad 11" A16 and iPad Air 11" M4: 2360×1640, ratio 1.439) land
/// almost exactly on `[0]`'s own real-hardware-verified ratio (1180/820 =
/// 1.4396) — expected, since 820×1180 points × 2x scale = 1640×2360
/// pixels, the same panel family under Apple's later "11-inch" rebrand of
/// what was originally sold as "10.9-inch". iPad Pro 11" (M5)'s 2420×1668
/// (ratio 1.451) also falls inside this bucket's existing tolerance
/// without needing its own entry.
const KNOWN_IPAD_ASPECT_RATIOS: &[(&str, f64, f64)] = &[
    (
        "10.9\"/11\" family (iPad 10th gen+, iPad Air 4th gen+, iPad Pro 11\" all gens) — \
         anchor VERIFIED against this project's own real hardware; cluster cross-confirmed via \
         sourced Apple specs 2026-08-29",
        820.0,
        1180.0,
    ),
    (
        "12.9\"/13\" + classic 4:3 family (iPad Air 13\" M4: 2732x2048; iPad Pro 12.9\"/13\" all \
         gens: 2752x2064; pre-Air/Pro-split classic iPads, also 4:3) — sourced Apple specs \
         2026-08-29, not independently re-verified against a live device here",
        2048.0,
        2732.0,
    ),
    (
        "iPad mini family (7th gen: 2266x1488) — sourced Apple specs 2026-08-29, not \
         independently re-verified against a live device here",
        1488.0,
        2266.0,
    ),
];

/// Tolerance for the known-aspect-ratio check, as a fractional difference
/// in width:height ratio. Wider than a pixel-perfect match (to tolerate
/// the crop detectors' own edge-quantization noise — the same class of
/// noise `calibrate_crop_tolerance.rs` measured directly for the
/// two-detector cross-validation), but meaningfully tighter than
/// `orientation::aspect_looks_sane`'s existing `[0.55, 0.85]` band, which
/// exists to accept ANY roughly-iPad-shaped rectangle generically. This
/// check is deliberately more specific — a genuine third signal, not a
/// restatement of the first.
const KNOWN_ASPECT_TOLERANCE_FRACTION: f64 = 0.03;

/// True when a `width`×`height` rectangle (in any consistent unit —
/// screenshot pixels are fine, aspect ratio is unit-independent) matches
/// a known iPad screen shape (in EITHER orientation) within tolerance.
pub fn matches_a_known_ipad_aspect_ratio(width: f64, height: f64) -> bool {
    if width <= 0.0 || height <= 0.0 {
        return false;
    }
    let ratio = width / height;
    KNOWN_IPAD_ASPECT_RATIOS.iter().any(|(_, w, h)| {
        let portrait_ratio = w / h;
        let landscape_ratio = h / w;
        let close = |known: f64| ((ratio - known).abs() / known) <= KNOWN_ASPECT_TOLERANCE_FRACTION;
        close(portrait_ratio) || close(landscape_ratio)
    })
}

/// Result of attempting a cross-validated auto-crop.
#[derive(Debug, Clone, Copy)]
pub enum AutoCropOutcome {
    /// Safe to crop to `IpadBounds` — the detectors agree (or the
    /// secondary had no opinion) AND the resulting box matches a known
    /// iPad screen shape.
    Cropped(IpadBounds),
    /// The two detectors produced genuinely different sub-frame regions
    /// beyond tolerance — refuse to guess; ship the full frame instead.
    DetectorDisagreement,
    /// The detectors agreed (or the secondary had no opinion) but the
    /// resulting box doesn't match any known iPad screen shape — the
    /// third safeguard catching a case where both algorithms could have
    /// made the SAME wrong call. Ship the full frame instead.
    UnknownAspectRatio(IpadBounds),
}

/// Attempt a cross-validated auto-crop of `screenshot_jpeg`. Only a
/// genuine decode/detection failure propagates as `Err` — an inability
/// to safely CROP is a normal, expected, non-error outcome
/// ([`AutoCropOutcome::DetectorDisagreement`]/[`AutoCropOutcome::UnknownAspectRatio`]), the same way "letterbox bounds
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
        return Ok(cropped_if_known_shape(bounds));
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
        Ok(cropped_if_known_shape(bounds))
    } else {
        Ok(AutoCropOutcome::DetectorDisagreement)
    }
}

/// Third safeguard, applied uniformly regardless of how `bounds` was
/// reached (detector agreement or a fallback-to-primary): the two
/// detectors agreeing (or one having no opinion) doesn't rule out both
/// being wrong the SAME way — a real iPad screen only has a handful of
/// known shapes, so check that too before trusting the crop.
fn cropped_if_known_shape(bounds: IpadBounds) -> AutoCropOutcome {
    if matches_a_known_ipad_aspect_ratio(bounds.width as f64, bounds.height as f64) {
        AutoCropOutcome::Cropped(bounds)
    } else {
        AutoCropOutcome::UnknownAspectRatio(bounds)
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
            AutoCropOutcome::DetectorDisagreement => {
                panic!("expected agreement on a clean letterboxed frame")
            }
            AutoCropOutcome::UnknownAspectRatio(bounds) => {
                panic!(
                    "expected a known-iPad-shaped crop, got {}x{}",
                    bounds.width, bounds.height
                )
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
        // detector still finds a good, known-iPad-shaped crop in
        // isolation (cold cache — see calibrate_crop_tolerance.rs's own
        // header on why measuring this required clearing the cache
        // between frames: several of the 13 fallback frames, e.g.
        // appstore.jpg, ONLY look like a good crop when a PRIOR frame's
        // cache leaks into them, and are correctly caught by the third
        // safeguard when measured cold — see the test right below this
        // one for that exact case).
        let jpeg = repo_asset("data/bg-real/photos.jpg");
        let outcome = detect_cross_validated_crop(&jpeg).unwrap();
        assert!(matches!(outcome, AutoCropOutcome::Cropped(_)));
        clear_orientation_cache();
    }

    #[test]
    fn third_safeguard_catches_a_genuinely_bad_cold_cache_fallback_detection() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // Real regression case found while building THIS safeguard, not
        // hypothesized in advance: measured with a cold (just-cleared)
        // cache, appstore.jpg's own full-res detection is a genuinely bad
        // 0.87-ratio shape (nowhere near any known iPad panel) — a single
        // frame this poorly lit apparently doesn't give the full-res
        // scanner enough edge signal on its own. The region detector has
        // NO opinion here either (its own <30%-area fallback also fires),
        // so cross-validation alone has nothing to catch this with — the
        // known-aspect-ratio safeguard is the ONLY thing standing between
        // this frame and a badly wrong crop shipped to a real caller.
        let jpeg = repo_asset("data/bg-real/appstore.jpg");
        let outcome = detect_cross_validated_crop(&jpeg).unwrap();
        assert!(
            matches!(outcome, AutoCropOutcome::UnknownAspectRatio(_)),
            "expected the aspect-ratio safeguard to reject this cold-cache bad detection"
        );
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
        assert!(matches!(outcome, AutoCropOutcome::DetectorDisagreement));
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

    // -- matches_a_known_ipad_aspect_ratio / the third safeguard --

    #[test]
    fn matches_the_verified_pikvm01_ipad_ratio_in_portrait() {
        assert!(matches_a_known_ipad_aspect_ratio(820.0, 1180.0));
    }

    #[test]
    fn matches_the_verified_pikvm01_ipad_ratio_in_landscape() {
        assert!(matches_a_known_ipad_aspect_ratio(1180.0, 820.0));
    }

    #[test]
    fn matches_within_tolerance_of_a_known_ratio() {
        // A crop a few px off the exact 820x1180 panel shape (real
        // detector quantization noise) should still match.
        assert!(matches_a_known_ipad_aspect_ratio(825.0, 1180.0));
    }

    #[test]
    fn rejects_a_shape_that_matches_no_known_ipad() {
        // A near-square box — not close to any entry in the known-ratio
        // table, portrait or landscape.
        assert!(!matches_a_known_ipad_aspect_ratio(1000.0, 1050.0));
    }

    #[test]
    fn matches_the_sourced_129_13_inch_4_3_family_in_portrait() {
        // iPad Pro 13" (M5): 2752x2064 physical px, sourced Apple spec.
        assert!(matches_a_known_ipad_aspect_ratio(2064.0, 2752.0));
    }

    #[test]
    fn matches_the_sourced_ipad_mini_family_in_landscape() {
        // iPad mini (7th gen): 2266x1488 physical px, sourced Apple spec.
        assert!(matches_a_known_ipad_aspect_ratio(2266.0, 1488.0));
    }

    #[test]
    fn rejects_zero_or_negative_dimensions() {
        assert!(!matches_a_known_ipad_aspect_ratio(0.0, 1180.0));
        assert!(!matches_a_known_ipad_aspect_ratio(820.0, 0.0));
    }

    #[test]
    fn crops_when_the_agreed_box_is_a_known_ipad_shape() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // 690x1000 ≈ 0.69 ratio, within 3% of the verified 820:1180 (≈0.6949).
        let jpeg = letterbox_jpeg(1920, 1080, 610, 1300, 40, 1040, 200);
        let outcome = detect_cross_validated_crop(&jpeg).unwrap();
        assert!(matches!(outcome, AutoCropOutcome::Cropped(_)));
        clear_orientation_cache();
    }

    #[test]
    fn refuses_to_crop_when_the_agreed_box_matches_no_known_ipad_shape() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_orientation_cache();
        // Both detectors will agree on this box (it's a clean, large,
        // unambiguous content block) but it's roughly SQUARE — not close
        // to any known iPad panel — so the third safeguard must refuse it
        // even though the first two signals agree.
        let jpeg = letterbox_jpeg(1920, 1080, 460, 1460, 40, 1040, 200); // 1000x1000
        let outcome = detect_cross_validated_crop(&jpeg).unwrap();
        assert!(matches!(outcome, AutoCropOutcome::UnknownAspectRatio(_)));
        clear_orientation_cache();
    }
}
