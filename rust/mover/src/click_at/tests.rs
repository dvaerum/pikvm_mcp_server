//! Faithful port of `src/pikvm/__tests__/click-at.test.ts`. `move_to_pixel`
//! is mocked via `ClickAtDeps` — `click_at`'s own decision logic
//! (brightness gate, cursor-verified gate, correct-element residual gate,
//! the 2026-07-31 drift-bug invariant, capture wiring, force/
//! forced_unverified) is what's under test here, not the mover's
//! internals — those have their own extensive coverage in `move_to`'s own
//! test files.

use std::sync::{Arc, Mutex as StdMutex};

use image::{ImageBuffer, Rgb};
use pikvm_mcp_ipad_hid::hid_mode::{HidMode, HidPolicy, Strategy};
use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};

use super::*;
use crate::move_to::{MoveStrategy, Point};
use crate::scale_learner::{ScaleLearner, ScaleLearnerOpts};

fn ipad_policy(f: impl FnOnce(&mut HidPolicy)) -> HidPolicy {
    let mut p = HidPolicy {
        mode: HidMode::Ipad,
        mouse_absolute: false,
        strategy: Strategy::CurveOneShot,
        forbid_slam_fallback: true,
        forbid_slam_on_ipad: true,
        chunk_pace_ms: Some(100),
        max_residual_px: Some(25.0),
        dim_threshold: 40.0,
        apply_tap_bias: true,
    };
    f(&mut p);
    p
}

fn make_move_result(f: impl FnOnce(&mut MoveToResult)) -> MoveToResult {
    let mut r = MoveToResult {
        screenshot: b"shot".to_vec(),
        screenshot_width: 1920,
        screenshot_height: 1080,
        target: Point { x: 100.0, y: 100.0 },
        predicted: Point { x: 100.0, y: 100.0 },
        emitted_mickeys: (0.0, 0.0),
        used_px_per_mickey: (1.0, 1.0),
        chunk_count: 1,
        strategy: MoveStrategy::CurveOneShot,
        corrections: Vec::new(),
        diagnostics: Vec::new(),
        final_detected_position: Some(Point { x: 100.0, y: 100.0 }),
        final_residual_px: Some(0.0),
        passes_since_last_verification: 0,
        bailed_to_best_pass: false,
        resolution: pikvm_mcp_kvmd_client::client::ScreenResolution {
            width: 1920,
            height: 1080,
        },
        message: "moveToPixel: landed at (100,100)".to_string(),
        learn_sample: None,
    };
    f(&mut r);
    r
}

/// Deps whose `move_to_pixel` is a canned mock — mirrors TS's
/// `moveToPixelMock`. `calls` records every `(target, options)` pair
/// passed in, so the drift-bug-invariant tests can inspect what the mock
/// was actually called with.
type MoveCalls = Arc<StdMutex<Vec<(Point, MoveToOptions)>>>;

fn mock_deps(result: MoveToResult) -> (ClickAtDeps, MoveCalls) {
    let calls: MoveCalls = Arc::new(StdMutex::new(Vec::new()));
    let calls_bg = calls.clone();
    let result = Arc::new(result);
    let deps = ClickAtDeps {
        move_to_pixel: Arc::new(move |_client, target, options| {
            calls_bg.lock().unwrap().push((target, options.clone()));
            let result = (*result).clone();
            Box::pin(async move { Ok(result) })
        }),
    };
    (deps, calls)
}

fn encode_jpeg(w: u32, h: u32, rgb: &[u8]) -> Vec<u8> {
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(w, h, rgb.to_vec()).unwrap();
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
    encoder.encode_image(&img).unwrap();
    buf
}

fn bright_frame() -> Vec<u8> {
    encode_jpeg(400, 300, &vec![200u8; 400 * 300 * 3])
}

fn very_dim_frame() -> Vec<u8> {
    encode_jpeg(400, 300, &vec![5u8; 400 * 300 * 3])
}

/// High-contrast frame: half black, half bright — low mean, high stddev
/// (Phase 48: dim != very-dim).
fn contrasty_frame() -> Vec<u8> {
    let mut rgb = vec![0u8; 400 * 300 * 3];
    for (i, px) in rgb.chunks_mut(3).enumerate() {
        let bright = i % 2 == 0;
        let v = if bright { 220 } else { 0 };
        px.copy_from_slice(&[v, v, v]);
    }
    encode_jpeg(400, 300, &rgb)
}

type Clicks = Arc<StdMutex<Vec<String>>>;

/// Stub `PiKVMClient` always serving `frame` as the streamer snapshot
/// (covers both `screenshot()` and `screenshot_keeping_cursor_alive()`,
/// which itself calls `screenshot()` after a wake-nudge) and recording
/// every mouse-click's button.
fn frame_client(frame: Vec<u8>) -> (Arc<PiKVMClient>, Clicks) {
    let clicks: Clicks = Arc::new(StdMutex::new(Vec::new()));
    let clicks_bg = clicks.clone();
    let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
        let clicks = clicks_bg.clone();
        let frame = frame.clone();
        Box::pin(async move {
            if args.path.starts_with("/hid/events/send_mouse_button") {
                // The real client's own `mouse_click(button, None, None)`
                // (state omitted) makes TWO real HTTP calls per logical
                // click (button-down, then button-up ~150ms later) — only
                // count the down edge as "one click", matching TS's own
                // mock, which recorded one entry per `mouseClick()` call
                // regardless of how many HTTP round-trips a real client
                // needs underneath.
                if args.path.contains("state=true") {
                    let button = args
                        .path
                        .split("button=")
                        .nth(1)
                        .and_then(|s| s.split('&').next())
                        .unwrap_or("")
                        .to_string();
                    clicks.lock().unwrap().push(button);
                }
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/hid/events/send_mouse_relative") {
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/streamer/snapshot") {
                return Ok(ResponseBody::Image(frame.clone()));
            }
            if args.path == "/streamer" {
                return Ok(ResponseBody::Json(serde_json::json!({
                    "ok": true,
                    "result": { "streamer": { "source": { "online": true, "resolution": { "width": 400, "height": 300 } } } }
                })));
            }
            Ok(ResponseBody::Empty)
        })
    });
    let client = Arc::new(PiKVMClient::with_request_fn(
        PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
        None,
        request_fn,
    ));
    (client, clicks)
}

fn base_request(
    client: Arc<PiKVMClient>,
    policy: Option<HidPolicy>,
    scale_learner: &StdMutex<ScaleLearner>,
) -> ClickAtRequest<'_> {
    ClickAtRequest {
        client,
        policy,
        target: Point { x: 100.0, y: 100.0 },
        button: MouseButton::Left,
        strategy: None,
        assume_cursor_at: None,
        profile: None,
        verify_click: false, // keep most tests focused; verify-specific tests opt in
        verify_settle_ms: 0,
        verify_region_half_px: None,
        verify_min_change_fraction: None,
        expect_region: None,
        single_tap: false,
        force: false,
        min_brightness: None,
        max_residual_px: None,
        capture: None,
        scale_learner,
    }
}

fn fresh_scale_learner() -> StdMutex<ScaleLearner> {
    StdMutex::new(ScaleLearner::new(ScaleLearnerOpts::default(), true))
}

// -- mode-unknown --

#[tokio::test]
async fn reports_mode_unknown_and_never_calls_move_to_pixel_when_policy_is_none() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, calls) = mock_deps(make_move_result(|_| {}));
    let learner = fresh_scale_learner();
    let req = base_request(client, None, &learner);
    let outcome = click_at(req, deps).await;
    assert!(matches!(outcome, ClickAtOutcome::ModeUnknown { .. }));
    assert!(calls.lock().unwrap().is_empty());
}

// -- brightness abort --

#[tokio::test]
async fn aborts_on_a_uniformly_dim_frame_without_moving_the_cursor() {
    let (client, _clicks) = frame_client(very_dim_frame());
    let (deps, calls) = mock_deps(make_move_result(|_| {}));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.min_brightness = Some(40.0);
    let outcome = click_at(req, deps).await;
    match outcome {
        ClickAtOutcome::BrightnessAbort {
            threshold, mean, ..
        } => {
            assert_eq!(threshold, 40.0);
            assert!(mean < 40.0);
        }
        _ => panic!("expected BrightnessAbort"),
    }
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn does_not_abort_on_a_dark_but_contrasty_frame() {
    let (client, _clicks) = frame_client(contrasty_frame());
    let (deps, calls) = mock_deps(make_move_result(|_| {}));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.min_brightness = Some(40.0);
    let outcome = click_at(req, deps).await;
    assert!(!matches!(outcome, ClickAtOutcome::BrightnessAbort { .. }));
    assert!(!calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn skips_the_brightness_precheck_entirely_when_min_brightness_is_zero() {
    let (client, _clicks) = frame_client(very_dim_frame());
    let (deps, _calls) = mock_deps(make_move_result(|_| {}));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.min_brightness = Some(0.0);
    let outcome = click_at(req, deps).await;
    assert!(!matches!(outcome, ClickAtOutcome::BrightnessAbort { .. }));
}

// -- cursor-unverified skip --

#[tokio::test]
async fn skips_the_click_and_reports_cursor_unverified_when_the_mover_could_not_localize_the_cursor(
) {
    let (client, clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|r| r.final_detected_position = None));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.force = false;
    let outcome = click_at(req, deps).await;
    match outcome {
        ClickAtOutcome::CursorUnverified { message, .. } => {
            assert!(message.contains("Click NOT performed"));
        }
        _ => panic!("expected CursorUnverified"),
    }
    assert!(clicks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn does_not_apply_the_cursor_verified_gate_on_desktop_absolute_targets() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|r| r.final_detected_position = None));
    let learner = fresh_scale_learner();
    let req = base_request(
        client,
        Some(ipad_policy(|p| p.mouse_absolute = true)),
        &learner,
    );
    let outcome = click_at(req, deps).await;
    assert!(matches!(outcome, ClickAtOutcome::Clicked { .. }));
}

#[tokio::test]
async fn force_true_fires_the_click_anyway_and_reports_it_forced_unverified() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|r| r.final_detected_position = None));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.force = true;
    let outcome = click_at(req, deps).await;
    match outcome {
        ClickAtOutcome::Clicked {
            forced_unverified,
            message,
            ..
        } => {
            assert!(forced_unverified);
            assert!(message.contains("UNVERIFIED"));
            assert!(message.contains("LANDING IS NOT CONFIRMED"));
        }
        _ => panic!("expected Clicked"),
    }
}

// -- residual-gate skip (Phase 88 correct-element gate) --

#[tokio::test]
async fn skips_the_click_when_the_verified_cursor_lands_farther_than_max_residual_px() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|r| {
        r.final_detected_position = Some(Point { x: 200.0, y: 200.0 }); // ~141px from (100,100)
    }));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.max_residual_px = Some(25.0);
    let outcome = click_at(req, deps).await;
    match outcome {
        ClickAtOutcome::ResidualSkip {
            max_residual_px,
            residual_px,
            message,
            ..
        } => {
            assert_eq!(max_residual_px, 25.0);
            assert!(residual_px > 25.0);
            assert!(message.contains("adjacent element"));
        }
        _ => panic!("expected ResidualSkip"),
    }
}

#[tokio::test]
async fn proceeds_to_click_when_the_residual_is_within_max_residual_px() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|r| {
        r.final_detected_position = Some(Point { x: 105.0, y: 105.0 }); // ~7px from (100,100)
    }));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.max_residual_px = Some(25.0);
    let outcome = click_at(req, deps).await;
    assert!(matches!(outcome, ClickAtOutcome::Clicked { .. }));
}

#[tokio::test]
async fn the_gate_is_disabled_when_max_residual_px_is_zero() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|r| {
        r.final_detected_position = Some(Point { x: 900.0, y: 900.0 });
    }));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.max_residual_px = Some(0.0);
    let outcome = click_at(req, deps).await;
    assert!(matches!(outcome, ClickAtOutcome::Clicked { .. }));
}

// -- the 2026-07-31 drift bug (single-computation invariant) --

#[tokio::test]
async fn the_value_passed_to_move_to_pixel_accept_gate_px_is_identical_to_the_residual_skip_check_value(
) {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, calls) = mock_deps(make_move_result(|r| {
        r.final_detected_position = Some(Point { x: 128.0, y: 100.0 }); // 28px from (100,100)
    }));
    // apply_tap_bias:false so the aim point stays exactly (100,100).
    let learner = fresh_scale_learner();
    let mut req = base_request(
        client,
        Some(ipad_policy(|p| p.apply_tap_bias = false)),
        &learner,
    );
    req.max_residual_px = Some(28.0);
    // 28px residual against a 28px gate: not strictly greater than, so
    // this does NOT skip — proves the gate reads the exact same 28.
    let outcome = click_at(req, deps).await;
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1.accept_gate_px, Some(28.0));
    assert!(matches!(outcome, ClickAtOutcome::Clicked { .. }));
}

#[tokio::test]
async fn falls_through_to_policy_max_residual_px_when_the_caller_does_not_override_it() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, calls) = mock_deps(make_move_result(|r| {
        r.final_detected_position = Some(Point { x: 130.0, y: 100.0 }); // 30px, > policy's 25
    }));
    let learner = fresh_scale_learner();
    let req = base_request(client, Some(ipad_policy(|_| {})), &learner); // max_residual_px: None -> policy's 25
    let outcome = click_at(req, deps).await;
    let calls = calls.lock().unwrap();
    assert_eq!(calls[0].1.accept_gate_px, Some(25.0));
    match outcome {
        ClickAtOutcome::ResidualSkip {
            max_residual_px, ..
        } => assert_eq!(max_residual_px, 25.0),
        _ => panic!("expected ResidualSkip"),
    }
}

// -- successful click --

#[tokio::test]
async fn clicks_the_requested_button_and_reports_success_with_a_screenshot() {
    let (client, clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|r| {
        r.final_detected_position = Some(Point { x: 100.0, y: 100.0 });
    }));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.button = MouseButton::Right;
    let outcome = click_at(req, deps).await;
    assert_eq!(*clicks.lock().unwrap(), vec!["right".to_string()]);
    match outcome {
        ClickAtOutcome::Clicked {
            forced_unverified,
            message,
            ..
        } => {
            assert!(!forced_unverified);
            assert!(message.contains("Clicked right"));
        }
        _ => panic!("expected Clicked"),
    }
}

#[tokio::test]
async fn single_tap_appends_its_advisory_note() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|_| {}));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.single_tap = true;
    let outcome = click_at(req, deps).await;
    match outcome {
        ClickAtOutcome::Clicked { message, .. } => {
            assert!(message.contains("singleTap: tapped ONCE, no retry"));
        }
        _ => panic!("expected Clicked"),
    }
}

#[tokio::test]
async fn desktop_absolute_targets_click_regardless_of_final_detected_position() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|r| r.final_detected_position = None));
    let learner = fresh_scale_learner();
    let req = base_request(
        client,
        Some(ipad_policy(|p| p.mouse_absolute = true)),
        &learner,
    );
    let outcome = click_at(req, deps).await;
    match outcome {
        ClickAtOutcome::Clicked {
            forced_unverified, ..
        } => assert!(!forced_unverified),
        _ => panic!("expected Clicked"),
    }
}

// -- capture advisory (M8) --

#[tokio::test]
async fn captures_during_and_after_phases_when_a_capture_config_is_supplied() {
    let (client, _clicks) = frame_client(bright_frame());
    let (deps, _calls) = mock_deps(make_move_result(|_| {}));
    let learner = fresh_scale_learner();
    let mut req = base_request(client, Some(ipad_policy(|_| {})), &learner);
    req.capture = Some(pikvm_mcp_detection_vision::capture::CaptureConfig {
        phases: vec![
            pikvm_mcp_detection_vision::capture::CapturePhase::During,
            pikvm_mcp_detection_vision::capture::CapturePhase::After,
        ],
        prefix: "/tmp/click-at-test".to_string(),
        region: None,
    });
    let outcome = click_at(req, deps).await;
    match outcome {
        ClickAtOutcome::Clicked { captured, .. } => {
            // click_at always attempts all 3 phases (before/during/after)
            // when a capture config is set — capture_phase itself returns
            // None immediately for any phase not in config.phases, so
            // `captured` always has 3 entries when capture is on.
            assert_eq!(captured.len(), 3);
            assert!(captured[0].is_none()); // 'before' not in phases
            assert!(captured[1].is_some()); // 'during' requested
            assert!(captured[2].is_some()); // 'after' requested
        }
        _ => panic!("expected Clicked"),
    }
}
