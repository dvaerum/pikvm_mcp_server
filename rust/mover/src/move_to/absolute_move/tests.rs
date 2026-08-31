//! Unit tests for `move_to_pixel_absolute` and `move_to_pixel`'s new
//! `mouse_absolute` dispatch branch — per
//! `docs/move-to-pixel-absolute-mode-fix-design.md` §4's testing plan.

use std::sync::{Arc, Mutex as StdMutex};

use image::{ImageBuffer, Rgb};
use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};

use super::move_to_pixel_absolute;
use crate::move_to::types::{MoveStrategy, MoveToOptions, Point};

fn black_frame(w: u32, h: u32) -> Vec<u8> {
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_raw(w, h, vec![0u8; (w * h * 3) as usize]).unwrap();
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
    encoder.encode_image(&img).unwrap();
    buf
}

#[derive(Default, Clone)]
struct CallLog {
    absolute_moves: Arc<StdMutex<Vec<String>>>,
    relative_moves: Arc<StdMutex<Vec<String>>>,
}

/// A stub `PiKVMClient` that serves a fixed black frame as the streamer
/// snapshot, reports a fixed resolution, and records which endpoint
/// (absolute vs. relative) each mouse-move call hit — same shape as
/// `legacy_move/tests.rs`'s own `frame_client`.
fn stub_client() -> (Arc<pikvm_mcp_kvmd_client::client::PiKVMClient>, CallLog) {
    let log = CallLog::default();
    let log_bg = log.clone();
    let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
        let log = log_bg.clone();
        Box::pin(async move {
            if args.path.starts_with("/hid/events/send_mouse_move") {
                log.absolute_moves.lock().unwrap().push(args.path.clone());
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/hid/events/send_mouse_relative") {
                log.relative_moves.lock().unwrap().push(args.path.clone());
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/streamer/snapshot") {
                return Ok(ResponseBody::Image(black_frame(1920, 1080)));
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
    let client = Arc::new(pikvm_mcp_kvmd_client::client::PiKVMClient::with_request_fn(
        PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
        None,
        request_fn,
    ));
    (client, log)
}

#[tokio::test]
async fn absolute_move_calls_the_absolute_endpoint_never_relative() {
    let (client, log) = stub_client();
    let options = MoveToOptions {
        post_move_settle_ms: Some(0),
        ..Default::default()
    };
    move_to_pixel_absolute(&client, Point { x: 500.0, y: 300.0 }, &options)
        .await
        .unwrap();

    assert_eq!(
        log.absolute_moves.lock().unwrap().len(),
        1,
        "expected exactly one absolute move call"
    );
    assert!(
        log.relative_moves.lock().unwrap().is_empty(),
        "an absolute-mode move must never emit a relative HID report — that's the exact \
         documented silent no-op this fix exists to close (ADR-0002)"
    );
}

#[tokio::test]
async fn absolute_move_reports_its_own_strategy_not_a_relative_mode_one() {
    let (client, _log) = stub_client();
    let options = MoveToOptions {
        post_move_settle_ms: Some(0),
        ..Default::default()
    };
    let result = move_to_pixel_absolute(&client, Point { x: 500.0, y: 300.0 }, &options)
        .await
        .unwrap();

    assert_eq!(result.strategy, MoveStrategy::AbsoluteMove);
    // Relative-mode-only fields must be their documented, deliberate
    // sentinel values (§2b-i of the design doc), not accidental defaults
    // masquerading as a real relative-mode measurement.
    assert_eq!(result.emitted_mickeys, (0.0, 0.0));
    assert_eq!(result.used_px_per_mickey, (0.0, 0.0));
    assert_eq!(result.chunk_count, 0);
    assert!(result.corrections.is_empty());
    assert_eq!(result.passes_since_last_verification, 0);
    assert!(!result.bailed_to_best_pass);
}

#[tokio::test]
async fn absolute_move_reports_verification_failure_rather_than_silent_success() {
    // No real cursor-template fixtures exist in this crate's test
    // environment (get_cached_templates reads a relative on-disk
    // directory that isn't present under `cargo test`'s cwd) — so
    // verification against the stub's plain black frame genuinely finds
    // no match. This is the real, easy-to-trigger shape of "the move
    // was sent but never landed" (dead/unattached gadget,
    // task_e96aa0e3bff6) that this path must surface, not swallow.
    let (client, _log) = stub_client();
    let options = MoveToOptions {
        post_move_settle_ms: Some(0),
        ..Default::default()
    };
    let result = move_to_pixel_absolute(&client, Point { x: 500.0, y: 300.0 }, &options)
        .await
        .unwrap();

    assert!(
        result.final_detected_position.is_none(),
        "unverified absolute move must report None, not a false-success position"
    );
    assert!(result.final_residual_px.is_none());
    assert!(
        result.message.contains("verification failed"),
        "message should say plainly that verification failed: {}",
        result.message
    );
}

#[tokio::test]
async fn move_to_pixel_dispatches_to_absolute_path_when_mouse_absolute_is_set() {
    let (client, log) = stub_client();
    let options = MoveToOptions {
        mouse_absolute: true,
        post_move_settle_ms: Some(0),
        ..Default::default()
    };
    let result = crate::move_to::move_to_pixel(&client, Point { x: 500.0, y: 300.0 }, options)
        .await
        .unwrap();

    assert_eq!(result.strategy, MoveStrategy::AbsoluteMove);
    assert_eq!(log.absolute_moves.lock().unwrap().len(), 1);
    assert!(log.relative_moves.lock().unwrap().is_empty());
}
