//! Tests for the `ipad_unlock` module family. Split into its own file
//! (Rust 2018+ submodule layout) per the idiomatic-file-structure
//! standing rule, mirroring the TS source's own one-test-file-per-
//! function structure via inline `mod`s below.

use super::*;
use crate::test_support::GLOBAL_STATE_LOCK as TEST_LOCK;
use pikvm_mcp_detection_vision::orientation::clear_orientation_cache;
use pikvm_mcp_kvmd_client::client::{
    PiKVMClient, PiKVMConfig, RequestArgs, RequestBody, RequestFn, ResponseBody,
};
use std::sync::{Arc, Mutex as StdMutex};

#[derive(Debug, Clone, PartialEq)]
enum Call {
    Move { dx: f64, dy: f64 },
    MouseDown,
    MouseUp,
    SendKey(String),
    KeyDown(String),
    KeyUp(String),
    Type(String),
    Screenshot,
    GetResolution,
}

type Calls = Arc<StdMutex<Vec<Call>>>;
type ShotCalls = Arc<StdMutex<usize>>;

fn parse_query(path: &str) -> std::collections::HashMap<String, String> {
    path.split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .filter_map(|p| {
            let mut it = p.splitn(2, '=');
            Some((it.next()?.to_string(), it.next().unwrap_or("").to_string()))
        })
        .collect()
}

fn parse_delta(path: &str) -> (f64, f64) {
    let q = parse_query(path);
    (
        q.get("delta_x").and_then(|v| v.parse().ok()).unwrap_or(0.0),
        q.get("delta_y").and_then(|v| v.parse().ok()).unwrap_or(0.0),
    )
}

/// Real `PiKVMClient` test double (real request stubbing, not a hand-
/// rolled mock object), same discipline as slam.rs/cursor_anchor.rs.
/// `screenshots`: served round-robin (clamped to the last on exhaustion)
/// to every `/streamer/snapshot` call — both bounds-detection and
/// verification calls share this one client, so ordering matters (see
/// cursor_anchor.rs's own tests.rs for the full rationale).
fn stub_client(
    resolution: (u32, u32),
    screenshots: Vec<Vec<u8>>,
) -> (Arc<PiKVMClient>, Calls, ShotCalls) {
    let (w, h) = resolution;
    let calls: Calls = Arc::new(StdMutex::new(Vec::new()));
    let calls_bg = calls.clone();
    let shot_calls: ShotCalls = Arc::new(StdMutex::new(0));
    let shot_calls_bg = shot_calls.clone();
    let screenshots = Arc::new(screenshots);
    let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
        let calls = calls_bg.clone();
        let shot_calls = shot_calls_bg.clone();
        let screenshots = screenshots.clone();
        Box::pin(async move {
            if args.path.starts_with("/hid/events/send_mouse_relative") {
                let (dx, dy) = parse_delta(&args.path);
                calls.lock().unwrap().push(Call::Move { dx, dy });
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/hid/events/send_mouse_button") {
                let q = parse_query(&args.path);
                match q.get("state").map(String::as_str) {
                    Some("true") => calls.lock().unwrap().push(Call::MouseDown),
                    Some("false") => calls.lock().unwrap().push(Call::MouseUp),
                    _ => {}
                }
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/hid/events/send_key") {
                let q = parse_query(&args.path);
                let key = q.get("key").cloned().unwrap_or_default();
                match q.get("state").map(String::as_str) {
                    Some("true") => calls.lock().unwrap().push(Call::KeyDown(key)),
                    Some("false") => calls.lock().unwrap().push(Call::KeyUp(key)),
                    _ => calls.lock().unwrap().push(Call::SendKey(key)),
                }
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/hid/print") {
                let text = match &args.body {
                    Some(RequestBody::Text(t)) => t.clone(),
                    _ => String::new(),
                };
                calls.lock().unwrap().push(Call::Type(text));
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/streamer/snapshot") {
                calls.lock().unwrap().push(Call::Screenshot);
                let mut i = shot_calls.lock().unwrap();
                if screenshots.is_empty() {
                    // `client.screenshot()` decodes the buffer for real
                    // (to read width/height) — unlike TS's mock, an empty/
                    // fake buffer errors rather than passing through.
                    // Callers that don't care about frame content still
                    // need a genuinely decodable placeholder.
                    *i += 1;
                    return Ok(ResponseBody::Image(solid_jpeg(w, h, [128, 128, 128])));
                }
                let idx = (*i).min(screenshots.len() - 1);
                *i += 1;
                return Ok(ResponseBody::Image(screenshots[idx].clone()));
            }
            if args.path == "/streamer" {
                calls.lock().unwrap().push(Call::GetResolution);
                return Ok(ResponseBody::Json(serde_json::json!({
                    "ok": true,
                    "result": { "streamer": { "source": { "online": true, "resolution": { "width": w, "height": h } } } }
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
    (client, calls, shot_calls)
}

fn jpeg_encode(rgb: &[u8], w: u32, h: u32) -> Vec<u8> {
    let img: image::RgbImage = image::ImageBuffer::from_raw(w, h, rgb.to_vec()).unwrap();
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
    encoder.encode_image(&img).unwrap();
    buf
}

/// Raw (undecoded) RGB buffer, uniform fill — the shape `stamp_square`
/// expects. `solid_jpeg` below is this, then JPEG-encoded; the two must
/// never be confused (stamping onto already-encoded bytes silently
/// corrupts/out-of-bounds — `stamp_square` has no way to detect it's
/// been handed compressed data).
fn raw_solid(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
    for i in 0..(w as usize) * (h as usize) {
        buf[i * 3] = fill[0];
        buf[i * 3 + 1] = fill[1];
        buf[i * 3 + 2] = fill[2];
    }
    buf
}

fn solid_jpeg(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
    jpeg_encode(&raw_solid(w, h, fill), w, h)
}

fn stamp_square(
    base_rgb: &[u8],
    w: u32,
    h: u32,
    cx: i64,
    cy: i64,
    size: i64,
    colour: [u8; 3],
) -> Vec<u8> {
    let mut buf = base_rgb.to_vec();
    let half = size / 2;
    for y in (cy - half)..=(cy + half) {
        if y < 0 || y >= h as i64 {
            continue;
        }
        for x in (cx - half)..=(cx + half) {
            if x < 0 || x >= w as i64 {
                continue;
            }
            let i = ((y as u32 * w + x as u32) as usize) * 3;
            buf[i] = colour[0];
            buf[i + 1] = colour[1];
            buf[i + 2] = colour[2];
        }
    }
    buf
}

mod unlock_ipad_tests {
    use super::*;

    /// Direct unit tests for unlock_ipad. The function is complex — slam
    /// to corner, position cursor, mouse-down, rapid drag, mouse-up,
    /// settle, screenshot. The load-bearing contract is the mouse-down /
    /// drag / mouse-up sandwich: if the button isn't held during the
    /// drag, iPadOS treats it as a hover gesture (App Switcher) instead
    /// of a touch drag (unlock).
    ///
    /// `black` bounds-detection frames deliberately fail detection (bounds
    /// stays None), keeping these tests focused on the swipe mechanics
    /// rather than bounds-detection interplay — matching the TS test
    /// suite's own use of a non-decodable 'fake-jpeg' buffer for the same
    /// isolation purpose.

    #[tokio::test]
    async fn issues_mouse_down_before_the_drag_and_mouse_up_after_sandwich_invariant() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        unlock_ipad(
            &client,
            IpadUnlockOptions {
                try_key_press_first: Some(false),
                slam_first: Some(false),
                start_x: Some(960),
                start_y: Some(800),
                drag_px: Some(100),
                chunk_mickeys: Some(25.0),
                slam_pace_ms: Some(0),
                post_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let recorded = calls.lock().unwrap().clone();
        let down_idx = recorded.iter().position(|c| *c == Call::MouseDown).unwrap();
        let up_idx = recorded.iter().position(|c| *c == Call::MouseUp).unwrap();
        assert!(up_idx > down_idx);

        for (i, c) in recorded.iter().enumerate() {
            if let Call::Move { dy, .. } = c {
                if *dy < 0.0 {
                    assert!(i > down_idx && i < up_idx);
                }
            }
        }
    }

    #[tokio::test]
    async fn drag_direction_is_upward_negative_y() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        unlock_ipad(
            &client,
            IpadUnlockOptions {
                try_key_press_first: Some(false),
                slam_first: Some(false),
                start_x: Some(960),
                start_y: Some(800),
                drag_px: Some(100),
                chunk_mickeys: Some(25.0),
                slam_pace_ms: Some(0),
                post_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let recorded = calls.lock().unwrap().clone();
        let down_idx = recorded.iter().position(|c| *c == Call::MouseDown).unwrap();
        let up_idx = recorded.iter().position(|c| *c == Call::MouseUp).unwrap();
        for c in &recorded[down_idx + 1..up_idx] {
            if let Call::Move { dx, dy } = c {
                assert_eq!(*dx, 0.0);
                assert!(*dy < 0.0);
            }
        }
    }

    #[tokio::test]
    async fn total_drag_distance_equals_drag_px() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        unlock_ipad(
            &client,
            IpadUnlockOptions {
                try_key_press_first: Some(false),
                slam_first: Some(false),
                start_x: Some(960),
                start_y: Some(800),
                drag_px: Some(800),
                chunk_mickeys: Some(30.0),
                slam_pace_ms: Some(0),
                post_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let recorded = calls.lock().unwrap().clone();
        let down_idx = recorded.iter().position(|c| *c == Call::MouseDown).unwrap();
        let up_idx = recorded.iter().position(|c| *c == Call::MouseUp).unwrap();
        let total: f64 = recorded[down_idx + 1..up_idx]
            .iter()
            .filter_map(|c| {
                if let Call::Move { dy, .. } = c {
                    Some(dy)
                } else {
                    None
                }
            })
            .sum();
        assert_eq!(total.abs(), 800.0);
    }

    #[tokio::test]
    async fn each_drag_chunk_is_at_most_chunk_mickeys() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        unlock_ipad(
            &client,
            IpadUnlockOptions {
                try_key_press_first: Some(false),
                slam_first: Some(false),
                start_x: Some(960),
                start_y: Some(800),
                drag_px: Some(200),
                chunk_mickeys: Some(25.0),
                slam_pace_ms: Some(0),
                post_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let recorded = calls.lock().unwrap().clone();
        let down_idx = recorded.iter().position(|c| *c == Call::MouseDown).unwrap();
        let up_idx = recorded.iter().position(|c| *c == Call::MouseUp).unwrap();
        for c in &recorded[down_idx + 1..up_idx] {
            if let Call::Move { dy, .. } = c {
                assert!(dy.abs() <= 25.0);
            }
        }
    }

    #[tokio::test]
    async fn chunk_mickeys_30_over_800_px_yields_27_chunks() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
        let result = unlock_ipad(
            &client,
            IpadUnlockOptions {
                try_key_press_first: Some(false),
                slam_first: Some(false),
                start_x: Some(960),
                start_y: Some(800),
                drag_px: Some(800),
                chunk_mickeys: Some(30.0),
                slam_pace_ms: Some(0),
                post_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // 800 / 30 = 26.67 → 27 chunks.
        assert_eq!(result.chunk_count, 27);
    }

    #[tokio::test]
    async fn slam_first_true_slams_to_top_left_before_swipe() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        // Bounds detection: black frame, fails → LEGACY_PORTRAIT_SLAM_ORIGIN.
        // Verify: identical-ish frames with a cluster near (5,5) → verified.
        let black = solid_jpeg(1920, 1080, [0, 0, 0]);
        let before_rgb = raw_solid(1920, 1080, [50, 50, 50]);
        let before = jpeg_encode(&before_rgb, 1920, 1080);
        let after = jpeg_encode(
            &stamp_square(&before_rgb, 1920, 1080, 5, 5, 10, [255, 255, 255]),
            1920,
            1080,
        );
        // Trace: caller-asserted origin resolution detects fresh (black,
        // fails) -> None; slam_to_corner's own before/after verify capture
        // (before, after).
        let (client, calls, _shots) = stub_client((1920, 1080), vec![black, before, after]);
        unlock_ipad(
            &client,
            IpadUnlockOptions {
                try_key_press_first: Some(false),
                slam_first: Some(true),
                start_x: Some(960),
                start_y: Some(800),
                drag_px: Some(100),
                chunk_mickeys: Some(25.0),
                slam_pace_ms: Some(0),
                post_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let recorded = calls.lock().unwrap().clone();
        // Mirrors the TS test's own findIndex predicate exactly: only a
        // Move call with the WRONG deltas counts as "found" — a
        // Screenshot/GetResolution call from the preceding bounds
        // detection is skipped over, not treated as ending the slam run.
        let first_non_slam_idx = recorded
            .iter()
            .position(|c| matches!(c, Call::Move { dx, dy } if *dx != -127.0 || *dy != -127.0))
            .unwrap();
        assert!(first_non_slam_idx > 5);
    }

    #[tokio::test]
    async fn slam_first_false_skips_slam_no_minus127_calls() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        unlock_ipad(
            &client,
            IpadUnlockOptions {
                try_key_press_first: Some(false),
                slam_first: Some(false),
                start_x: Some(960),
                start_y: Some(800),
                drag_px: Some(100),
                chunk_mickeys: Some(25.0),
                slam_pace_ms: Some(0),
                post_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let recorded = calls.lock().unwrap().clone();
        let slam_moves = recorded
            .iter()
            .filter(|c| matches!(c, Call::Move { dx, dy } if *dx == -127.0 && *dy == -127.0))
            .count();
        assert_eq!(slam_moves, 0);
    }

    #[tokio::test]
    async fn returns_chunk_count_drag_px_swipe_duration_ms_in_the_result() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
        let r = unlock_ipad(
            &client,
            IpadUnlockOptions {
                try_key_press_first: Some(false),
                slam_first: Some(false),
                start_x: Some(960),
                start_y: Some(800),
                drag_px: Some(200),
                chunk_mickeys: Some(25.0),
                slam_pace_ms: Some(0),
                post_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(r.drag_px, 200);
        assert_eq!(r.chunk_count, 8); // 200 / 25 = 8
    }

    mod phase_210_217_try_key_press_first {
        use super::*;

        #[tokio::test]
        async fn emits_escape_enter_space_before_the_swipe_legacy_behavior_with_swipe_on_key_press_failure_false(
        ) {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
            unlock_ipad(
                &client,
                IpadUnlockOptions {
                    swipe_on_key_press_failure: Some(false),
                    slam_first: Some(false),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    slam_pace_ms: Some(0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            let key_details: Vec<&str> = recorded
                .iter()
                .filter_map(|c| {
                    if let Call::SendKey(k) = c {
                        Some(k.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            assert!(key_details.contains(&"Escape"));
            assert!(key_details.contains(&"Enter"));
            assert!(key_details.contains(&"Space"));
            let enter_idx = recorded
                .iter()
                .position(|c| *c == Call::SendKey("Enter".to_string()))
                .unwrap();
            let first_swipe_idx = recorded.iter().position(|c| *c == Call::MouseDown).unwrap();
            assert!(enter_idx < first_swipe_idx);
        }

        #[tokio::test]
        async fn enter_precedes_space_the_documented_phase_217_ordering() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
            unlock_ipad(
                &client,
                IpadUnlockOptions {
                    slam_first: Some(false),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    slam_pace_ms: Some(0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            let enter_idx = recorded
                .iter()
                .position(|c| *c == Call::SendKey("Enter".to_string()))
                .unwrap();
            let space_idx = recorded
                .iter()
                .position(|c| *c == Call::SendKey("Space".to_string()))
                .unwrap();
            assert!(enter_idx < space_idx);
        }

        #[tokio::test]
        async fn by_default_swipe_is_skipped_after_successful_key_press() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
            unlock_ipad(
                &client,
                IpadUnlockOptions {
                    slam_first: Some(false),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    slam_pace_ms: Some(0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            assert!(recorded.iter().any(|c| matches!(c, Call::SendKey(_))));
            assert!(!recorded.contains(&Call::MouseDown));
        }

        #[tokio::test]
        async fn swipe_on_key_press_failure_false_forces_swipe_even_after_keys() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
            unlock_ipad(
                &client,
                IpadUnlockOptions {
                    swipe_on_key_press_failure: Some(false),
                    slam_first: Some(false),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    slam_pace_ms: Some(0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            assert!(recorded.iter().any(|c| matches!(c, Call::SendKey(_))));
            assert_eq!(
                recorded.iter().filter(|c| **c == Call::MouseDown).count(),
                1
            );
        }

        #[tokio::test]
        async fn skips_the_key_press_when_try_key_press_first_false() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
            unlock_ipad(
                &client,
                IpadUnlockOptions {
                    try_key_press_first: Some(false),
                    slam_first: Some(false),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    slam_pace_ms: Some(0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            assert!(!recorded.iter().any(|c| matches!(c, Call::SendKey(_))));
        }
    }

    mod slam_verify_motion_retry {
        use super::*;

        #[tokio::test]
        async fn retries_the_key_sequence_once_and_re_slams_when_the_first_slam_does_not_verify() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let frozen = solid_jpeg(1920, 1080, [50, 50, 50]);
            // Trace: origin resolution detect (black, fails) -> None;
            // 1st slam verify before/after (frozen, frozen, no diff ->
            // not verified); key-sequence-retry sends Escape/Enter/Space;
            // 2nd slam verify before/after (frozen, frozen again — still
            // not verified, matching the TS test's exact "still fails"
            // input, which nonetheless completes the swipe below).
            let (client, calls, _shots) = stub_client(
                (1920, 1080),
                vec![
                    black,
                    frozen.clone(),
                    frozen.clone(),
                    frozen.clone(),
                    frozen,
                ],
            );
            let result = unlock_ipad(
                &client,
                IpadUnlockOptions {
                    try_key_press_first: Some(false),
                    slam_first: Some(true),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    slam_pace_ms: Some(0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let recorded = calls.lock().unwrap().clone();
            let key_details: Vec<&str> = recorded
                .iter()
                .filter_map(|c| {
                    if let Call::SendKey(k) = c {
                        Some(k.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(key_details, vec!["Escape", "Enter", "Space"]);

            let slam_moves = recorded
                .iter()
                .filter(|c| matches!(c, Call::Move { dx, dy } if *dx == -127.0 && *dy == -127.0))
                .count();
            assert!(slam_moves >= 56); // 2 x 28 full slam batches at 1920x1080

            assert_eq!(result.slam_verified, Some(false));
            assert!(result.message.contains("WARNING"));
            assert!(recorded.contains(&Call::MouseDown));
            assert!(recorded.contains(&Call::MouseUp));
        }

        #[tokio::test]
        async fn does_not_retry_when_the_first_slam_verifies() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let before_rgb = raw_solid(1920, 1080, [50, 50, 50]);
            let before = jpeg_encode(&before_rgb, 1920, 1080);
            let after = jpeg_encode(
                &stamp_square(&before_rgb, 1920, 1080, 5, 5, 10, [255, 255, 255]),
                1920,
                1080,
            );
            let (client, calls, _shots) = stub_client((1920, 1080), vec![black, before, after]);
            let result = unlock_ipad(
                &client,
                IpadUnlockOptions {
                    try_key_press_first: Some(false),
                    slam_first: Some(true),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    slam_pace_ms: Some(0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let recorded = calls.lock().unwrap().clone();
            assert!(!recorded.iter().any(|c| matches!(c, Call::SendKey(_))));
            assert_eq!(result.slam_verified, Some(true));
            assert!(!result.message.contains("WARNING"));
        }

        #[tokio::test]
        async fn recovers_when_the_retry_succeeds_only_one_key_retry_no_second_retry() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let frozen = solid_jpeg(1920, 1080, [50, 50, 50]);
            let retry_before_rgb = raw_solid(1920, 1080, [60, 60, 60]);
            let retry_before = jpeg_encode(&retry_before_rgb, 1920, 1080);
            let retry_after = jpeg_encode(
                &stamp_square(&retry_before_rgb, 1920, 1080, 5, 5, 10, [255, 255, 255]),
                1920,
                1080,
            );
            let (client, calls, _shots) = stub_client(
                (1920, 1080),
                vec![black, frozen.clone(), frozen, retry_before, retry_after],
            );
            let result = unlock_ipad(
                &client,
                IpadUnlockOptions {
                    try_key_press_first: Some(false),
                    slam_first: Some(true),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    slam_pace_ms: Some(0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let recorded = calls.lock().unwrap().clone();
            let key_details: Vec<&str> = recorded
                .iter()
                .filter_map(|c| {
                    if let Call::SendKey(k) = c {
                        Some(k.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(key_details, vec!["Escape", "Enter", "Space"]);
            assert_eq!(result.slam_verified, Some(true));
            assert!(!result.message.contains("WARNING"));
        }

        #[tokio::test]
        async fn slam_first_false_never_performs_the_verify_motion_check_slam_verified_none() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
            let result = unlock_ipad(
                &client,
                IpadUnlockOptions {
                    try_key_press_first: Some(false),
                    slam_first: Some(false),
                    start_x: Some(960),
                    start_y: Some(800),
                    drag_px: Some(100),
                    chunk_mickeys: Some(25.0),
                    post_settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(result.slam_verified, None);
        }
    }
}

mod ipad_go_home_tests {
    use super::*;

    #[tokio::test]
    async fn sends_cmd_h_metaleft_keyh_to_dismiss_the_foreground_app() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        ipad_go_home(
            &client,
            IpadHomeOptions {
                settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let recorded = calls.lock().unwrap().clone();
        // send_shortcut(["MetaLeft", "KeyH"]) decomposes into: Meta down,
        // KeyH tap, Meta up (see kvmd-client's send_shortcut doc).
        // client.screenshot() force-refreshes resolution internally (to
        // compute scale_x/scale_y) — GetResolution is a real second REST
        // call it makes, not a TS-mock artifact.
        assert_eq!(
            recorded,
            vec![
                Call::KeyDown("MetaLeft".to_string()),
                Call::SendKey("KeyH".to_string()),
                Call::KeyUp("MetaLeft".to_string()),
                Call::Screenshot,
                Call::GetResolution,
            ]
        );
    }

    #[tokio::test]
    async fn returns_a_non_empty_message_warning_that_cmd_h_does_not_unlock() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
        let result = ipad_go_home(
            &client,
            IpadHomeOptions {
                settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(result.message.contains("Cmd+H"));
        assert!(result.message.to_lowercase().contains("unlock"));
    }

    mod force_home_via_swipe {
        use super::*;

        #[tokio::test]
        async fn default_false_only_cmd_h_is_sent_no_mouse_activity() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
            ipad_go_home(
                &client,
                IpadHomeOptions {
                    settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            assert!(!recorded
                .iter()
                .any(|c| matches!(c, Call::Move { .. } | Call::MouseDown | Call::MouseUp)));
        }

        #[tokio::test]
        async fn true_cmd_h_followed_by_slam_mouse_down_upward_drag_mouse_up() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            // capture_verification detects fresh bounds (black, fails) ->
            // None, then slam_to_corner's own before/after verify capture
            // (identical black frames -> not verified, but the swipe
            // still runs regardless of verification outcome).
            let (client, calls, _shots) =
                stub_client((1920, 1080), vec![black.clone(), black.clone(), black]);
            ipad_go_home(
                &client,
                IpadHomeOptions {
                    settle_ms: Some(0),
                    force_home_via_swipe: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            let down_idx = recorded.iter().position(|c| *c == Call::MouseDown).unwrap();
            let up_idx = recorded.iter().position(|c| *c == Call::MouseUp).unwrap();
            assert!(up_idx > down_idx);
            let upward = recorded[down_idx + 1..up_idx]
                .iter()
                .filter(|c| matches!(c, Call::Move { dy, .. } if *dy < 0.0))
                .count();
            assert!(upward > 0);
        }

        #[tokio::test]
        async fn defensive_esc_enter_is_not_sent_when_force_home_via_swipe_false() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
            ipad_go_home(
                &client,
                IpadHomeOptions {
                    settle_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            assert!(!recorded
                .iter()
                .any(|c| matches!(c, Call::SendKey(k) if k == "Escape" || k == "Enter")));
        }

        #[tokio::test]
        async fn deposit_emits_are_chunked_no_single_emit_over_127_px() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let (client, calls, _shots) =
                stub_client((1920, 1080), vec![black.clone(), black.clone(), black]);
            ipad_go_home(
                &client,
                IpadHomeOptions {
                    settle_ms: Some(0),
                    force_home_via_swipe: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            for c in &recorded {
                if let Call::Move { dx, dy } = c {
                    assert!(dx.abs() <= 127.0);
                    assert!(dy.abs() <= 127.0);
                }
            }
        }

        /// 2026-08-24 migration's one intentional behavior change: the
        /// pre-swipe slam is now verified, and a failed check triggers its
        /// own Esc+Enter (in addition to Phase 231's own unconditional
        /// post-swipe pair) — a black-frame verify pair deterministically
        /// fails (no diff), exercising the recovery path without needing
        /// real image fixtures.
        #[tokio::test]
        async fn pre_swipe_slam_is_verified_and_a_failed_check_triggers_its_own_esc_enter() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let (client, calls, _shots) =
                stub_client((1920, 1080), vec![black.clone(), black.clone(), black]);
            let result = ipad_go_home(
                &client,
                IpadHomeOptions {
                    settle_ms: Some(0),
                    force_home_via_swipe: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            // Two Escape+Enter pairs total: one from the pre-swipe
            // defensive-keys recovery, one from the unconditional
            // post-swipe Phase 231 block.
            let recorded = calls.lock().unwrap().clone();
            let escapes = recorded
                .iter()
                .filter(|c| matches!(c, Call::SendKey(k) if k == "Escape"))
                .count();
            let enters = recorded
                .iter()
                .filter(|c| matches!(c, Call::SendKey(k) if k == "Enter"))
                .count();
            assert_eq!(escapes, 2);
            assert_eq!(enters, 2);
            assert!(result.message.contains("did not verify"));
        }
    }
}

mod launch_ipad_app_tests {
    use super::*;

    #[tokio::test]
    async fn throws_on_empty_app_name() {
        let _guard = TEST_LOCK.lock().await;
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
        let err = launch_ipad_app(
            &client,
            "",
            IpadLaunchAppOptions {
                unlock_first: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("appName"));
    }

    #[tokio::test]
    async fn throws_on_whitespace_only_app_name() {
        let _guard = TEST_LOCK.lock().await;
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
        let err = launch_ipad_app(
            &client,
            "   ",
            IpadLaunchAppOptions {
                unlock_first: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("appName"));
    }

    #[tokio::test]
    async fn issues_cmd_space_type_appname_enter_sequence_in_that_order() {
        let _guard = TEST_LOCK.lock().await;
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        launch_ipad_app(
            &client,
            "Settings",
            IpadLaunchAppOptions {
                unlock_first: Some(false),
                spotlight_settle_ms: Some(0),
                post_type_settle_ms: Some(0),
                launch_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let recorded = calls.lock().unwrap().clone();
        // Cmd+Space decomposes into MetaLeft down, Space tap, MetaLeft up.
        assert_eq!(
            &recorded[0..4],
            &[
                Call::KeyDown("MetaLeft".to_string()),
                Call::SendKey("Space".to_string()),
                Call::KeyUp("MetaLeft".to_string()),
                Call::Type("Settings".to_string()),
            ]
        );
        assert_eq!(recorded[4], Call::SendKey("Enter".to_string()));
    }

    #[tokio::test]
    async fn captures_a_screenshot_after_launch() {
        let _guard = TEST_LOCK.lock().await;
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        launch_ipad_app(
            &client,
            "Maps",
            IpadLaunchAppOptions {
                unlock_first: Some(false),
                spotlight_settle_ms: Some(0),
                post_type_settle_ms: Some(0),
                launch_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(calls.lock().unwrap().contains(&Call::Screenshot));
    }

    #[tokio::test]
    async fn returned_result_contains_the_app_name_dimensions_message() {
        let _guard = TEST_LOCK.lock().await;
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
        let result = launch_ipad_app(
            &client,
            "Files",
            IpadLaunchAppOptions {
                unlock_first: Some(false),
                spotlight_settle_ms: Some(0),
                post_type_settle_ms: Some(0),
                launch_settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(result.app_name, "Files");
        assert_eq!(result.screenshot_width, 1920);
        assert_eq!(result.screenshot_height, 1080);
        assert!(result.message.contains("Files"));
        assert!(!result.unlocked);
    }
}

mod ipad_open_app_switcher_tests {
    use super::*;

    #[tokio::test]
    async fn issues_the_cmd_down_tab_screenshot_cmd_up_sequence() {
        let _guard = TEST_LOCK.lock().await;
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        ipad_open_app_switcher(
            &client,
            IpadAppSwitcherOptions {
                hold_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            calls.lock().unwrap().clone(),
            vec![
                Call::KeyDown("MetaLeft".to_string()),
                Call::SendKey("Tab".to_string()),
                Call::Screenshot,
                Call::GetResolution,
                Call::KeyUp("MetaLeft".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn captures_the_screenshot_while_cmd_is_held_not_after_release() {
        let _guard = TEST_LOCK.lock().await;
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        ipad_open_app_switcher(
            &client,
            IpadAppSwitcherOptions {
                hold_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let recorded = calls.lock().unwrap().clone();
        let shot_idx = recorded
            .iter()
            .position(|c| *c == Call::Screenshot)
            .unwrap();
        let up_idx = recorded
            .iter()
            .position(|c| *c == Call::KeyUp("MetaLeft".to_string()))
            .unwrap();
        assert!(shot_idx < up_idx);
    }

    #[tokio::test]
    async fn returns_the_screenshot_from_the_app_switcher() {
        let _guard = TEST_LOCK.lock().await;
        let shot = solid_jpeg(1920, 1080, [10, 20, 30]);
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![shot.clone()]);
        let result = ipad_open_app_switcher(
            &client,
            IpadAppSwitcherOptions {
                hold_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(result.screenshot, shot);
        assert_eq!(result.screenshot_width, 1920);
        assert_eq!(result.screenshot_height, 1080);
    }

    #[tokio::test]
    async fn returns_a_non_empty_message_describing_the_app_switcher_state() {
        let _guard = TEST_LOCK.lock().await;
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
        let result = ipad_open_app_switcher(
            &client,
            IpadAppSwitcherOptions {
                hold_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(result.message.contains("App Switcher"));
    }
}

mod unlock_ipad_with_code_tests {
    use super::*;

    #[tokio::test]
    async fn sends_space_space_digit_n_per_digit_then_enter() {
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        let result = unlock_ipad_with_code(
            &client,
            "1234",
            UnlockWithCodeOptions {
                wake_wait_ms: Some(0),
                per_digit_ms: Some(0),
            },
        )
        .await
        .unwrap();
        let recorded = calls.lock().unwrap().clone();
        let keys: Vec<&str> = recorded
            .iter()
            .filter_map(|c| {
                if let Call::SendKey(k) = c {
                    Some(k.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            keys,
            vec!["Space", "Space", "Digit1", "Digit2", "Digit3", "Digit4", "Enter"]
        );
        assert_eq!(result.digits_sent, 4);
    }

    #[tokio::test]
    async fn handles_a_6_digit_passcode() {
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        let result = unlock_ipad_with_code(
            &client,
            "987654",
            UnlockWithCodeOptions {
                wake_wait_ms: Some(0),
                per_digit_ms: Some(0),
            },
        )
        .await
        .unwrap();
        let recorded = calls.lock().unwrap().clone();
        let keys: Vec<&str> = recorded
            .iter()
            .filter_map(|c| {
                if let Call::SendKey(k) = c {
                    Some(k.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            &keys[2..8],
            &["Digit9", "Digit8", "Digit7", "Digit6", "Digit5", "Digit4"]
        );
        assert_eq!(result.digits_sent, 6);
    }

    #[tokio::test]
    async fn throws_on_non_digit_characters_before_any_hid_activity() {
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        let err = unlock_ipad_with_code(
            &client,
            "12a4",
            UnlockWithCodeOptions {
                wake_wait_ms: Some(0),
                per_digit_ms: Some(0),
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("4–10 decimal digits"));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn throws_on_too_short_code_before_any_hid_activity() {
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        let err = unlock_ipad_with_code(
            &client,
            "123",
            UnlockWithCodeOptions {
                wake_wait_ms: Some(0),
                per_digit_ms: Some(0),
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("4–10 decimal digits"));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn throws_on_too_long_code_before_any_hid_activity() {
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        let err = unlock_ipad_with_code(
            &client,
            "12345678901",
            UnlockWithCodeOptions {
                wake_wait_ms: Some(0),
                per_digit_ms: Some(0),
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("4–10 decimal digits"));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn throws_on_empty_code_before_any_hid_activity() {
        let (client, calls, _shots) = stub_client((1920, 1080), vec![]);
        let err = unlock_ipad_with_code(
            &client,
            "",
            UnlockWithCodeOptions {
                wake_wait_ms: Some(0),
                per_digit_ms: Some(0),
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("4–10 decimal digits"));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn result_reports_only_the_count_never_the_code_itself() {
        let (client, _calls, _shots) = stub_client((1920, 1080), vec![]);
        let result = unlock_ipad_with_code(
            &client,
            "4321",
            UnlockWithCodeOptions {
                wake_wait_ms: Some(0),
                per_digit_ms: Some(0),
            },
        )
        .await
        .unwrap();
        assert_eq!(result, UnlockWithCodeResult { digits_sent: 4 });
    }
}
