//! The emit-loop mechanism itself: drive the relative-mouse pointer to a
//! screen corner or away from one, plus the optional post-slam
//! motion-verification diff. No safety guard, no recovery policy — those
//! live one layer up, in `cursor_anchor`.

use std::time::Duration;

use pikvm_mcp_detection_vision::cursor_detect::{
    diff_screenshots, Cluster, DetectionConfig, DEFAULT_DETECTION_CONFIG,
};
use pikvm_mcp_detection_vision::orientation::{
    detect_ipad_bounds_from_buffer, get_last_good_bounds, DetectOptions, IpadBounds,
};
#[cfg(test)]
use pikvm_mcp_kvmd_client::client::ScreenResolution;
use pikvm_mcp_kvmd_client::client::{ClientError, PiKVMClient};

use super::geometry::{corner_target_from_bounds, corner_target_px, corner_vector};
use super::types::{Axis, Corner, ScreenshotMode};

async fn take_screenshot(
    client: &PiKVMClient,
    mode: ScreenshotMode,
) -> Result<Vec<u8>, ClientError> {
    match mode {
        ScreenshotMode::Nudging => Ok(client.screenshot_keeping_cursor_alive(None).await?.buffer),
        ScreenshotMode::Raw => Ok(client.screenshot(None).await?.buffer),
    }
}

/// Client-taking bounds detection, best-effort (never fails the caller).
/// Faithful port of orientation.ts's `detectIpadBounds` + `detectBoundsOrNull`
/// pair — genuinely thin (screenshot + the buffer-based detector, a
/// try/catch with optional verbose logging), but not yet ported into
/// `pikvm-mcp-detection-vision` itself (that crate only has the
/// buffer-based half so far, since it doesn't depend on kvmd-client).
/// Lives here, local to its first real caller, same pattern as this
/// session's other cross-layer thin-wrapper resolutions (ipad-primitives,
/// cursor-belief) — move it into detection-vision once a second caller
/// needs it (cursor-anchor.rs will).
async fn detect_bounds_or_null(
    client: &PiKVMClient,
    options: DetectOptions,
    log_prefix: &str,
) -> Option<IpadBounds> {
    let shot = match client.screenshot(None).await {
        Ok(s) => s.buffer,
        Err(e) => {
            if options.verbose {
                eprintln!("[{log_prefix}] bounds detection failed: {e}");
            }
            return None;
        }
    };
    match detect_ipad_bounds_from_buffer(&shot, options) {
        Ok(b) => Some(b),
        Err(e) => {
            if options.verbose {
                eprintln!("[{log_prefix}] bounds detection failed: {e}");
            }
            None
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SlamOptions {
    pub calls: Option<u32>,
    pub pace_ms: Option<u64>,
    /// Default `Corner::TopLeft`.
    pub corner: Option<Corner>,
    pub verbose: bool,
    /// If true, screenshots before and after the slam and checks whether
    /// a cursor-sized cluster appeared within `corner_tolerance` px of
    /// the expected corner. The result is returned, not acted on:
    /// `slam_to_corner` does not retry or throw on a failed check — the
    /// right recovery differs per caller.
    pub verify_motion: bool,
    /// REQUIRED when `verify_motion` is true (returns `Err` otherwise —
    /// see `ScreenshotMode`'s doc for why the choice is a correctness
    /// question, not a convenience default).
    pub screenshot: Option<ScreenshotMode>,
    /// Tolerance (px) for the post-slam cluster-near-corner check.
    /// Default 80. Only used when `verify_motion` is true.
    pub corner_tolerance: Option<f64>,
    /// Caller-supplied bounds, when already resolved (e.g.
    /// cursor-anchor's guard-resolution step). `None` (the default)
    /// means "no hint, do the normal cache-first/fresh-detect fallback";
    /// `Some(None)` means "I already tried and there's genuinely no
    /// bounds" — skips a redundant detection round trip. Only used when
    /// `verify_motion` is true.
    pub bounds_hint: Option<Option<IpadBounds>>,
    /// A full override of the detection config used for the
    /// `verify_motion` diff. `None` = `DEFAULT_DETECTION_CONFIG`.
    /// Faithful-but-simplified port of the TS `Partial<DetectionConfig>`
    /// (full-struct override here rather than a partial merge) — no test
    /// in this file's real TS suite exercises a partial override, and a
    /// full-struct `Option` is the more idiomatic Rust shape; flagged as
    /// an individually-justified simplification rather than a silent one.
    pub detection: Option<DetectionConfig>,
}

/// Result of `slam_to_corner`'s optional post-slam motion check
/// (`verify_motion`).
#[derive(Debug, Clone)]
pub struct SlamMotionCheck {
    /// True if a cursor-sized cluster was found within `corner_tolerance`
    /// px of the expected corner after the slam.
    pub verified: bool,
    /// Clusters found within tolerance of the expected corner, for
    /// diagnostics.
    pub matched_clusters: Vec<Cluster>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NudgeOptions {
    /// Default 5 — each emits ±127 per axis.
    pub calls: Option<u32>,
    /// Default 10ms.
    pub pace_ms: Option<u64>,
    /// Which corner to move AWAY from (opposite of slam target). Default
    /// top-left.
    pub away: Option<Corner>,
    /// If set, move only along this axis.
    pub only_axis: Option<Axis>,
    pub verbose: bool,
}

/// After a slam, the cursor is pinned at a screen edge. iPadOS applies an
/// "edge dead zone" that absorbs the first ~100-200 mickeys of any
/// movement away from the edge. This nudge emits enough deltas in the
/// "away" direction to comfortably exceed the dead zone, placing the
/// cursor in open space.
pub async fn nudge_from_edge(
    client: &PiKVMClient,
    options: NudgeOptions,
) -> Result<(), ClientError> {
    let away = options.away.unwrap_or(Corner::TopLeft);
    let calls = options.calls.unwrap_or(5);
    let pace_ms = options.pace_ms.unwrap_or(10);
    // Invert the corner: moving AWAY from top-left means +x, +y.
    let (vx, vy) = corner_vector(away);
    let mut dx = -127.0 * vx as f64;
    let mut dy = -127.0 * vy as f64;
    if options.only_axis == Some(Axis::X) {
        dy = 0.0;
    }
    if options.only_axis == Some(Axis::Y) {
        dx = 0.0;
    }
    if options.verbose {
        eprintln!("[nudge] away from {away:?}: {calls} x ({dx},{dy}) @ {pace_ms}ms");
    }
    for _ in 0..calls {
        client.mouse_move_relative(dx, dy).await?;
        if pace_ms > 0 {
            tokio::time::sleep(Duration::from_millis(pace_ms)).await;
        }
    }
    Ok(())
}

/// Drive the pointer into a screen corner by emitting many full-range
/// deltas in that direction. iPadOS clamps the pointer at the screen
/// edge regardless of acceleration, so after enough calls we have a
/// deterministic origin.
///
/// No verification by cursor detection by default. Pass
/// `verify_motion: true` to opt into an explicit check instead, for
/// callers that don't have their own downstream signal to fall back on.
pub async fn slam_to_corner(
    client: &PiKVMClient,
    options: SlamOptions,
) -> Result<Option<SlamMotionCheck>, ClientError> {
    let corner = options.corner.unwrap_or(Corner::TopLeft);
    // Pace matters on iPadOS: rapid slams to the edge appear to be
    // interpreted as a system gesture. 60ms between calls is slow enough
    // for iPadOS to treat it as ordinary pointer movement.
    let pace_ms = options.pace_ms.unwrap_or(60);
    let resolution = client.get_resolution(false).await?;
    let calls = options.calls.unwrap_or_else(|| {
        (resolution.width.max(resolution.height) as f64 / 100.0).ceil() as u32 + 8
    });
    let (vx, vy) = corner_vector(corner);
    let verify_motion = options.verify_motion;
    // No default screenshot mode — see ScreenshotMode's doc for why
    // silently picking one would be a correctness bug, not a convenience.
    if verify_motion && options.screenshot.is_none() {
        return Err(ClientError::Other(
            "slam_to_corner: verify_motion=true requires options.screenshot (no default — see ScreenshotMode's doc)."
                .to_string(),
        ));
    }

    if options.verbose {
        eprintln!("[slam] {corner:?} x {calls} calls @ {pace_ms}ms");
    }

    let before = if verify_motion {
        Some(take_screenshot(client, options.screenshot.unwrap()).await?)
    } else {
        None
    };

    for _ in 0..calls {
        client
            .mouse_move_relative(127.0 * vx as f64, 127.0 * vy as f64)
            .await?;
        if pace_ms > 0 {
            tokio::time::sleep(Duration::from_millis(pace_ms)).await;
        }
    }

    let (Some(before), true) = (before, verify_motion) else {
        return Ok(None);
    };

    // One more small nudge in-corner right before the verification
    // screenshot: iPadOS fades a static cursor after ~300ms, and the
    // slam loop's last sleep may already have crossed that.
    client
        .mouse_move_relative(3.0 * vx as f64, 3.0 * vy as f64)
        .await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let after = take_screenshot(client, options.screenshot.unwrap()).await?;

    let detection = options.detection.unwrap_or(DEFAULT_DETECTION_CONFIG);
    let tolerance = options.corner_tolerance.unwrap_or(80.0);
    // P0 fix (2026-08-24): use the iPad's own detected bounds corner,
    // not the raw capture-frame corner. An explicit bounds_hint
    // (including Some(None) — "I already tried, no bounds") skips a
    // redundant detection round trip; None falls back to the original
    // cache-first/fresh-detect chain, then to the raw-frame corner only
    // if bounds are genuinely undetectable.
    let bounds = match options.bounds_hint {
        Some(hint) => hint,
        None => match get_last_good_bounds() {
            Some(b) => Some(b),
            None => {
                detect_bounds_or_null(
                    client,
                    DetectOptions {
                        verbose: options.verbose,
                        ..Default::default()
                    },
                    "slam-verify",
                )
                .await
            }
        },
    };
    let expected = match &bounds {
        Some(b) => corner_target_from_bounds(corner, b),
        None => corner_target_px(corner, resolution),
    };

    let clusters = match diff_screenshots(&before, &after, &detection) {
        Ok(c) => c,
        Err(e) => {
            if options.verbose {
                eprintln!("[slam] verifyMotion diff threw: {e}");
            }
            return Ok(Some(SlamMotionCheck {
                verified: false,
                matched_clusters: vec![],
            }));
        }
    };

    let matched_clusters: Vec<Cluster> = clusters
        .into_iter()
        .filter(|c| {
            let dx = c.centroid_x as f64 - expected.0 as f64;
            let dy = c.centroid_y as f64 - expected.1 as f64;
            (dx * dx + dy * dy).sqrt() <= tolerance
        })
        .collect();

    if options.verbose {
        eprintln!(
            "[slam] verifyMotion: {}/? cluster(s) within {tolerance}px of expected ({},{})",
            matched_clusters.len(),
            expected.0,
            expected.1
        );
    }

    let verified = !matched_clusters.is_empty();
    Ok(Some(SlamMotionCheck {
        verified,
        matched_clusters,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_detection_vision::orientation::{
        clear_orientation_cache, detect_ipad_bounds_from_buffer,
    };
    use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::Mutex as AsyncMutex;

    // slam_to_corner touches two process-global statics indirectly:
    // emit_clock (via mouse_move_relative) and orientation's bounds cache
    // (via the verify_motion path). Serialize every test that runs a real
    // client call through this lock, same discipline as
    // cursor_keepalive.rs's TEST_LOCK.
    static TEST_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

    type Moves = Arc<StdMutex<Vec<String>>>;
    type ShotCalls = Arc<StdMutex<usize>>;

    fn stub_client(
        resolution: ScreenResolution,
        screenshots: Vec<Vec<u8>>,
    ) -> (PiKVMClient, Moves, ShotCalls) {
        let moves: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let moves_bg = moves.clone();
        let shot_calls: Arc<StdMutex<usize>> = Arc::new(StdMutex::new(0));
        let shot_calls_bg = shot_calls.clone();
        let screenshots = Arc::new(screenshots);
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let moves = moves_bg.clone();
            let shot_calls = shot_calls_bg.clone();
            let screenshots = screenshots.clone();
            Box::pin(async move {
                if args.path.starts_with("/hid/events/send_mouse_relative") {
                    moves.lock().unwrap().push(args.path.clone());
                    return Ok(ResponseBody::Empty);
                }
                if args.path.starts_with("/streamer/snapshot") {
                    let mut i = shot_calls.lock().unwrap();
                    let idx = (*i).min(screenshots.len().saturating_sub(1));
                    *i += 1;
                    return Ok(ResponseBody::Image(screenshots[idx].clone()));
                }
                if args.path == "/streamer" {
                    return Ok(ResponseBody::Json(serde_json::json!({
                        "ok": true,
                        "result": { "streamer": { "source": { "online": true, "resolution": { "width": resolution.width, "height": resolution.height } } } }
                    })));
                }
                Ok(ResponseBody::Empty)
            })
        });
        // 127.0.0.1 on a reserved/closed port, NOT "mock.local": slam
        // tests exercise get_resolution/screenshot, which (unlike
        // cursor_keepalive's tests) reach PiKVMClient's REAL
        // StreamerKeepalive — with_request_fn only stubs the REST path,
        // it can't stub that. A ".local" host triggers a real macOS mDNS
        // resolution attempt (~5s timeout) before the connect fails;
        // 127.0.0.1 fails instantly (connection refused), so this
        // harmless real background connection attempt doesn't visibly
        // slow every single test down.
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
            None,
            request_fn,
        );
        (client, moves, shot_calls)
    }

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

    fn jpeg_encode(rgb: &[u8], w: u32, h: u32) -> Vec<u8> {
        let img: image::RgbImage = image::ImageBuffer::from_raw(w, h, rgb.to_vec()).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
        encoder.encode_image(&img).unwrap();
        buf
    }

    fn decode_rgb(jpeg: &[u8]) -> Vec<u8> {
        image::load_from_memory(jpeg).unwrap().to_rgb8().into_raw()
    }

    /// An iPad-portrait letterbox frame: black bars outside the content
    /// region, bright grey inside. Same construction as the TS test's
    /// `makeIpadPortraitFrame` (and move-to.forbidSlamOnIpad.test.ts's).
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

    mod slam_to_corner_tests {
        use super::*;

        #[tokio::test]
        async fn emits_127_mickey_deltas_in_the_corner_direction_top_left_default() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let recorded = moves.lock().unwrap().clone();
            assert!(!recorded.is_empty());
            // top-left = (-1, -1), so each delta is (-127, -127).
            for m in &recorded {
                assert_eq!(parse_delta(m), (-127.0, -127.0));
            }
        }

        #[tokio::test]
        async fn top_right_direction_is_plus_127_minus_127_per_call() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            slam_to_corner(
                &client,
                SlamOptions {
                    corner: Some(Corner::TopRight),
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            for m in moves.lock().unwrap().iter() {
                assert_eq!(parse_delta(m), (127.0, -127.0));
            }
        }

        #[tokio::test]
        async fn bottom_right_direction_is_plus_127_plus_127_per_call() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            slam_to_corner(
                &client,
                SlamOptions {
                    corner: Some(Corner::BottomRight),
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            for m in moves.lock().unwrap().iter() {
                assert_eq!(parse_delta(m), (127.0, 127.0));
            }
        }

        #[tokio::test]
        async fn bottom_left_direction_is_minus_127_plus_127_per_call() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            slam_to_corner(
                &client,
                SlamOptions {
                    corner: Some(Corner::BottomLeft),
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            for m in moves.lock().unwrap().iter() {
                assert_eq!(parse_delta(m), (-127.0, 127.0));
            }
        }

        #[tokio::test]
        async fn default_call_count_scales_with_screen_resolution() {
            let _guard = TEST_LOCK.lock().await;
            // 1920x1080 → max=1920, calls = ceil(1920/100) + 8 = 20 + 8 = 28.
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(moves.lock().unwrap().len(), 28);
        }

        #[tokio::test]
        async fn larger_screen_means_more_calls() {
            let _guard = TEST_LOCK.lock().await;
            // ceil(3840/100) + 8 = 39 + 8 = 47.
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 3840,
                    height: 2160,
                },
                vec![],
            );
            slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(moves.lock().unwrap().len(), 47);
        }

        #[tokio::test]
        async fn custom_call_count_honoured() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            slam_to_corner(
                &client,
                SlamOptions {
                    calls: Some(10),
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(moves.lock().unwrap().len(), 10);
        }
    }

    mod nudge_from_edge_tests {
        use super::*;

        #[tokio::test]
        async fn away_from_top_left_is_away_direction_plus_x_plus_y() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            nudge_from_edge(
                &client,
                NudgeOptions {
                    away: Some(Corner::TopLeft),
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            for m in moves.lock().unwrap().iter() {
                assert_eq!(parse_delta(m), (127.0, 127.0));
            }
        }

        #[tokio::test]
        async fn away_from_bottom_right_is_minus_127_minus_127() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            nudge_from_edge(
                &client,
                NudgeOptions {
                    away: Some(Corner::BottomRight),
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            for m in moves.lock().unwrap().iter() {
                assert_eq!(parse_delta(m), (-127.0, -127.0));
            }
        }

        #[tokio::test]
        async fn default_5_calls() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            nudge_from_edge(
                &client,
                NudgeOptions {
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(moves.lock().unwrap().len(), 5);
        }

        #[tokio::test]
        async fn only_axis_x_zeroes_y_component() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            nudge_from_edge(
                &client,
                NudgeOptions {
                    away: Some(Corner::TopLeft),
                    only_axis: Some(Axis::X),
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            for m in moves.lock().unwrap().iter() {
                assert_eq!(parse_delta(m), (127.0, 0.0));
            }
        }

        #[tokio::test]
        async fn only_axis_y_zeroes_x_component() {
            let _guard = TEST_LOCK.lock().await;
            let (client, moves, _shots) = stub_client(
                ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                vec![],
            );
            nudge_from_edge(
                &client,
                NudgeOptions {
                    away: Some(Corner::TopLeft),
                    only_axis: Some(Axis::Y),
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            for m in moves.lock().unwrap().iter() {
                assert_eq!(parse_delta(m), (0.0, 127.0));
            }
        }
    }

    /// Unit tests for `slam_to_corner`'s optional `verify_motion` check.
    /// Faithful port of `slamToCorner.verifyMotion.test.ts`.
    mod verify_motion_tests {
        use super::*;

        #[tokio::test]
        async fn unset_default_false_no_screenshots_taken_returns_none() {
            let _guard = TEST_LOCK.lock().await;
            let (client, _moves, shots) = stub_client(
                ScreenResolution {
                    width: 400,
                    height: 300,
                },
                vec![],
            );
            let result = slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert!(result.is_none());
            assert_eq!(*shots.lock().unwrap(), 0);
        }

        #[tokio::test]
        async fn verified_true_when_a_cursor_sized_cluster_appears_near_the_expected_corner() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (w, h) = (400u32, 300u32);
            let before_rgb = vec![50u8; (w * h * 3) as usize];
            let after_rgb = stamp_square(&before_rgb, w, h, 5, 5, 10, [255, 255, 255]);
            let before = jpeg_encode(&before_rgb, w, h);
            let after = jpeg_encode(&after_rgb, w, h);
            let (client, _moves, shots) = stub_client(
                ScreenResolution {
                    width: w,
                    height: h,
                },
                vec![before, after],
            );
            let result = slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    verify_motion: true,
                    screenshot: Some(ScreenshotMode::Raw),
                    bounds_hint: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
            assert!(result.verified);
            assert!(!result.matched_clusters.is_empty());
            assert_eq!(*shots.lock().unwrap(), 2);
        }

        #[tokio::test]
        async fn verified_false_when_nothing_changed_between_before_after() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (w, h) = (400u32, 300u32);
            let before = solid_jpeg(w, h, [50, 50, 50]);
            let (client, _moves, _shots) = stub_client(
                ScreenResolution {
                    width: w,
                    height: h,
                },
                vec![before.clone(), before],
            );
            let result = slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    verify_motion: true,
                    screenshot: Some(ScreenshotMode::Raw),
                    bounds_hint: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
            assert!(!result.verified);
            assert!(result.matched_clusters.is_empty());
        }

        #[tokio::test]
        async fn verified_false_when_a_cluster_appears_far_from_the_expected_corner() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (w, h) = (400u32, 300u32);
            let before_rgb = vec![50u8; (w * h * 3) as usize];
            let after_rgb = stamp_square(&before_rgb, w, h, 350, 250, 10, [255, 255, 255]); // near bottom-right
            let before = jpeg_encode(&before_rgb, w, h);
            let after = jpeg_encode(&after_rgb, w, h);
            let (client, _moves, _shots) = stub_client(
                ScreenResolution {
                    width: w,
                    height: h,
                },
                vec![before, after],
            );
            let result = slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    verify_motion: true,
                    screenshot: Some(ScreenshotMode::Raw),
                    corner: Some(Corner::TopLeft),
                    bounds_hint: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
            assert!(!result.verified);
        }

        #[tokio::test]
        async fn respects_a_custom_corner_when_computing_the_expected_target() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (w, h) = (400u32, 300u32);
            let before_rgb = vec![50u8; (w * h * 3) as usize];
            // Near bottom-right (400,300) — matches corner:BottomRight, not top-left.
            let after_rgb = stamp_square(&before_rgb, w, h, 395, 295, 10, [255, 255, 255]);
            let before = jpeg_encode(&before_rgb, w, h);
            let after = jpeg_encode(&after_rgb, w, h);
            let (client, _moves, _shots) = stub_client(
                ScreenResolution {
                    width: w,
                    height: h,
                },
                vec![before, after],
            );
            let result = slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    verify_motion: true,
                    screenshot: Some(ScreenshotMode::Raw),
                    corner: Some(Corner::BottomRight),
                    bounds_hint: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
            assert!(result.verified);
        }

        #[tokio::test]
        async fn respects_a_custom_corner_tolerance() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (w, h) = (400u32, 300u32);
            let before_rgb = vec![50u8; (w * h * 3) as usize];
            let after_rgb = stamp_square(&before_rgb, w, h, 50, 50, 10, [255, 255, 255]); // ~70px from (0,0)
            let before = jpeg_encode(&before_rgb, w, h);
            let after = jpeg_encode(&after_rgb, w, h);

            let (client, _moves, _shots) = stub_client(
                ScreenResolution {
                    width: w,
                    height: h,
                },
                vec![before.clone(), after.clone()],
            );
            let tight = slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    verify_motion: true,
                    screenshot: Some(ScreenshotMode::Raw),
                    corner_tolerance: Some(10.0),
                    bounds_hint: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
            assert!(!tight.verified);

            let (client2, _moves2, _shots2) = stub_client(
                ScreenResolution {
                    width: w,
                    height: h,
                },
                vec![before, after],
            );
            let loose = slam_to_corner(
                &client2,
                SlamOptions {
                    pace_ms: Some(0),
                    verify_motion: true,
                    screenshot: Some(ScreenshotMode::Raw),
                    corner_tolerance: Some(100.0),
                    bounds_hint: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
            assert!(loose.verified);
        }

        /// 2026-08-24 P0 fix regression pair: `corner_target_px` alone
        /// (raw-frame corner) was DETERMINISTICALLY wrong for any
        /// letterboxed iPad — positive control: a cluster at the iPad's
        /// OWN letterbox corner must verify true. Negative control: a
        /// cluster at the RAW FRAME corner (0,0) — inside the black
        /// letterbox bar, not where the cursor can physically land —
        /// must verify false.
        mod corner_target_from_bounds_fix {
            use super::*;

            #[tokio::test]
            async fn verified_true_when_the_cluster_lands_at_the_ipads_own_detected_letterbox_corner(
            ) {
                let _guard = TEST_LOCK.lock().await;
                clear_orientation_cache();
                let before = make_ipad_portrait_frame();
                let bounds =
                    detect_ipad_bounds_from_buffer(&before, DetectOptions::default()).unwrap();
                // Sanity: this synthetic frame's content region is genuinely NOT
                // at the raw frame's (0,0).
                assert!(bounds.x > 100);
                let before_rgb = decode_rgb(&before);
                let after_rgb = stamp_square(
                    &before_rgb,
                    1920,
                    1080,
                    bounds.x as i64 + 5,
                    bounds.y as i64 + 5,
                    10,
                    [255, 255, 255],
                );
                let after = jpeg_encode(&after_rgb, 1920, 1080);
                let (client, _moves, _shots) = stub_client(
                    ScreenResolution {
                        width: 1920,
                        height: 1080,
                    },
                    vec![before, after],
                );
                // No bounds_hint here (unlike the other verify_motion tests) —
                // these two P0-regression tests must exercise the REAL
                // cache-or-detect bounds resolution inside slam_to_corner
                // itself, not bypass it. Forcing Some(None) would fall back
                // to the raw-frame corner unconditionally, which is exactly
                // the pre-fix bug this test exists to catch.
                let result = slam_to_corner(
                    &client,
                    SlamOptions {
                        pace_ms: Some(0),
                        verify_motion: true,
                        screenshot: Some(ScreenshotMode::Raw),
                        corner: Some(Corner::TopLeft),
                        ..Default::default()
                    },
                )
                .await
                .unwrap()
                .unwrap();
                assert!(result.verified);
            }

            #[tokio::test]
            async fn verified_false_when_the_cluster_lands_at_the_raw_frame_corner_inside_the_letterbox_bar(
            ) {
                let _guard = TEST_LOCK.lock().await;
                clear_orientation_cache();
                let before = make_ipad_portrait_frame();
                let bounds =
                    detect_ipad_bounds_from_buffer(&before, DetectOptions::default()).unwrap();
                assert!(bounds.x > 100);
                let before_rgb = decode_rgb(&before);
                let after_rgb = stamp_square(&before_rgb, 1920, 1080, 5, 5, 10, [255, 255, 255]); // raw-frame (0,0) corner
                let after = jpeg_encode(&after_rgb, 1920, 1080);
                let (client, _moves, _shots) = stub_client(
                    ScreenResolution {
                        width: 1920,
                        height: 1080,
                    },
                    vec![before, after],
                );
                // Same reasoning as above — no bounds_hint, real detection must run.
                let result = slam_to_corner(
                    &client,
                    SlamOptions {
                        pace_ms: Some(0),
                        verify_motion: true,
                        screenshot: Some(ScreenshotMode::Raw),
                        corner: Some(Corner::TopLeft),
                        ..Default::default()
                    },
                )
                .await
                .unwrap()
                .unwrap();
                assert!(!result.verified);
            }
        }
    }
}
