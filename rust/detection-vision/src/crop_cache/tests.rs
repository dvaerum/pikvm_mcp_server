//! Unit tests for the crop-cache's pure diff/invalidate/merge logic — no
//! real ONNX inference needed (this module sits entirely upstream of
//! `run_cascade_inference_all`, filtering/replaying verdicts it's handed,
//! not computing them). Real correctness-gate parity (filtered vs
//! unfiltered on real captured frames) and real Pi4 timing are separate,
//! live-hardware-gated steps per the design doc's own sequencing — not
//! what these tests are for.

use super::*;
use crate::cursor_ml_detect::CascadeResult;

// CROP_CACHE and emit_clock are both process-global statics shared by
// every test in this module (and, for emit_clock, potentially by any
// other test in this crate's own test binary that touches it — none do
// today, confirmed via grep, but this lock exists so that stays true by
// construction rather than by accident if that ever changes). Serialize
// with a local lock, same convention `mover::test_support::
// GLOBAL_STATE_LOCK` uses for the identical reason on `emit_clock` —
// can't reuse that one directly (different crate, detection-vision
// doesn't depend on mover), so a crate-local lock here does the same job
// for this crate's own test binary.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const CROP: i64 = 96;
const FW: u32 = 1920;
const FH: u32 = 1080;

/// A full synthetic frame, solid-filled except optionally ONE crop
/// (identified by its center) gets a DIFFERENT fill — lets tests change
/// exactly one crop's content between two calls without needing a real
/// captured frame.
fn synthetic_frame(default_fill: u8, differing_center: Option<((i64, i64), u8)>) -> Vec<u8> {
    let mut full = vec![default_fill; (FW as usize) * (FH as usize) * 3];
    if let Some((center, fill)) = differing_center {
        let half = CROP / 2;
        let left = 0i64.max((FW as i64 - CROP).min(center.0 - half));
        let top = 0i64.max((FH as i64 - CROP).min(center.1 - half));
        for yy in 0..CROP {
            for xx in 0..CROP {
                let si = (((top + yy) as usize) * (FW as usize) + ((left + xx) as usize)) * 3;
                full[si] = fill;
                full[si + 1] = fill;
                full[si + 2] = fill;
            }
        }
    }
    full
}

fn fake_verdict(x: i64, y: i64, presence: f32) -> CascadeResult {
    CascadeResult {
        x,
        y,
        presence,
        heatmap_peak: presence,
    }
}

#[test]
fn cold_cache_treats_every_crop_as_changed() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_for_test();
    let full = synthetic_frame(10, None);
    let centers = [(100, 100), (200, 200)];

    let (changed, unchanged) = split_by_cache(&full, FW, FH, CROP, &centers);

    assert_eq!(changed, vec![(100, 100), (200, 200)]);
    assert!(
        unchanged.is_empty(),
        "a fresh/cold cache must never replay a verdict it never computed"
    );
}

#[test]
fn identical_bytes_on_a_later_scan_replay_the_cached_verdict_without_a_new_ai_call() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_for_test();
    let full = synthetic_frame(10, None);
    let centers = [(100, 100)];

    // Pass 1: cold, "changed" -> simulate the caller running the real AI
    // and recording the result.
    let (changed, _) = split_by_cache(&full, FW, FH, CROP, &centers);
    assert_eq!(changed, vec![(100, 100)]);
    let verdict = fake_verdict(103, 97, 0.87);
    update_cache(&full, FW, FH, CROP, &[((100, 100), verdict)]);

    // Pass 2: identical bytes, no emit in between -> replay, no AI call.
    let (changed2, unchanged2) = split_by_cache(&full, FW, FH, CROP, &centers);
    assert!(
        changed2.is_empty(),
        "an unchanged crop must not be re-sent to the AI"
    );
    assert_eq!(unchanged2.len(), 1);
    assert_eq!(unchanged2[0].0, (100, 100));
    assert_eq!(unchanged2[0].1.x, 103);
    assert_eq!(unchanged2[0].1.y, 97);
    assert_eq!(unchanged2[0].1.presence, 0.87);
}

#[test]
fn a_stationary_cursors_verdict_is_replayed_not_defaulted_to_absent() {
    // The exact false-negative trap the design doc's own §2 calls out by
    // name: a naive "unchanged region -> assume no cursor" pre-filter
    // would silently lose a real, PRESENT, stationary cursor. Prove the
    // replayed verdict is the real high-presence verdict, not zeroed.
    let _guard = TEST_LOCK.lock().unwrap();
    reset_for_test();
    let full = synthetic_frame(10, None);
    let centers = [(100, 100)];
    let (_, _) = split_by_cache(&full, FW, FH, CROP, &centers);
    let real_cursor_present = fake_verdict(101, 99, 0.95);
    update_cache(&full, FW, FH, CROP, &[((100, 100), real_cursor_present)]);

    let (_, unchanged) = split_by_cache(&full, FW, FH, CROP, &centers);
    assert_eq!(
        unchanged[0].1.presence, 0.95,
        "replayed verdict must be the real cached presence, not an assumed-absent default"
    );
}

#[test]
fn any_byte_difference_forces_a_real_recheck_even_a_single_pixel() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_for_test();
    let full1 = synthetic_frame(10, None);
    let centers = [(100, 100)];
    let (_, _) = split_by_cache(&full1, FW, FH, CROP, &centers);
    update_cache(
        &full1,
        FW,
        FH,
        CROP,
        &[((100, 100), fake_verdict(100, 100, 0.9))],
    );

    // One crop's fill differs by a single value -- deliberately NOT a
    // large change, proving there's no threshold being satisfied here.
    let full2 = synthetic_frame(10, Some(((100, 100), 11)));
    let (changed, unchanged) = split_by_cache(&full2, FW, FH, CROP, &centers);

    assert_eq!(
        changed,
        vec![(100, 100)],
        "byte-exact diff has zero threshold to satisfy -- any difference forces a real check"
    );
    assert!(unchanged.is_empty());
}

#[test]
fn a_relative_mode_emit_invalidates_the_entire_cache() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_for_test();
    pikvm_mcp_kvmd_client::emit_clock::reset_for_test();
    let full = synthetic_frame(10, None);
    let centers = [(100, 100), (200, 200)];

    let (_, _) = split_by_cache(&full, FW, FH, CROP, &centers);
    update_cache(
        &full,
        FW,
        FH,
        CROP,
        &[
            ((100, 100), fake_verdict(100, 100, 0.9)),
            ((200, 200), fake_verdict(200, 200, 0.8)),
        ],
    );

    // Confirm the cache is genuinely warm before invalidating -- a real
    // control, not just asserting the post-emit state and hoping.
    let (changed_before, unchanged_before) = split_by_cache(&full, FW, FH, CROP, &centers);
    assert!(changed_before.is_empty());
    assert_eq!(unchanged_before.len(), 2);

    // A real emit (the same primitive `mouse_move_relative` stamps)
    // happens -- SAME bytes, but the cache must not trust itself anymore.
    pikvm_mcp_kvmd_client::emit_clock::record_emit();
    let (changed_after, unchanged_after) = split_by_cache(&full, FW, FH, CROP, &centers);

    assert_eq!(
        changed_after.len(),
        2,
        "an emit must invalidate the WHOLE cache, not just crops it plausibly touched"
    );
    assert!(unchanged_after.is_empty());

    pikvm_mcp_kvmd_client::emit_clock::reset_for_test();
}

#[test]
fn a_resolution_change_invalidates_the_entire_cache() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_for_test();
    let full = synthetic_frame(10, None);
    let centers = [(100, 100)];
    let (_, _) = split_by_cache(&full, FW, FH, CROP, &centers);
    update_cache(
        &full,
        FW,
        FH,
        CROP,
        &[((100, 100), fake_verdict(100, 100, 0.9))],
    );

    // Same crop bytes, but the frame dimensions the cache was built
    // against have changed -- must invalidate wholesale, mirroring
    // `client.mouse_move`'s own `calibration_invalidated` pattern for
    // the same underlying reason (a resolution change).
    let (changed, unchanged) = split_by_cache(&full, FW + 1, FH, CROP, &centers);
    assert_eq!(changed, vec![(100, 100)]);
    assert!(unchanged.is_empty());
}

#[test]
fn update_cache_only_touches_the_crops_it_was_given() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_for_test();
    let full = synthetic_frame(10, None);
    let centers = [(100, 100), (200, 200)];
    let (_, _) = split_by_cache(&full, FW, FH, CROP, &centers);
    // Only record a verdict for ONE of the two cold crops -- simulates a
    // scan where a hint or window meant only some crops were actually
    // sent to the AI this round.
    update_cache(
        &full,
        FW,
        FH,
        CROP,
        &[((100, 100), fake_verdict(100, 100, 0.9))],
    );

    let (changed, unchanged) = split_by_cache(&full, FW, FH, CROP, &centers);
    assert_eq!(
        changed,
        vec![(200, 200)],
        "a crop never recorded via update_cache must still count as changed/unknown"
    );
    assert_eq!(unchanged.len(), 1);
    assert_eq!(unchanged[0].0, (100, 100));
}
