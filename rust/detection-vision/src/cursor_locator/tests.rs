//! Tests for the `cursor_locator` module family (`types`, `locator`).
//! Split into its own file (Rust 2018+ submodule layout) per the
//! idiomatic-file-structure standing rule.

use super::*;
use crate::cursor_detect::{
    CursorTemplate, DecodedScreenshot, FindCursorSetResult, LocateCursorResult, Point,
};
use crate::cursor_ml_detect::MlCursorResult;
use pikvm_mcp_cursor_belief::{
    Bounds, CursorBelief, CursorBeliefOptions, Emit, Point as BeliefPoint,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

fn fake_shot() -> DecodedScreenshot {
    DecodedScreenshot {
        buffer: vec![0xff],
        rgb: vec![0u8; 3],
        width: 200,
        height: 100,
    }
}

fn fake_belief() -> CursorBelief {
    CursorBelief::new(CursorBeliefOptions::new(BeliefPoint { x: 111.0, y: 222.0 }))
}

fn v8(x: f64, y: f64, presence: f64) -> V8Detection {
    V8Detection {
        x,
        y,
        presence,
        heatmap_peak: presence,
    }
}

fn frame() -> Vec<u8> {
    vec![0x01, 0x02]
}

/// A full deps object where everything is a stub; each stub is a no-op
/// / null by default so a test overrides only the collaborators it
/// cares about.
fn make_deps() -> CursorLocatorDeps {
    CursorLocatorDeps {
        belief: fake_belief(),
        screenshot: Arc::new(|| Box::pin(async { Ok(fake_shot()) })),
        decode: Arc::new(|_frame| Box::pin(async { Ok(fake_shot()) })),
        mouse_move_relative: Arc::new(|_dx, _dy| Box::pin(async { Ok(()) })),
        sleep: Arc::new(|_ms| Box::pin(async {})),
        get_cached_templates: Arc::new(|| Box::pin(async { Ok(Vec::new()) })),
        is_ml_disabled: Arc::new(|| false),
        find_cursor_by_v8_full_frame: Arc::new(|_frame, _w, _h, _opts| {
            Box::pin(async { Ok(None) })
        }),
        locate_cursor: Arc::new(|_opts| Box::pin(async { Ok(None) })),
        find_cursor_by_template_set: Arc::new(|_shot, _templates, _opts| None),
        find_cursor_by_ml_multi_hint: Arc::new(|_frame, _w, _h, _hints, _opts| {
            Box::pin(async { Ok(None) })
        }),
        build_ml_hints: Arc::new(|predicted, _fw, _fh, _belief| vec![predicted]),
        ml_wiggle_verify: Arc::new(|_ml| Box::pin(async { Ok(None) })),
        tautology_prox_threshold: 30.0,
    }
}

// --- origin -------------------------------------------------------------

#[tokio::test]
async fn origin_returns_the_v8_cascade_fix_first_and_does_not_probe_motion_diff() {
    let mut deps = make_deps();
    let v8_calls = Arc::new(AtomicUsize::new(0));
    let locate_calls = Arc::new(AtomicUsize::new(0));
    let templates_calls = Arc::new(AtomicUsize::new(0));
    {
        let v8_calls = v8_calls.clone();
        deps.find_cursor_by_v8_full_frame = Arc::new(move |_f, _w, _h, _o| {
            v8_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(Some(v8(50.0, 60.0, 0.87))) })
        });
    }
    {
        let locate_calls = locate_calls.clone();
        deps.locate_cursor = Arc::new(move |_o| {
            locate_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(None) })
        });
    }
    {
        let templates_calls = templates_calls.clone();
        deps.get_cached_templates = Arc::new(move || {
            templates_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(Vec::new()) })
        });
    }
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(fix.position.x, 50.0);
    assert_eq!(fix.position.y, 60.0);
    assert_eq!(fix.source, CursorFixSource::Cascade);
    assert_eq!(fix.raw_score, 0.87);
    assert_eq!(fix.confidence, Some(0.87));
    assert_eq!(v8_calls.load(Ordering::SeqCst), 1);
    assert_eq!(locate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(templates_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn origin_skips_v8_entirely_when_ml_is_disabled_and_falls_to_motion_diff() {
    let mut deps = make_deps();
    deps.is_ml_disabled = Arc::new(|| true);
    let v8_calls = Arc::new(AtomicUsize::new(0));
    {
        let v8_calls = v8_calls.clone();
        deps.find_cursor_by_v8_full_frame = Arc::new(move |_f, _w, _h, _o| {
            v8_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(Some(v8(1.0, 2.0, 0.9))) })
        });
    }
    deps.locate_cursor = Arc::new(|_o| {
        Box::pin(async {
            Ok(Some(LocateCursorResult {
                position: Point { x: 7.0, y: 8.0 },
                pre_position: Point { x: 0.0, y: 0.0 },
                probe_offset_px: Point { x: 42.0, y: 0.0 },
                probe_mickeys: Point { x: 60.0, y: 0.0 },
                cluster_count: 2,
            }))
        })
    });
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
        .await
        .unwrap();

    assert_eq!(v8_calls.load(Ordering::SeqCst), 0);
    assert_eq!(fix.unwrap().source, CursorFixSource::MotionDiff);
}

#[tokio::test]
async fn origin_carries_probe_measurement_and_null_confidence_when_motion_diff_wins() {
    let mut deps = make_deps();
    deps.locate_cursor = Arc::new(|_o| {
        Box::pin(async {
            Ok(Some(LocateCursorResult {
                position: Point { x: 7.0, y: 8.0 },
                pre_position: Point { x: 0.0, y: 0.0 },
                probe_offset_px: Point { x: 42.0, y: 0.0 },
                probe_mickeys: Point { x: 60.0, y: 0.0 },
                cluster_count: 3,
            }))
        })
    });
    let templates_calls = Arc::new(AtomicUsize::new(0));
    {
        let templates_calls = templates_calls.clone();
        deps.get_cached_templates = Arc::new(move || {
            templates_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(Vec::new()) })
        });
    }
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(fix.position.x, 7.0);
    assert_eq!(fix.position.y, 8.0);
    assert_eq!(fix.source, CursorFixSource::MotionDiff);
    assert_eq!(fix.raw_score, 0.0);
    assert!(fix.confidence.is_none());
    let pm = fix.probe_measurement.unwrap();
    assert_eq!((pm.offset_px.x, pm.offset_px.y), (42.0, 0.0));
    assert_eq!((pm.mickeys.x, pm.mickeys.y), (60.0, 0.0));
    assert_eq!(templates_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn origin_falls_to_the_template_set_progressive_wake_and_wins_on_the_2nd_nudge() {
    let mut deps = make_deps();
    deps.get_cached_templates = Arc::new(|| {
        Box::pin(async {
            Ok(vec![CursorTemplate {
                rgb: Vec::new(),
                width: 1,
                height: 1,
                hotspot: None,
            }])
        })
    });
    let call_count = Arc::new(AtomicUsize::new(0));
    let min_scores = Arc::new(Mutex::new(Vec::new()));
    {
        let call_count = call_count.clone();
        let min_scores = min_scores.clone();
        deps.find_cursor_by_template_set = Arc::new(move |_shot, _templates, opts| {
            min_scores.lock().unwrap().push(opts.min_score);
            let n = call_count.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                None
            } else {
                Some(FindCursorSetResult {
                    position: Point { x: 3.0, y: 4.0 },
                    score: 0.91,
                    template_index: 0,
                })
            }
        });
    }
    let moves = Arc::new(Mutex::new(Vec::new()));
    {
        let moves = moves.clone();
        deps.mouse_move_relative = Arc::new(move |dx, dy| {
            moves.lock().unwrap().push((dx, dy));
            Box::pin(async { Ok(()) })
        });
    }
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(fix.position.x, 3.0);
    assert_eq!(fix.position.y, 4.0);
    assert_eq!(fix.source, CursorFixSource::Template);
    assert_eq!(fix.raw_score, 0.91);
    assert!(fix.confidence.is_none());
    // exactly two wake cycles ran (30 fwd/back, then 60 fwd/back) -> 4 nudges.
    assert_eq!(
        *moves.lock().unwrap(),
        vec![(30.0, 0.0), (-30.0, 0.0), (60.0, 0.0), (-60.0, 0.0)]
    );
    assert_eq!(call_count.load(Ordering::SeqCst), 2);
    for min_score in min_scores.lock().unwrap().iter() {
        assert_eq!(*min_score, Some(0.85));
    }
}

#[tokio::test]
async fn origin_returns_none_when_all_three_origin_stages_fail() {
    let mut deps = make_deps();
    deps.get_cached_templates = Arc::new(|| {
        Box::pin(async {
            Ok(vec![CursorTemplate {
                rgb: Vec::new(),
                width: 1,
                height: 1,
                hotspot: None,
            }])
        })
    });
    let call_count = Arc::new(AtomicUsize::new(0));
    {
        let call_count = call_count.clone();
        deps.find_cursor_by_template_set = Arc::new(move |_shot, _templates, _opts| {
            call_count.fetch_add(1, Ordering::SeqCst);
            None
        });
    }
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
        .await
        .unwrap();

    assert!(fix.is_none());
    // all three nudge cycles exhausted.
    assert_eq!(call_count.load(Ordering::SeqCst), 3);
}

// --- openLoopShape --------------------------------------------------------

fn hint() -> Point {
    Point { x: 500.0, y: 400.0 }
}

#[tokio::test]
async fn open_loop_shape_returns_the_ml_fix_and_skips_shape_when_prox_is_far() {
    let mut deps = make_deps();
    let ml_calls = Arc::new(Mutex::new(Vec::new()));
    {
        let ml_calls = ml_calls.clone();
        deps.find_cursor_by_ml_multi_hint = Arc::new(move |_f, _w, _h, _hints, opts| {
            ml_calls.lock().unwrap().push(opts.min_confidence);
            Box::pin(async {
                Ok(Some(MlCursorResult {
                    x: 700.0,
                    y: 600.0,
                    confidence: 0.97,
                    crop_left: 0.0,
                    crop_top: 0.0,
                }))
            })
        });
    }
    let hints_calls = Arc::new(AtomicUsize::new(0));
    {
        let hints_calls = hints_calls.clone();
        deps.build_ml_hints = Arc::new(move |predicted, _fw, _fh, _belief| {
            hints_calls.fetch_add(1, Ordering::SeqCst);
            vec![predicted]
        });
    }
    let wiggle_calls = Arc::new(AtomicUsize::new(0));
    {
        let wiggle_calls = wiggle_calls.clone();
        deps.ml_wiggle_verify = Arc::new(move |_ml| {
            wiggle_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(None) })
        });
    }
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(
            frame(),
            200,
            100,
            LocateProfile::OpenLoopShape,
            Some(hint()),
            None,
        )
        .await
        .unwrap()
        .unwrap();

    assert_eq!((fix.position.x, fix.position.y), (700.0, 600.0));
    assert_eq!(fix.source, CursorFixSource::Ml);
    assert_eq!(fix.raw_score, 0.97);
    assert_eq!(fix.confidence, Some(0.97));
    assert_eq!(hints_calls.load(Ordering::SeqCst), 1);
    assert_eq!(wiggle_calls.load(Ordering::SeqCst), 0);
    assert_eq!(ml_calls.lock().unwrap()[0], Some(0.5));
}

#[tokio::test]
async fn open_loop_shape_wiggle_verifies_a_suspiciously_close_crop_based_ml_detection_and_accepts_it(
) {
    let mut deps = make_deps();
    deps.find_cursor_by_ml_multi_hint = Arc::new(|_f, _w, _h, _hints, _opts| {
        Box::pin(async {
            Ok(Some(MlCursorResult {
                x: 500.0,
                y: 400.0,
                confidence: 0.8,
                crop_left: 120.0,
                crop_top: 80.0,
            }))
        })
    });
    let wiggle_calls = Arc::new(AtomicUsize::new(0));
    {
        let wiggle_calls = wiggle_calls.clone();
        deps.ml_wiggle_verify = Arc::new(move |ml| {
            wiggle_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(Some(ml)) })
        });
    }
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(
            frame(),
            200,
            100,
            LocateProfile::OpenLoopShape,
            Some(hint()),
            None,
        )
        .await
        .unwrap();

    assert_eq!(wiggle_calls.load(Ordering::SeqCst), 1);
    assert_eq!(fix.unwrap().source, CursorFixSource::Ml);
}

#[tokio::test]
async fn open_loop_shape_skips_wiggle_verify_for_a_full_frame_cascade_detection_near_the_hint() {
    // find_cursor_by_ml_multi_hint returns crop (0,0) when its hint-
    // INDEPENDENT full-frame cascade fired, so a near-hint landing is
    // genuine, not a tautology — accept it directly WITHOUT wiggle-verify.
    let mut deps = make_deps();
    deps.find_cursor_by_ml_multi_hint = Arc::new(|_f, _w, _h, _hints, _opts| {
        Box::pin(async {
            Ok(Some(MlCursorResult {
                x: 500.0,
                y: 400.0,
                confidence: 0.8,
                crop_left: 0.0,
                crop_top: 0.0,
            }))
        })
    });
    // Would REJECT if called — must NOT be called.
    deps.ml_wiggle_verify = Arc::new(|_ml| Box::pin(async { Ok(None) }));
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(
            frame(),
            200,
            100,
            LocateProfile::OpenLoopShape,
            Some(hint()),
            None,
        )
        .await
        .unwrap()
        .unwrap();

    assert_eq!((fix.position.x, fix.position.y), (500.0, 400.0));
    assert_eq!(fix.source, CursorFixSource::Ml);
    assert_eq!(fix.raw_score, 0.8);
    assert_eq!(fix.confidence, Some(0.8));
}

#[tokio::test]
async fn open_loop_shape_returns_none_when_a_crop_based_ml_detection_is_wiggle_rejected() {
    let mut deps = make_deps();
    deps.find_cursor_by_ml_multi_hint = Arc::new(|_f, _w, _h, _hints, _opts| {
        Box::pin(async {
            Ok(Some(MlCursorResult {
                x: 500.0,
                y: 400.0,
                confidence: 0.7,
                crop_left: 120.0,
                crop_top: 80.0,
            }))
        })
    });
    deps.ml_wiggle_verify = Arc::new(|_ml| Box::pin(async { Ok(None) }));
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(
            frame(),
            200,
            100,
            LocateProfile::OpenLoopShape,
            Some(hint()),
            None,
        )
        .await
        .unwrap();

    assert!(fix.is_none());
}

#[tokio::test]
async fn open_loop_shape_returns_none_when_ml_finds_nothing() {
    let deps = make_deps(); // find_cursor_by_ml_multi_hint defaults to None
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(
            frame(),
            200,
            100,
            LocateProfile::OpenLoopShape,
            Some(hint()),
            None,
        )
        .await
        .unwrap();

    assert!(fix.is_none());
}

#[tokio::test]
async fn open_loop_shape_requires_a_hint() {
    let loc = CursorLocator::new(make_deps());
    let err = loc
        .locate(frame(), 200, 100, LocateProfile::OpenLoopShape, None, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("hint"));
}

// --- curve ----------------------------------------------------------------

#[tokio::test]
async fn curve_returns_the_v8_cascade_fix_from_the_passed_frame_at_min_presence_0_5() {
    let mut deps = make_deps();
    let calls = Arc::new(Mutex::new(Vec::new()));
    {
        let calls = calls.clone();
        deps.find_cursor_by_v8_full_frame = Arc::new(move |f, w, h, opts| {
            calls.lock().unwrap().push((f, w, h, opts.min_presence));
            Box::pin(async { Ok(Some(v8(12.0, 34.0, 0.66))) })
        });
    }
    let loc = CursorLocator::new(deps);

    let fix = loc
        .locate(frame(), 640, 480, LocateProfile::Curve, None, None)
        .await
        .unwrap()
        .unwrap();

    assert_eq!((fix.position.x, fix.position.y), (12.0, 34.0));
    assert_eq!(fix.source, CursorFixSource::Cascade);
    assert_eq!(fix.raw_score, 0.66);
    assert_eq!(fix.confidence, Some(0.66));
    let call = &calls.lock().unwrap()[0];
    assert_eq!(call.0, frame());
    assert_eq!((call.1, call.2, call.3), (640, 480, Some(0.5)));
}

#[tokio::test]
async fn curve_returns_none_when_v8_declines() {
    let loc = CursorLocator::new(make_deps());
    let fix = loc
        .locate(frame(), 640, 480, LocateProfile::Curve, None, None)
        .await
        .unwrap();
    assert!(fix.is_none());
}

// --- belief wiring ----------------------------------------------------------

#[test]
fn observe_forwards_position_to_belief_and_updates_real_state() {
    // Kalman-blends with the prior rather than snapping exactly to the
    // measurement (real CursorBelief math, not a mock) — assert it
    // moved decisively toward (5, 6) from the (111, 222) prior, not
    // that it landed exactly on the measurement.
    let mut loc = CursorLocator::new(make_deps());
    let before = loc.belief().position;
    loc.observe(&CursorFix {
        position: Point { x: 5.0, y: 6.0 },
        source: CursorFixSource::Ml,
        raw_score: 0.9,
        confidence: Some(0.9),
        probe_measurement: None,
    });
    let after = loc.belief().position;
    assert!(after.x < before.x);
    assert!(after.y < before.y);
}

#[test]
fn observe_uses_full_weight_when_confidence_is_none() {
    // Full weight (confidence=1) should snap the belief close to the
    // measurement even from a far-off prior, unlike a low-confidence
    // observation which would only nudge it partway.
    let mut loc = CursorLocator::new(make_deps());
    loc.observe(&CursorFix {
        position: Point { x: 5.0, y: 6.0 },
        source: CursorFixSource::MotionDiff,
        raw_score: 0.0,
        confidence: None,
        probe_measurement: None,
    });
    // Started at (111, 222); a full-weight observe should move it
    // decisively toward (5, 6), not leave it near the prior.
    assert!(loc.belief().position.x < 60.0);
    assert!(loc.belief().position.y < 120.0);
}

#[test]
fn reset_forwards_to_belief_reset() {
    let mut loc = CursorLocator::new(make_deps());
    loc.reset(Point { x: 9.0, y: 9.0 });
    assert_eq!(loc.belief().position, BeliefPoint { x: 9.0, y: 9.0 });
}

#[test]
fn set_bounds_sets_belief_bounds() {
    let mut loc = CursorLocator::new(make_deps());
    let bounds = Bounds {
        x: 1.0,
        y: 2.0,
        width: 3.0,
        height: 4.0,
    };

    loc.set_bounds(Some(bounds));
    assert_eq!(loc.belief().bounds, Some(bounds));

    loc.set_bounds(None);
    assert!(loc.belief().bounds.is_none());
}

#[test]
fn predict_passes_through_to_belief_predict() {
    let mut loc = CursorLocator::new(make_deps());
    let before = loc.belief().position;
    loc.predict(Emit { dx: 7.0, dy: -3.0 });
    // predict() moves the belief's position by emit * ratio (real
    // CursorBelief math, not a mock) — just assert it actually moved.
    assert_ne!(loc.belief().position, before);
}
