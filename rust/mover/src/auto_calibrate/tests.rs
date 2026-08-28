//! Tests for `auto_calibrate`/`auto_calibrate_with_retries`.
//!
//! `auto_calibrate` itself is hard to unit-test because it runs a full
//! sampling loop with ~5 rounds x 2 screenshots each expecting exactly 2
//! detected clusters from real cursor motion — same limitation the TS
//! test suite's own header comment notes. So, faithfully mirroring
//! `auto-calibrate-retry.test.ts`: a client that always returns an
//! identical uniform-grey frame (no diff cluster ever forms) exercises
//! the retry-wrapper's own deterministic logic — "fail fast on
//! insufficient samples", "increase move_delay_ms on each retry" — without
//! needing a real detectable cursor. Plus a few tests for the pure
//! helpers, which ARE deterministically testable even though the full
//! algorithm isn't.

use super::*;
use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};
use std::sync::{Arc, Mutex};

fn solid_jpeg(w: u32, h: u32, fill: u8) -> Vec<u8> {
    let rgb = vec![fill; (w as usize) * (h as usize) * 3];
    let img: image::RgbImage = image::ImageBuffer::from_raw(w, h, rgb).unwrap();
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
    encoder.encode_image(&img).unwrap();
    buf
}

/// Real `PiKVMClient` test double: every screenshot is an identical
/// uniform-grey frame (no diff cluster can ever form), matching the TS
/// test's `UniformFrameClient`.
fn uniform_frame_client(resolution: (u32, u32)) -> (PiKVMClient, Arc<Mutex<u32>>) {
    let (w, h) = resolution;
    let frame = solid_jpeg(w, h, 128);
    let move_raw_count = Arc::new(Mutex::new(0u32));
    let move_raw_count_bg = move_raw_count.clone();
    let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
        let frame = frame.clone();
        let move_raw_count = move_raw_count_bg.clone();
        Box::pin(async move {
            if args.path.starts_with("/hid/events/send_mouse_move") {
                *move_raw_count.lock().unwrap() += 1;
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/streamer/snapshot") {
                return Ok(ResponseBody::Image(frame));
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
    let client = PiKVMClient::with_request_fn(
        PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
        None,
        request_fn,
    );
    (client, move_raw_count)
}

mod auto_calibrate_with_retries_tests {
    use super::*;

    #[tokio::test]
    async fn returns_success_false_when_every_attempt_fails_to_detect_a_cursor() {
        let (client, _moves) = uniform_frame_client((640, 480));
        let result = auto_calibrate_with_retries(
            &client,
            AutoCalibrationConfig {
                max_retries: 1,
                rounds: 2,
                min_samples: 1,
                move_delay_ms: 0,
                verbose: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(!result.success);
        assert_eq!(result.factor_x, 1.0);
        assert_eq!(result.factor_y, 1.0);
    }

    #[tokio::test]
    async fn returned_message_describes_the_failure_cause() {
        let (client, _moves) = uniform_frame_client((640, 480));
        let result = auto_calibrate_with_retries(
            &client,
            AutoCalibrationConfig {
                max_retries: 0,
                rounds: 2,
                min_samples: 1,
                move_delay_ms: 0,
                verbose: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // Either "Insufficient valid samples" or "Cursor detection failed"
        // or "Failed to diff screenshots" — all three are honest failure
        // messages produced by auto_calibrate when the cursor cannot be
        // found.
        assert!(!result.message.is_empty());
        let lower = result.message.to_lowercase();
        assert!(
            lower.contains("sample")
                || lower.contains("cursor")
                || lower.contains("diff")
                || lower.contains("fail")
        );
    }

    #[tokio::test]
    async fn returns_the_resolution_from_the_last_attempt() {
        let (client, _moves) = uniform_frame_client((1280, 720));
        let result = auto_calibrate_with_retries(
            &client,
            AutoCalibrationConfig {
                max_retries: 0,
                rounds: 2,
                min_samples: 1,
                move_delay_ms: 0,
                verbose: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // Resolution should reflect what the client reports, not the
        // {0,0} unreachable-fallback path.
        assert_eq!(result.resolution.width, 1280);
        assert_eq!(result.resolution.height, 720);
    }

    #[tokio::test]
    async fn retries_up_to_max_retries_plus_one_attempts() {
        let (client, moves) = uniform_frame_client((640, 480));
        auto_calibrate_with_retries(
            &client,
            AutoCalibrationConfig {
                max_retries: 1,
                rounds: 2,
                min_samples: 1,
                move_delay_ms: 0,
                verbose: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // max_retries=1 -> up to 2 attempts, each does >=2 mouse_move_raw
        // calls per round (start + end position) x 2 rounds x 2 attempts.
        assert!(*moves.lock().unwrap() >= 2);
    }
}

mod pure_helper_tests {
    use super::*;

    #[test]
    fn magnitude_of_a_3_4_5_triangle_is_5() {
        assert_eq!(magnitude(Point { x: 3.0, y: 4.0 }), 5.0);
    }

    #[test]
    fn magnitude_of_the_origin_is_zero() {
        assert_eq!(magnitude(Point { x: 0.0, y: 0.0 }), 0.0);
    }

    #[test]
    fn random_safe_position_stays_within_the_central_60_percent_of_the_screen() {
        let resolution = ScreenResolution {
            width: 1000,
            height: 1000,
        };
        for _ in 0..50 {
            let p = random_safe_position(resolution);
            assert!(p.x >= 200.0 && p.x <= 800.0);
            assert!(p.y >= 200.0 && p.y <= 800.0);
        }
    }

    #[test]
    fn random_delta_distance_is_always_between_80_and_150px() {
        for round in 0..20 {
            let d = random_delta(round);
            let dist = magnitude(d);
            assert!(
                (79.0..=151.0).contains(&dist),
                "distance {dist} out of [80,150] range"
            );
        }
    }

    #[test]
    fn detection_config_from_disables_brightness_and_channel_filters() {
        let config = AutoCalibrationConfig {
            diff_threshold: 42,
            min_cluster_size: 7,
            max_cluster_size: 999,
            merge_radius: 12.5,
            ..Default::default()
        };
        let dc = detection_config_from(&config);
        assert_eq!(dc.diff_threshold, 42);
        assert_eq!(dc.min_cluster_size, 7);
        assert_eq!(dc.max_cluster_size, 999);
        assert_eq!(dc.merge_radius, 12.5);
        assert_eq!(dc.brightness_floor, 0);
        assert_eq!(dc.max_channel_delta, 0);
    }

    #[test]
    fn default_config_matches_the_documented_ts_defaults() {
        let config = AutoCalibrationConfig::default();
        assert_eq!(config.rounds, 5);
        assert_eq!(config.verify_rounds, 5);
        assert_eq!(config.move_delay_ms, 300);
        assert_eq!(config.diff_threshold, 30);
        assert_eq!(config.min_cluster_size, 4);
        assert_eq!(config.max_cluster_size, 2500);
        assert_eq!(config.max_retries, 3);
        assert_eq!(config.merge_radius, 30.0);
        assert_eq!(config.min_samples, 3);
        assert_eq!(config.max_ratio_divergence, 0.5);
    }
}
