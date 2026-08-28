//! Tests for `measure.rs`. `order_clusters_by_direction` is new ground
//! (no TS test file covers it directly — behavior verified against the
//! source's own inline reasoning). The `measure_ballistics` wiring tests
//! are a faithful port of `measureBallistics.slam.test.ts` and
//! `measureBallistics.slamVerify.test.ts`.

use super::*;
use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};
use std::sync::Mutex as StdMutex;

// measure_ballistics touches the same process-global emit_clock and
// orientation bounds cache slam.rs's/cursor_keepalive.rs's/
// cursor_anchor.rs's own tests touch — serialize against the crate-wide
// lock, not a file-local one. See
// `crate::test_support::GLOBAL_STATE_LOCK`'s doc for why a per-file lock
// silently fails to do this.
use crate::test_support::GLOBAL_STATE_LOCK as TEST_LOCK;

fn cluster(pixels: usize, cx: i64, cy: i64) -> Cluster {
    Cluster {
        pixels,
        centroid_x: cx,
        centroid_y: cy,
        bbox_min_x: cx - 2,
        bbox_max_x: cx + 2,
        bbox_min_y: cy - 2,
        bbox_max_y: cy + 2,
        members: None,
        mean_r: None,
        mean_g: None,
        mean_b: None,
    }
}

mod order_clusters_by_direction_tests {
    use super::*;

    #[test]
    fn returns_none_with_fewer_than_two_cursor_sized_candidates() {
        let clusters = vec![cluster(30, 10, 10)]; // only one candidate
        assert!(order_clusters_by_direction(
            &clusters,
            (5.0, 0.0),
            PairSelectionOptions::default()
        )
        .is_none());
    }

    #[test]
    fn picks_the_pair_that_moved_in_the_commanded_x_direction() {
        // Commanded +x by 5 mickeys: a genuine cursor pair displaces
        // clearly along +x with negligible off-axis drift.
        let clusters = vec![cluster(30, 100, 100), cluster(30, 140, 101)];
        let (pre, post) =
            order_clusters_by_direction(&clusters, (5.0, 0.0), PairSelectionOptions::default())
                .unwrap();
        assert_eq!((pre.centroid_x, pre.centroid_y), (100, 100));
        assert_eq!((post.centroid_x, post.centroid_y), (140, 101));
    }

    #[test]
    fn rejects_a_pair_moving_the_wrong_direction() {
        // Commanded +x, but the only candidate pair moved -x — must not
        // match (an aligned_axis <= 0 pair is discarded).
        let clusters = vec![cluster(30, 140, 100), cluster(30, 100, 100)];
        assert!(order_clusters_by_direction(
            &clusters,
            (5.0, 0.0),
            PairSelectionOptions::default()
        )
        .is_none());
    }

    #[test]
    fn rejects_a_pair_with_too_much_off_axis_drift() {
        // On-axis displacement 40px, off-axis 30px — 30 > 40*0.35=14, over
        // the default off_axis_tolerance_ratio.
        let clusters = vec![cluster(30, 100, 100), cluster(30, 140, 130)];
        assert!(order_clusters_by_direction(
            &clusters,
            (5.0, 0.0),
            PairSelectionOptions::default()
        )
        .is_none());
    }

    #[test]
    fn rejects_a_pair_below_the_min_on_axis_displacement() {
        let clusters = vec![cluster(30, 100, 100), cluster(30, 110, 100)]; // 10px < default 25
        assert!(order_clusters_by_direction(
            &clusters,
            (5.0, 0.0),
            PairSelectionOptions::default()
        )
        .is_none());
    }

    #[test]
    fn rejects_a_pair_with_too_large_a_size_ratio() {
        let clusters = vec![cluster(10, 100, 100), cluster(40, 140, 100)]; // ratio 4 > default 2.5
        assert!(order_clusters_by_direction(
            &clusters,
            (5.0, 0.0),
            PairSelectionOptions::default()
        )
        .is_none());
    }

    #[test]
    fn filters_out_of_size_range_clusters_before_pairing() {
        // A 400px "widget" candidate must never enter pairing at all —
        // only the two cursor-sized (30px) clusters should be considered.
        let clusters = vec![
            cluster(400, 500, 500), // too big, filtered
            cluster(30, 100, 100),
            cluster(30, 140, 100),
        ];
        let (pre, post) =
            order_clusters_by_direction(&clusters, (5.0, 0.0), PairSelectionOptions::default())
                .unwrap();
        assert_eq!((pre.centroid_x, pre.centroid_y), (100, 100));
        assert_eq!((post.centroid_x, post.centroid_y), (140, 100));
    }

    #[test]
    fn picks_the_pair_that_moved_in_the_commanded_y_direction() {
        let clusters = vec![cluster(30, 100, 100), cluster(30, 101, 140)];
        let (pre, post) =
            order_clusters_by_direction(&clusters, (0.0, 5.0), PairSelectionOptions::default())
                .unwrap();
        assert_eq!((pre.centroid_x, pre.centroid_y), (100, 100));
        assert_eq!((post.centroid_x, post.centroid_y), (101, 140));
    }
}

mod iso_now_tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_epoch_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        // 2026-08-28 is 20_693 days after the epoch.
        assert_eq!(civil_from_days(20_693), (2026, 8, 28));
        // 2000-03-01 (a post-leap-day date in a leap year), a classic
        // edge case for civil-calendar algorithms.
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
    }

    #[test]
    fn iso_now_produces_a_well_formed_rfc3339_utc_string() {
        let s = iso_now();
        assert_eq!(s.len(), 24); // YYYY-MM-DDTHH:MM:SS.sssZ
        assert!(s.ends_with('Z'));
        assert_eq!(s.chars().nth(4), Some('-'));
        assert_eq!(s.chars().nth(10), Some('T'));
    }
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

fn decoded_solid(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
    for i in 0..(w as usize) * (h as usize) {
        buf[i * 3] = fill[0];
        buf[i * 3 + 1] = fill[1];
        buf[i * 3 + 2] = fill[2];
    }
    buf
}

type Moves = std::sync::Arc<StdMutex<Vec<(f64, f64)>>>;

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

/// Stub a `PiKVMClient` whose `/streamer/snapshot` calls cycle through
/// `screenshots` in order (repeating the last frame once exhausted, like
/// `cursor_anchor::tests::stub_client`), and whose resolution is fixed.
fn stub_client(resolution: (u32, u32), screenshots: Vec<Vec<u8>>) -> (Arc<PiKVMClient>, Moves) {
    let (w, h) = resolution;
    let moves: Moves = Arc::new(StdMutex::new(Vec::new()));
    let moves_bg = moves.clone();
    let shot_calls = Arc::new(StdMutex::new(0usize));
    let screenshots = Arc::new(screenshots);
    let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
        let moves = moves_bg.clone();
        let shot_calls = shot_calls.clone();
        let screenshots = screenshots.clone();
        Box::pin(async move {
            if args.path.starts_with("/hid/events/send_mouse_relative") {
                moves.lock().unwrap().push(parse_delta(&args.path));
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/streamer/snapshot") {
                let mut i = shot_calls.lock().unwrap();
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
    let client = Arc::new(PiKVMClient::with_request_fn(
        PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
        None,
        request_fn,
    ));
    (client, moves)
}

/// Count the leading run of 127-mickey top-left slam moves (-127,-127).
fn count_leading_slam_moves(moves: &[(f64, f64)]) -> usize {
    moves
        .iter()
        .take_while(|&&(dx, dy)| dx == -127.0 && dy == -127.0)
        .count()
}

fn single_cell_opts() -> MeasureBallisticsOptions {
    MeasureBallisticsOptions {
        magnitudes: vec![5.0],
        paces: vec![Pace::Fast],
        axes: vec![Axis::X],
        reps: 1,
        noise_frames: 1,
        calls_per_cell: 3,
        ..Default::default()
    }
}

// 400×300 resolution → slam_to_corner's own auto-computed call count:
// ceil(max(400,300)/100) + 8 = 4 + 8 = 12. cursor_anchor.rs owns this
// unconditionally (no MeasureBallisticsOptions field configures it).
const SLAM_CALLS: usize = 12;

mod measure_ballistics_slam_wiring {
    use super::*;

    /// Faithful port of `measureBallistics.slam.test.ts`: the reset-slam
    /// step still fires a real, non-zero slam with the resolution-derived
    /// call count.
    #[tokio::test]
    async fn reset_slam_step_fires_the_resolution_derived_call_count() {
        let _guard = TEST_LOCK.lock().await;
        pikvm_mcp_detection_vision::orientation::clear_orientation_cache();
        // Uniform blank frame: no cursor cluster is ever detected, so
        // every cell is rejected. Fine — this test only cares about the
        // slam call count, not whether a sample is accepted.
        let blank = solid_jpeg(400, 300, [50, 50, 50]);
        let (client, moves) = stub_client((400, 300), vec![blank]);

        let _ = measure_ballistics(&client, single_cell_opts())
            .await
            .unwrap();

        let leading = count_leading_slam_moves(&moves.lock().unwrap());
        assert_eq!(leading, SLAM_CALLS);
    }

    /// Faithful port of `measureBallistics.slamVerify.test.ts`'s first
    /// test: a slam that never verifies (frozen/all-blank frames) rejects
    /// the cell WITHOUT measuring — no nudge, no warm-up probe, no
    /// callsPerCell loop.
    #[tokio::test]
    async fn rejects_the_cell_without_measuring_when_slam_motion_does_not_verify() {
        let _guard = TEST_LOCK.lock().await;
        pikvm_mcp_detection_vision::orientation::clear_orientation_cache();
        let blank = solid_jpeg(400, 300, [50, 50, 50]);
        let (client, moves) = stub_client((400, 300), vec![blank]);

        let result = measure_ballistics(&client, single_cell_opts())
            .await
            .unwrap();

        assert_eq!(result.samples_accepted, 0);
        assert_eq!(result.samples_rejected, 1);
        // Early exit: slam(12) + verify_motion's own confirmation nudge(1) = 13.
        assert_eq!(moves.lock().unwrap().len(), SLAM_CALLS + 1);
    }

    /// Faithful port of `measureBallistics.slamVerify.test.ts`'s second
    /// test: a slam that DOES verify (cluster appears near the corner)
    /// proceeds to the full measurement pipeline, even though the
    /// measurement itself still finds nothing (blank frames) and the
    /// cell is ultimately rejected via the OTHER path.
    #[tokio::test]
    async fn proceeds_to_measure_normally_when_slam_motion_does_verify() {
        let _guard = TEST_LOCK.lock().await;
        pikvm_mcp_detection_vision::orientation::clear_orientation_cache();
        let blank = decoded_solid(400, 300, [50, 50, 50]);
        let slam_verified = jpeg_encode(
            &stamp_square(&blank, 400, 300, 5, 5, 10, [255, 255, 255]),
            400,
            300,
        );
        let blank_jpeg = jpeg_encode(&blank, 400, 300);
        // shots[0] = bounds-detection's own screenshot (guard:NoneCalibration
        // has no bounds, so anchor_cursor's capture_verification branch
        // falls through to a fresh detect — this frame is blank, so
        // detection finds nothing and verification_bounds stays None,
        // same as the TS test's implicit assumption); shots[1] = slam
        // "before" (blank); shots[2] = slam "after" (cluster near
        // top-left → verified:true); shots[3] = measure_cell's own
        // before/after pair (both clamp to this last blank frame).
        let (client, moves) = stub_client(
            (400, 300),
            vec![
                blank_jpeg.clone(),
                blank_jpeg.clone(),
                slam_verified,
                blank_jpeg,
            ],
        );

        let result = measure_ballistics(&client, single_cell_opts())
            .await
            .unwrap();

        // Still rejected (blank measurement frames), just via the
        // measurement-diff path, not the slam-verify early exit.
        assert_eq!(result.samples_rejected, 1);
        // Full pipeline ran: slam(12) + verify-nudge(1) + nudge_from_edge
        // (5, anchor_cursor's default) + warm-up probe(1) + calls_per_cell(3) = 22.
        let early = SLAM_CALLS + 1;
        let total = moves.lock().unwrap().len();
        assert!(total > early);
        assert_eq!(total, SLAM_CALLS + 1 + 5 + 1 + 3);
    }
}
