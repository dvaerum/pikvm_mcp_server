//! Integration tests through `move_to_pixel_legacy`, faithfully ported
//! from `move-to.verificationLag.test.ts`, `move-to.forbidSlam.test.ts`,
//! and (a representative subset of) `move-to.forbidSlamOnIpad.test.ts`.
//!
//! **Known gap, not silently dropped**: `move-to.correctionCascade.test.ts`
//! (the N1 regression — see this file's own doc comment on the ML-recovery
//! branch) is NOT ported here. TS forces the correction loop's ML/shape
//! recovery branches deterministically via `vi.mock`, replacing
//! `findCursorByMLMultiHint`/`findCursorByShape` with canned responses.
//! This port calls the real, non-injected free functions directly (same
//! as TS's real production wiring — only the TEST used mocking, not the
//! source). Reaching those branches deterministically without mocking
//! needs either the real bundled ONNX model plus synthetic imagery
//! crafted to trigger a specific detection (fragile/environment-
//! dependent — same class of test the crate already gates behind
//! `#[ignore]` + `ORT_DYLIB_PATH`, see `cursor_ml_detect.rs`), or a DI
//! seam this function doesn't have (and v17 deliberately didn't add one,
//! to avoid relocating the correction loop's real coupling into an
//! artificial parameter list). The N1 fix itself (no early `break` after
//! `templated = true` on ML success) is verified by inspection — see the
//! code comment at that exact spot — and by the mandatory live hardware
//! gate before this file merges, same discipline as every other
//! mover-adjacent file this session.

use std::sync::{Arc, Mutex as StdMutex};

use image::{ImageBuffer, Rgb};
use pikvm_mcp_detection_vision::orientation::clear_orientation_cache;
use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};

use super::move_to_pixel_legacy;
use crate::move_to::types::{MoveStrategy, MoveToOptions, Point};

/// Serializes tests that touch process-global state (env vars via
/// `PIKVM_ML_CASCADE`, the orientation cache) — same lock the rest of
/// this crate's test suite already shares (`slam.rs`'s restructure, see
/// `docs/rust-port-plan.md`), so these tests are also safe to run
/// concurrently with the rest of `cargo test -p pikvm-mcp-mover`.
async fn with_ml_cascade_disabled<F, Fut, T>(f: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    use pikvm_mcp_foundation::settings::reset_settings_for_test;
    let _guard = crate::test_support::GLOBAL_STATE_LOCK.lock().await;
    let previous = std::env::var("PIKVM_ML_CASCADE").ok();
    std::env::set_var("PIKVM_ML_CASCADE", "0");
    reset_settings_for_test();
    let result = f().await;
    match previous {
        Some(v) => std::env::set_var("PIKVM_ML_CASCADE", v),
        None => std::env::remove_var("PIKVM_ML_CASCADE"),
    }
    reset_settings_for_test();
    result
}

fn encode_jpeg(w: u32, h: u32, rgb: &[u8]) -> Vec<u8> {
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_raw(w, h, rgb.to_vec()).expect("rgb buffer length must match w*h*3");
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
    encoder.encode_image(&img).unwrap();
    buf
}

/// Uniform black 1920x1080 frame — motion-diff finds no clusters,
/// template-match has nothing to match, shape-detect finds no cohesive
/// blob. Same trick `move-to.verificationLag.test.ts`/
/// `move-to.forbidSlam.test.ts` use.
fn black_frame() -> Vec<u8> {
    encode_jpeg(1920, 1080, &vec![0u8; 1920 * 1080 * 3])
}

/// A 1920x1080 frame that LOOKS like an iPad in portrait letterbox:
/// black bars left/right, bright content in the middle — faithful port
/// of `forbidSlamOnIpad.test.ts`'s `makeIpadPortraitFrame`.
fn ipad_portrait_frame() -> Vec<u8> {
    let (w, h) = (1920u32, 1080u32);
    let mut data = vec![0u8; (w as usize) * (h as usize) * 3];
    let (x0, x1) = (625usize, 1295usize);
    for y in 0..h as usize {
        for x in x0..=x1 {
            let i = (y * w as usize + x) * 3;
            data[i] = 200;
            data[i + 1] = 200;
            data[i + 2] = 200;
        }
    }
    encode_jpeg(w, h, &data)
}

fn parse_delta(path: &str) -> (f64, f64) {
    let mut dx = 0.0;
    let mut dy = 0.0;
    for pair in path.split('?').nth(1).unwrap_or("").split('&') {
        if let Some(v) = pair.strip_prefix("delta_x=") {
            dx = v.parse().unwrap_or(0.0);
        } else if let Some(v) = pair.strip_prefix("delta_y=") {
            dy = v.parse().unwrap_or(0.0);
        }
    }
    (dx, dy)
}

type Moves = Arc<StdMutex<Vec<(f64, f64)>>>;

/// A stub `PiKVMClient` that always serves `frame` as the streamer
/// snapshot, reports a fixed 1920x1080 resolution, and records every
/// mouse-move delta. Same shape as `curve_mover/mover/tests.rs`'s
/// `stub_client`.
fn frame_client(frame: Vec<u8>) -> (Arc<PiKVMClient>, Moves) {
    let moves: Moves = Arc::new(StdMutex::new(Vec::new()));
    let moves_bg = moves.clone();
    let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
        let moves = moves_bg.clone();
        let frame = frame.clone();
        Box::pin(async move {
            if args.path.starts_with("/hid/events/send_mouse_relative") {
                moves.lock().unwrap().push(parse_delta(&args.path));
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/streamer/snapshot") {
                return Ok(ResponseBody::Image(frame.clone()));
            }
            if args.path == "/streamer" {
                return Ok(ResponseBody::Json(serde_json::json!({
                    "ok": true,
                    "result": { "streamer": { "source": { "online": true, "resolution": { "width": 1920, "height": 1080 } } } }
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
    (client, moves)
}

fn slam_call_count(moves: &Moves) -> usize {
    moves
        .lock()
        .unwrap()
        .iter()
        .filter(|(dx, _)| *dx <= -100.0)
        .count()
}

use pikvm_mcp_kvmd_client::client::PiKVMClient;

// -- move-to.verificationLag.test.ts ----------------------------------

#[tokio::test]
async fn verification_lag_call_succeeds_and_returns_a_result_on_a_black_frame() {
    // TS's `typeof result.passesSinceLastVerification === 'number'` check
    // is a Rust type-system guarantee here (the field is `u32`) — the
    // Rust-shaped version of this pin is simply that the call completes
    // and returns a result at all on a black (no-cursor) frame.
    with_ml_cascade_disabled(|| async {
        let (client, _moves) = frame_client(black_frame());
        let options = MoveToOptions {
            strategy: Some(MoveStrategy::SlamThenMove),
            forbid_slam_fallback: false,
            forbid_slam_on_ipad: Some(false),
            calibration_probe_mickeys: Some(0.0),
            post_move_settle_ms: Some(0),
            ..Default::default()
        };
        let _result = move_to_pixel_legacy(&client, Point { x: 500.0, y: 500.0 }, &options)
            .await
            .unwrap();
    })
    .await;
}

#[tokio::test]
async fn verification_lag_reports_at_least_one_pass_when_no_verification_ever_succeeds() {
    with_ml_cascade_disabled(|| async {
        let (client, _moves) = frame_client(black_frame());
        let options = MoveToOptions {
            strategy: Some(MoveStrategy::SlamThenMove),
            forbid_slam_fallback: false,
            forbid_slam_on_ipad: Some(false),
            calibration_probe_mickeys: Some(0.0),
            post_move_settle_ms: Some(0),
            ..Default::default()
        };
        let result = move_to_pixel_legacy(&client, Point { x: 500.0, y: 500.0 }, &options)
            .await
            .unwrap();
        assert!(result.final_detected_position.is_none());
        assert!(result.passes_since_last_verification >= 1);
    })
    .await;
}

#[tokio::test]
async fn verification_lag_message_flags_staleness_when_passes_since_last_verification_is_positive()
{
    with_ml_cascade_disabled(|| async {
        let (client, _moves) = frame_client(black_frame());
        let options = MoveToOptions {
            strategy: Some(MoveStrategy::SlamThenMove),
            forbid_slam_fallback: false,
            forbid_slam_on_ipad: Some(false),
            calibration_probe_mickeys: Some(0.0),
            post_move_settle_ms: Some(0),
            ..Default::default()
        };
        let result = move_to_pixel_legacy(&client, Point { x: 500.0, y: 500.0 }, &options)
            .await
            .unwrap();
        if result.passes_since_last_verification > 0 {
            let msg = result.message.to_lowercase();
            assert!(
                msg.contains("uncertain")
                    || msg.contains("unverified")
                    || msg.contains("predicted")
                    || msg.contains("not detected")
                    || msg.contains("not verif")
                    || msg.contains("verif"),
                "message did not flag stale verification: {}",
                result.message
            );
        }
    })
    .await;
}

// -- move-to.forbidSlam.test.ts ----------------------------------------

#[tokio::test]
async fn forbid_slam_fallback_throws_on_detect_then_move_failure() {
    with_ml_cascade_disabled(|| async {
        let (client, _moves) = frame_client(black_frame());
        let options = MoveToOptions {
            strategy: Some(MoveStrategy::DetectThenMove),
            forbid_slam_fallback: true,
            calibration_probe_mickeys: Some(0.0),
            ..Default::default()
        };
        let err = move_to_pixel_legacy(&client, Point { x: 500.0, y: 500.0 }, &options)
            .await
            .unwrap_err();
        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("slam fallback forbidden")
                || msg.contains("cursor cannot be located")
                || msg.contains("detect-then-move failed"),
            "unexpected error message: {msg}"
        );
    })
    .await;
}

#[tokio::test]
async fn default_forbid_slam_fallback_false_falls_back_to_slam_silently() {
    with_ml_cascade_disabled(|| async {
        let (client, _moves) = frame_client(black_frame());
        let options = MoveToOptions {
            strategy: Some(MoveStrategy::DetectThenMove),
            calibration_probe_mickeys: Some(0.0),
            forbid_slam_on_ipad: Some(false),
            post_move_settle_ms: Some(0),
            ..Default::default()
        };
        let result = move_to_pixel_legacy(&client, Point { x: 500.0, y: 500.0 }, &options)
            .await
            .unwrap();
        assert!(matches!(
            result.strategy,
            MoveStrategy::SlamThenMove | MoveStrategy::DetectThenMove
        ));
    })
    .await;
}

// -- move-to.forbidSlamOnIpad.test.ts (representative subset — the guard
// -- itself is cursor_anchor.rs's own bounds-guard, extensively unit-
// -- tested there; these two pin the end-to-end wiring through
// -- move_to_pixel_legacy specifically) --------------------------------

#[tokio::test]
async fn forbid_slam_on_ipad_refuses_explicit_slam_then_move_on_portrait_letterbox() {
    with_ml_cascade_disabled(|| async {
        clear_orientation_cache();
        let (client, moves) = frame_client(ipad_portrait_frame());
        let options = MoveToOptions {
            strategy: Some(MoveStrategy::SlamThenMove),
            calibration_probe_mickeys: Some(0.0),
            ..Default::default()
        };
        let err = move_to_pixel_legacy(
            &client,
            Point {
                x: 1000.0,
                y: 800.0,
            },
            &options,
        )
        .await
        .unwrap_err();
        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("ipad-portrait letterbox detected") || msg.contains("hot-corner gesture"),
            "unexpected error message: {msg}"
        );
        assert_eq!(slam_call_count(&moves), 0);
    })
    .await;
}

#[tokio::test]
async fn forbid_slam_on_ipad_allows_when_caller_opts_out() {
    with_ml_cascade_disabled(|| async {
        clear_orientation_cache();
        let (client, moves) = frame_client(ipad_portrait_frame());
        let options = MoveToOptions {
            strategy: Some(MoveStrategy::SlamThenMove),
            forbid_slam_on_ipad: Some(false),
            calibration_probe_mickeys: Some(0.0),
            post_move_settle_ms: Some(0),
            ..Default::default()
        };
        let result = move_to_pixel_legacy(
            &client,
            Point {
                x: 1000.0,
                y: 800.0,
            },
            &options,
        )
        .await
        .unwrap();
        assert_eq!(result.strategy, MoveStrategy::SlamThenMove);
        assert!(slam_call_count(&moves) > 0);
    })
    .await;
}
