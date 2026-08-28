//! Tests for `cursor_anchor.rs`. Split into its own file (Rust 2018+
//! submodule layout) per the idiomatic-file-structure standing rule —
//! the test module alone was over 800 lines, more than the
//! implementation it exercises.

use super::*;
use pikvm_mcp_detection_vision::orientation::{
    clear_orientation_cache, detect_ipad_bounds_from_buffer,
};
use pikvm_mcp_kvmd_client::client::{
    ClientError, PiKVMConfig, RequestArgs, RequestFn, ResponseBody,
};
use std::sync::Mutex as StdMutex;

// slam_to_corner (called by every test here) touches the same
// process-global emit_clock and orientation bounds cache slam.rs's and
// cursor_keepalive.rs's own tests touch — serialize against the
// crate-wide lock, not a file-local one. See
// `crate::test_support::GLOBAL_STATE_LOCK`'s doc for why a per-file
// lock silently fails to do this.
use crate::test_support::GLOBAL_STATE_LOCK as TEST_LOCK;

type Moves = Arc<StdMutex<Vec<(f64, f64)>>>;
type Keys = Arc<StdMutex<Vec<String>>>;
type ShotCalls = Arc<StdMutex<usize>>;

fn parse_delta(path: &str) -> (f64, f64) {
    let mut dx = 0.0;
    let mut dy = 0.0;
    for pair in path.split('?').nth(1).unwrap_or("").split('&') {
        if let Some(v) = pair.strip_prefix("delta_x=") {
            dx = v.parse().unwrap();
        } else if let Some(v) = pair.strip_prefix("delta_y=") {
            dy = v.parse().unwrap();
        }
    }
    (dx, dy)
}

fn parse_key(path: &str) -> String {
    path.split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .find_map(|p| p.strip_prefix("key="))
        .unwrap_or("")
        .to_string()
}

/// Unlike cursor-anchor.test.ts's `mockClientAndScreenshot` (which mocks
/// bounds-detection's `client.screenshot()` and the verification
/// `req.screenshot` closure as two INDEPENDENT frame streams/counters),
/// this port's `AnchorRequest.screenshot` is a `ScreenshotMode` that
/// resolves to the SAME `PiKVMClient::screenshot`/
/// `screenshot_keeping_cursor_alive` calls bounds detection also uses —
/// there's only one real HTTP endpoint either way. So `screenshots`
/// here is a SINGLE ordered sequence covering every real
/// `client.screenshot()`-family call in a test, bounds-detection and
/// verification alike, traced call-by-call against `anchor_cursor`'s
/// and `slam_to_corner`'s actual code paths (see each test's own
/// comment for its trace). An empty `screenshots` list makes the
/// `/streamer/snapshot` stub error instead of panicking, matching the
/// TS mock's own behavior when its `boundsFrames` defaults to `[]`
/// (indexing `undefined`, caught by `detectBoundsOrNull`'s try/catch).
fn stub_client(
    resolution: (u32, u32),
    screenshots: Vec<Vec<u8>>,
) -> (Arc<PiKVMClient>, Moves, Keys, ShotCalls) {
    let (w, h) = resolution;
    let moves: Moves = Arc::new(StdMutex::new(Vec::new()));
    let moves_bg = moves.clone();
    let keys: Keys = Arc::new(StdMutex::new(Vec::new()));
    let keys_bg = keys.clone();
    let shot_calls: ShotCalls = Arc::new(StdMutex::new(0));
    let shot_calls_bg = shot_calls.clone();
    let screenshots = Arc::new(screenshots);
    let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
        let moves = moves_bg.clone();
        let keys = keys_bg.clone();
        let shot_calls = shot_calls_bg.clone();
        let screenshots = screenshots.clone();
        Box::pin(async move {
            if args.path.starts_with("/hid/events/send_mouse_relative") {
                moves.lock().unwrap().push(parse_delta(&args.path));
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/hid/events/send_key") {
                keys.lock().unwrap().push(parse_key(&args.path));
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/streamer/snapshot") {
                let mut i = shot_calls.lock().unwrap();
                if screenshots.is_empty() {
                    *i += 1;
                    return Err(ClientError::Other(
                        "no screenshot frame configured for this test".to_string(),
                    ));
                }
                let idx = (*i).min(screenshots.len() - 1);
                *i += 1;
                return Ok(ResponseBody::Image(screenshots[idx].clone()));
            }
            if args.path == "/streamer" {
                return Ok(ResponseBody::Json(serde_json::json!({
                    "ok": true,
                    "result": { "streamer": { "source": { "online": true, "resolution": { "width": w, "height": h } } } }
                })));
            }
            Ok(ResponseBody::Empty)
        })
    });
    // 127.0.0.1 on a reserved/closed port, not "mock.local" — same
    // reasoning as slam.rs's stub_client.
    let client = Arc::new(PiKVMClient::with_request_fn(
        PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
        None,
        request_fn,
    ));
    (client, moves, keys, shot_calls)
}

fn jpeg_encode(rgb: &[u8], w: u32, h: u32) -> Vec<u8> {
    let img: image::RgbImage = image::ImageBuffer::from_raw(w, h, rgb.to_vec()).unwrap();
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
    encoder.encode_image(&img).unwrap();
    buf
}

fn solid_jpeg(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
    for i in 0..(w as usize) * (h as usize) {
        buf[i * 3] = fill[0];
        buf[i * 3 + 1] = fill[1];
        buf[i * 3 + 2] = fill[2];
    }
    jpeg_encode(&buf, w, h)
}

fn decode_rgb(jpeg: &[u8]) -> Vec<u8> {
    image::load_from_memory(jpeg).unwrap().to_rgb8().into_raw()
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

/// An iPad-portrait letterbox frame: black bars outside the content
/// region, bright grey inside. Same construction as slam.rs's own
/// `make_ipad_portrait_frame` (and the TS test's `makeIpadPortraitFrame`).
fn make_ipad_portrait_frame() -> Vec<u8> {
    let (w, h) = (1920u32, 1080u32);
    let mut data = vec![0u8; (w as usize) * (h as usize) * 3];
    let (ipad_x0, ipad_x1) = (625i64, 1295i64);
    for y in 0..h as i64 {
        for x in ipad_x0..=ipad_x1 {
            let i = ((y as u32 * w + x as u32) as usize) * 3;
            data[i] = 200;
            data[i + 1] = 200;
            data[i + 2] = 200;
        }
    }
    jpeg_encode(&data, w, h)
}

/// A landscape-ish "iPad content" frame — bright content the full frame
/// width, which the bounds detector reads as landscape orientation
/// (knownNonIpad).
fn make_landscape_frame() -> Vec<u8> {
    solid_jpeg(1920, 1080, [200, 200, 200])
}

fn default_req(client: Arc<PiKVMClient>, guard: AnchorGuard) -> AnchorRequest {
    AnchorRequest {
        client,
        corner: None,
        guard,
        screenshot: ScreenshotMode::Raw,
        capture_verification: false,
        recovery: AnchorRecoveryPosture::InspectOnly,
        nudge: None,
        pace_ms: Some(0),
        slam_origin_px: None,
        verbose: false,
    }
}

mod bounds_guard {
    use super::*;

    #[tokio::test]
    async fn throws_the_byte_identical_error_when_bounds_detection_fails_undetermined_target() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(1920, 1080, [0, 0, 0]);
        let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![black]);
        let err = anchor_cursor(default_req(
            client,
            AnchorGuard::BoundsGuard {
                allow_on_undetermined: false,
            },
        ))
        .await
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "moveToPixel: refusing slam-then-move — target type undetermined \
             (bounds detection failed — frame too dark or unrecognised) and \
             slam-origin defaulted to LEGACY_PORTRAIT, which presumes iPad. \
             Slam-to-corner on an iPad triggers the iPadOS hot-corner gesture and \
             re-locks the screen mid-session. Options: \
             (1) use strategy='detect-then-move' (recommended for iPad), \
             (2) pass slamOriginPx explicitly if you know the target is non-iPad, \
             (3) pass forbidSlamOnIpad=false to opt out (only safe if iPad \
             hot-corners are disabled)."
        );
        assert!(moves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn throws_when_an_ipad_portrait_letterbox_is_detected() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let portrait = make_ipad_portrait_frame();
        let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![portrait]);
        let err = anchor_cursor(default_req(
            client,
            AnchorGuard::BoundsGuard {
                allow_on_undetermined: false,
            },
        ))
        .await
        .unwrap_err();
        assert!(err.to_string().contains("iPad-portrait letterbox detected"));
        assert!(moves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn does_not_throw_when_bounds_are_detected_as_landscape_known_non_ipad() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let landscape = make_landscape_frame();
        let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![landscape]);
        let result = anchor_cursor(default_req(
            client,
            AnchorGuard::BoundsGuard {
                allow_on_undetermined: false,
            },
        ))
        .await
        .unwrap();
        assert!(!moves.lock().unwrap().is_empty());
        assert_eq!(
            result.bounds.map(|b| b.orientation),
            Some(IpadOrientation::Landscape)
        );
    }

    #[tokio::test]
    async fn does_not_throw_when_the_caller_passes_an_explicit_slam_origin_px() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(1920, 1080, [0, 0, 0]);
        let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![black]);
        let mut req = default_req(
            client,
            AnchorGuard::BoundsGuard {
                allow_on_undetermined: false,
            },
        );
        req.slam_origin_px = Some((50, 50));
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.origin, (50, 50));
        assert!(!moves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn allow_on_undetermined_true_skips_the_refusal_but_keeps_the_same_origin_computation() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(1920, 1080, [0, 0, 0]);
        let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![black]);
        let result = anchor_cursor(default_req(
            client,
            AnchorGuard::BoundsGuard {
                allow_on_undetermined: true,
            },
        ))
        .await
        .unwrap();
        // Bounds detection failed → falls back to LEGACY_PORTRAIT_SLAM_ORIGIN,
        // same as the always-refuse path would have computed had it not thrown.
        assert_eq!(result.origin, LEGACY_PORTRAIT_SLAM_ORIGIN);
        assert!(!moves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn capture_verification_defaults_false_zero_verification_screenshots_taken() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let landscape = make_landscape_frame();
        let (client, _moves, _keys, shots) = stub_client((1920, 1080), vec![landscape]);
        let result = anchor_cursor(default_req(
            client,
            AnchorGuard::BoundsGuard {
                allow_on_undetermined: false,
            },
        ))
        .await
        .unwrap();
        // Exactly the one bounds-detection screenshot the guard itself
        // took — slam_to_corner never calls take_screenshot when
        // verify_motion is false.
        assert_eq!(*shots.lock().unwrap(), 1);
        assert_eq!(result.verified, None);
        assert!(!result.recovery_attempted);
    }
}

mod caller_asserted_unset {
    use super::*;

    #[tokio::test]
    async fn never_throws_even_against_an_undetermined_black_frame() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(1920, 1080, [0, 0, 0]);
        let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![black]);
        let result = anchor_cursor(default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "lock screen has no active hot corner".to_string(),
            },
        ))
        .await
        .unwrap();
        assert_eq!(result.verified, None);
        assert!(!moves.lock().unwrap().is_empty());
    }
}

mod caller_asserted_recovery_throw {
    use super::*;

    #[tokio::test]
    async fn throws_when_verification_fails_and_recovery_is_explicitly_throw() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let frozen = solid_jpeg(400, 300, [50, 50, 50]);
        // Trace: (1) resolve_caller_asserted_origin's own detect — black,
        // fails. (2) anchor_cursor's verification_bounds re-detect
        // (resolved.bounds still None, cache still empty) — black again,
        // fails. (3)/(4) slam_to_corner's before/after verify capture —
        // identical frozen frames, no diff.
        let (client, _moves, keys, _shots) = stub_client(
            (400, 300),
            vec![black.clone(), black, frozen.clone(), frozen],
        );
        let mut req = default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "test".to_string(),
            },
        );
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::Throw;
        let err = anchor_cursor(req).await.unwrap_err();
        assert!(err.to_string().contains("slam motion did not verify"));
        assert!(err.to_string().contains("recovery:'throw'"));
        assert!(keys.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn does_not_throw_when_verification_succeeds() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let before_rgb = vec![50u8; 400 * 300 * 3];
        let after_rgb = stamp_square(&before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
        let before = jpeg_encode(&before_rgb, 400, 300);
        let after = jpeg_encode(&after_rgb, 400, 300);
        let (client, _moves, _keys, _shots) =
            stub_client((400, 300), vec![black.clone(), black, before, after]);
        let mut req = default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "test".to_string(),
            },
        );
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::Throw;
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(true));
        assert!(!result.recovery_attempted);
    }
}

mod caller_asserted_recovery_key_sequence_retry {
    use super::*;

    #[tokio::test]
    async fn verified_true_on_the_first_attempt_no_recovery_no_key_presses() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let before_rgb = vec![50u8; 400 * 300 * 3];
        let after_rgb = stamp_square(&before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
        let before = jpeg_encode(&before_rgb, 400, 300);
        let after = jpeg_encode(&after_rgb, 400, 300);
        let (client, _moves, keys, _shots) =
            stub_client((400, 300), vec![black.clone(), black, before, after]);
        let mut req = default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "test".to_string(),
            },
        );
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::KeySequenceRetry;
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(true));
        assert!(!result.recovery_attempted);
        assert!(keys.lock().unwrap().is_empty());
    }

    /// Real ~1.2s wall-clock delay: `ipad_unlock_key_sequence`'s pacing
    /// (200/600/400ms) is un-injected here, matching cursor-anchor.ts's
    /// own un-mocked `sleep` import — the TS test suite pays the same
    /// real delay (no fake timers in cursor-anchor.test.ts).
    #[tokio::test]
    async fn recovers_when_the_retry_succeeds_esc_enter_space_then_re_slam_re_verify() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let frozen = solid_jpeg(400, 300, [50, 50, 50]);
        let retry_before_rgb = vec![60u8; 400 * 300 * 3];
        let retry_after_rgb = stamp_square(&retry_before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
        let retry_before = jpeg_encode(&retry_before_rgb, 400, 300);
        let retry_after = jpeg_encode(&retry_after_rgb, 400, 300);
        let (client, _moves, keys, _shots) = stub_client(
            (400, 300),
            vec![
                black.clone(),
                black,
                frozen.clone(),
                frozen,
                retry_before,
                retry_after,
            ],
        );
        let mut req = default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "test".to_string(),
            },
        );
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::KeySequenceRetry;
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(true));
        assert!(result.recovery_attempted);
        assert_eq!(
            *keys.lock().unwrap(),
            vec![
                "Escape".to_string(),
                "Enter".to_string(),
                "Space".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn does_not_throw_even_when_the_retry_also_fails_to_verify() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let frozen = solid_jpeg(400, 300, [50, 50, 50]);
        let (client, _moves, keys, _shots) = stub_client(
            (400, 300),
            vec![
                black.clone(),
                black,
                frozen.clone(),
                frozen.clone(),
                frozen.clone(),
                frozen,
            ],
        );
        let mut req = default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "test".to_string(),
            },
        );
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::KeySequenceRetry;
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(false));
        assert!(result.recovery_attempted);
        assert_eq!(
            *keys.lock().unwrap(),
            vec![
                "Escape".to_string(),
                "Enter".to_string(),
                "Space".to_string()
            ]
        );
    }
}

mod caller_asserted_recovery_defensive_keys {
    use super::*;

    #[tokio::test]
    async fn sends_esc_enter_once_on_a_failed_verification_no_re_slam_no_throw() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let frozen = solid_jpeg(400, 300, [50, 50, 50]);
        let (client, _moves, keys, shots) = stub_client(
            (400, 300),
            vec![black.clone(), black, frozen.clone(), frozen],
        );
        let mut req = default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "test".to_string(),
            },
        );
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::DefensiveKeys;
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(false));
        assert!(result.recovery_attempted);
        assert_eq!(
            *keys.lock().unwrap(),
            vec!["Escape".to_string(), "Enter".to_string()]
        );
        // No re-attempt: exactly the 2 bounds-detection + 2 verify
        // screenshot calls this trace expects, nothing more.
        assert_eq!(*shots.lock().unwrap(), 4);
    }

    #[tokio::test]
    async fn does_not_run_recovery_when_verification_succeeds() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let before_rgb = vec![50u8; 400 * 300 * 3];
        let after_rgb = stamp_square(&before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
        let before = jpeg_encode(&before_rgb, 400, 300);
        let after = jpeg_encode(&after_rgb, 400, 300);
        let (client, _moves, keys, _shots) =
            stub_client((400, 300), vec![black.clone(), black, before, after]);
        let mut req = default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "test".to_string(),
            },
        );
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::DefensiveKeys;
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(true));
        assert!(!result.recovery_attempted);
        assert!(keys.lock().unwrap().is_empty());
    }
}

mod caller_asserted_recovery_inspect_only {
    use super::*;

    #[tokio::test]
    async fn verified_is_still_populated_on_failure_but_no_recovery_runs_and_no_throw() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let frozen = solid_jpeg(400, 300, [50, 50, 50]);
        let (client, _moves, keys, _shots) = stub_client(
            (400, 300),
            vec![black.clone(), black, frozen.clone(), frozen],
        );
        let mut req = default_req(
            client,
            AnchorGuard::CallerAsserted {
                reason: "test".to_string(),
            },
        );
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::InspectOnly;
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(false));
        assert!(!result.recovery_attempted);
        assert!(keys.lock().unwrap().is_empty());
    }
}

mod none_calibration {
    use super::*;

    #[tokio::test]
    async fn never_screenshots_for_verification_when_capture_verification_is_unset() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, moves, _keys, shots) = stub_client((400, 300), vec![]);
        let result = anchor_cursor(default_req(client, AnchorGuard::NoneCalibration))
            .await
            .unwrap();
        assert_eq!(*shots.lock().unwrap(), 0);
        assert_eq!(result.verified, None);
        assert!(result.bounds.is_none());
        // The bare slam still ran.
        assert!(!moves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn never_throws_regardless_of_what_a_screenshot_fn_would_show() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, _moves, _keys, _shots) = stub_client((400, 300), vec![]);
        anchor_cursor(default_req(client, AnchorGuard::NoneCalibration))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn runs_the_post_slam_nudge_when_requested() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, moves, _keys, _shots) = stub_client((400, 300), vec![]);
        let mut req = default_req(client, AnchorGuard::NoneCalibration);
        req.nudge = Some(AnchorNudge {
            away: Some(Corner::TopLeft),
            only_axis: Some(Axis::Y),
        });
        anchor_cursor(req).await.unwrap();
        // nudge_from_edge's default 5 calls, all in +y (away from
        // top-left, only_axis:Y zeroes dx) — on top of the slam's own
        // moves.
        let nudge_moves: Vec<_> = moves
            .lock()
            .unwrap()
            .iter()
            .filter(|(dx, dy)| *dx == 0.0 && *dy > 0.0)
            .copied()
            .collect();
        assert_eq!(nudge_moves.len(), 5);
    }

    #[tokio::test]
    async fn skips_the_nudge_when_omitted() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let (client, moves, _keys, _shots) = stub_client((400, 300), vec![]);
        anchor_cursor(default_req(client, AnchorGuard::NoneCalibration))
            .await
            .unwrap();
        let nudge_moves: Vec<_> = moves
            .lock()
            .unwrap()
            .iter()
            .filter(|(dx, dy)| *dx == 0.0 && *dy > 0.0)
            .copied()
            .collect();
        assert_eq!(nudge_moves.len(), 0);
    }

    // Regression: the nudge used to run unconditionally after the
    // verify/recovery block, even when verification had just failed —
    // wastes real HID calls nudging the cursor away from a slam the
    // caller is about to reject anyway (measureCell's exact combo).
    #[tokio::test]
    async fn skips_the_nudge_when_capture_verification_fails_even_with_inspect_only() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let frozen = solid_jpeg(400, 300, [50, 50, 50]);
        // Trace: resolve_calibration_origin makes no client calls
        // (bounds always None from it) → anchor_cursor's
        // verification_bounds fallback detects fresh (black, fails) →
        // slam_to_corner's before/after verify capture (frozen, frozen,
        // no diff).
        let (client, moves, _keys, _shots) =
            stub_client((400, 300), vec![black, frozen.clone(), frozen]);
        let mut req = default_req(client, AnchorGuard::NoneCalibration);
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::InspectOnly;
        req.nudge = Some(AnchorNudge {
            away: Some(Corner::TopLeft),
            only_axis: Some(Axis::Y),
        });
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(false));
        let nudge_moves: Vec<_> = moves
            .lock()
            .unwrap()
            .iter()
            .filter(|(dx, dy)| *dx == 0.0 && *dy > 0.0)
            .copied()
            .collect();
        assert_eq!(nudge_moves.len(), 0);
    }

    #[tokio::test]
    async fn still_runs_the_nudge_when_capture_verification_succeeds() {
        let _guard = TEST_LOCK.lock().await;
        clear_orientation_cache();
        let black = solid_jpeg(400, 300, [0, 0, 0]);
        let before_rgb = vec![50u8; 400 * 300 * 3];
        let after_rgb = stamp_square(&before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
        let before = jpeg_encode(&before_rgb, 400, 300);
        let after = jpeg_encode(&after_rgb, 400, 300);
        let (client, moves, _keys, _shots) = stub_client((400, 300), vec![black, before, after]);
        let mut req = default_req(client, AnchorGuard::NoneCalibration);
        req.capture_verification = true;
        req.recovery = AnchorRecoveryPosture::InspectOnly;
        req.nudge = Some(AnchorNudge {
            away: Some(Corner::TopLeft),
            only_axis: Some(Axis::Y),
        });
        let result = anchor_cursor(req).await.unwrap();
        assert_eq!(result.verified, Some(true));
        let nudge_moves: Vec<_> = moves
            .lock()
            .unwrap()
            .iter()
            .filter(|(dx, dy)| *dx == 0.0 && *dy > 0.0)
            .copied()
            .collect();
        assert_eq!(nudge_moves.len(), 5);
    }

    /// 2026-08-24 P0 fix regression pair (georgs-mac-mini's PR #68 gate,
    /// live-confirmed on real hardware): `guard: NoneCalibration` skips
    /// bounds detection for ORIGIN purposes, but verification still
    /// needs the iPad's real bounds when the target IS a letterboxed
    /// iPad. Before the fix, `anchor_cursor` compared against the raw
    /// capture-frame corner (0,0) regardless — inside the black
    /// letterbox bar, never where the cursor can physically land.
    mod corner_target_from_bounds_fix {
        use super::*;

        #[tokio::test]
        async fn verified_true_when_the_cluster_lands_at_the_ipads_own_detected_letterbox_corner() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let portrait = make_ipad_portrait_frame();
            let bounds =
                detect_ipad_bounds_from_buffer(&portrait, DetectOptions::default()).unwrap();
            assert!(bounds.x > 100);
            let portrait_rgb = decode_rgb(&portrait);
            let after_rgb = stamp_square(
                &portrait_rgb,
                1920,
                1080,
                bounds.x as i64 + 5,
                bounds.y as i64 + 5,
                10,
                [255, 255, 255],
            );
            let after = jpeg_encode(&after_rgb, 1920, 1080);
            // Trace: the `detect_ipad_bounds_from_buffer` call just above
            // (used to learn `bounds.x`/`.y` for stamping) already
            // populates `LAST_GOOD_BOUNDS` as a side effect, so
            // `anchor_cursor`'s own verification_bounds lookup is a
            // cache HIT (`get_last_good_bounds()`), not a fresh detect —
            // no extra screenshot call. Only slam_to_corner's own
            // before/after verify capture touches the client: portrait
            // (unstamped) then the stamped frame. Same reasoning as
            // slam.rs's own analogous test (2 frames, not 3).
            let (client, _moves, _keys, _shots) = stub_client((1920, 1080), vec![portrait, after]);
            let mut req = default_req(client, AnchorGuard::NoneCalibration);
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::InspectOnly;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(true));
        }

        #[tokio::test]
        async fn verified_false_when_the_cluster_lands_at_the_raw_frame_corner_inside_the_letterbox_bar(
        ) {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let portrait = make_ipad_portrait_frame();
            let bounds =
                detect_ipad_bounds_from_buffer(&portrait, DetectOptions::default()).unwrap();
            assert!(bounds.x > 100);
            let portrait_rgb = decode_rgb(&portrait);
            let after_rgb = stamp_square(&portrait_rgb, 1920, 1080, 5, 5, 10, [255, 255, 255]); // raw-frame (0,0) corner
            let after = jpeg_encode(&after_rgb, 1920, 1080);
            // Same cache-hit reasoning as the positive-control test
            // above — only 2 real screenshot calls (slam's before/after).
            let (client, _moves, _keys, _shots) = stub_client((1920, 1080), vec![portrait, after]);
            let mut req = default_req(client, AnchorGuard::NoneCalibration);
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::InspectOnly;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(false));
        }
    }
}
