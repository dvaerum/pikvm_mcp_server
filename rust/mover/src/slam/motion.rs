//! The emit-loop mechanism itself: drive the relative-mouse pointer to a
//! screen corner or away from one, plus the optional post-slam
//! motion-verification diff. No safety guard, no recovery policy — those
//! live one layer up, in `cursor_anchor`.

use std::time::Duration;

use pikvm_mcp_detection_vision::cursor_detect::{
    diff_screenshots, Cluster, DetectionConfig, DEFAULT_DETECTION_CONFIG,
};
use pikvm_mcp_detection_vision::orientation::{
    detect_bounds_or_null, get_last_good_bounds, DetectOptions, IpadBounds,
};
#[cfg(test)]
use pikvm_mcp_kvmd_client::client::ScreenResolution;
use pikvm_mcp_kvmd_client::client::{ClientError, PiKVMClient, ScreenshotOptions};

use super::geometry::{corner_target_from_bounds, corner_target_px, corner_vector};
use super::types::{Axis, Corner, ScreenshotMode};

/// `allow_keyboard_wake`: threaded straight through to
/// `ScreenshotOptions` — see docs/corner-control-allow-keyboard-wake-
/// decision.md for the specific, reasoned-through decision behind
/// setting this `true` at any real call site (currently only the
/// `after` shot in `slam_to_corner`, and only when the caller's own
/// `SlamOptions.allow_keyboard_wake_after` opts in). Default `false`
/// everywhere else, matching v1's mouse-move-only behavior exactly.
async fn take_screenshot(
    client: &PiKVMClient,
    mode: ScreenshotMode,
    allow_keyboard_wake: bool,
) -> Result<Vec<u8>, ClientError> {
    let options = Some(ScreenshotOptions {
        allow_keyboard_wake,
        ..Default::default()
    });
    match mode {
        ScreenshotMode::Nudging => Ok(client
            .screenshot_keeping_cursor_alive(options)
            .await?
            .buffer),
        ScreenshotMode::Raw => Ok(client.screenshot(options).await?.buffer),
    }
}

/// Retries `take_screenshot` a few times with a short settle between
/// attempts, on top of `client.screenshot()`'s own built-in
/// retry-once-with-grace. See docs/slam-verify-screenshot-retry-plan.md
/// for the full history: originally added for `slam_to_corner`'s `after`
/// screenshot (3 real live 503s post-slam), then extended to `before`
/// too with a lighter budget once live evidence showed the same failure
/// there — with no preceding slam traffic, counter-evidence against the
/// original "slam-load-specific" hypothesis; more likely general
/// ustreamer flakiness than a load effect. `max_attempts`/`settle_ms` are
/// honestly uncalibrated starting values, not final-tuned — `label`
/// (`"before"`/`"after"`) plus the attempt count are logged on every call
/// (`verbose`) so real runs build up real per-call calibration data.
async fn take_screenshot_with_retry(
    client: &PiKVMClient,
    mode: ScreenshotMode,
    max_attempts: u32,
    settle_ms: u64,
    verbose: bool,
    label: &str,
    allow_keyboard_wake: bool,
) -> Result<Vec<u8>, ClientError> {
    let mut last_err = None;
    for attempt in 1..=max_attempts {
        match take_screenshot(client, mode, allow_keyboard_wake).await {
            Ok(buf) => {
                if verbose {
                    eprintln!(
                        "[slam] {label}-screenshot retry: succeeded on attempt {attempt}/{max_attempts}"
                    );
                }
                return Ok(buf);
            }
            Err(e) => {
                if verbose {
                    eprintln!(
                        "[slam] {label}-screenshot retry: attempt {attempt}/{max_attempts} failed ({e})"
                    );
                }
                last_err = Some(e);
                if attempt < max_attempts {
                    tokio::time::sleep(Duration::from_millis(settle_ms)).await;
                }
            }
        }
    }
    Err(last_err.expect("loop runs at least once, so an all-Err path always sets this"))
}

/// Starting values for `take_screenshot_with_retry`, shared by BOTH the
/// `before` and `after` shots. `before` originally used a lighter budget
/// (2 attempts/300ms) specifically to minimize widening the confirmed-
/// precondition-to-slam gap — but live evidence (3 real occurrences, one
/// with `streamer_keepalive_connected=true` throughout, ruling out a
/// keepalive-reconnect explanation) showed that budget reliably fails
/// anyway, giving none of the precondition-freshness benefit it was
/// meant to preserve. nixos-dev's review (2026-08-30): abandon the
/// asymmetry — a slightly longer retry that might actually succeed
/// serves that same goal better than a short one that predictably
/// doesn't. See docs/slam-verify-screenshot-retry-plan.md for the full
/// history, including a flagged-for-later root-cause hypothesis (a
/// zombie WS connection: `StreamerKeepalive`'s close-watcher is purely
/// passive, no active ping, so `connected()` can report `true` for a
/// connection an intermediate NAT/proxy silently dropped during the long
/// human-confirmation silence — not fixed here, a bigger design item).
const VERIFY_SCREENSHOT_RETRY_MAX_ATTEMPTS: u32 = 3;
const VERIFY_SCREENSHOT_RETRY_SETTLE_MS: u64 = 1000;

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
    /// Default `false`. Permits the `after` verification screenshot
    /// (NOT `before` — a deliberately separate, undecided question) to
    /// use the v2 wake-nudge escalation's keyboard `Space` path instead
    /// of always falling back to a mouse-move nudge, if
    /// `PiKVMConfig::source_online_wake_nudge` is also enabled. Only set
    /// `true` when the caller has reasoned through its own specific
    /// context — see docs/corner-control-allow-keyboard-wake-decision.md
    /// for the one call site currently approved for this
    /// (`cursor_anchor_corner_control_smoke.rs`'s guarded slam pair).
    pub allow_keyboard_wake_after: bool,
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

    // Retried with the SAME budget as `after`, below (docs/slam-verify-
    // screenshot-retry-plan.md). Originally lighter-touch (2 attempts/
    // 300ms) to minimize widening the confirmed-precondition-to-slam
    // gap — abandoned per nixos-dev's review after 3 real live
    // occurrences (one with the keepalive diagnostic below confirming
    // `connected=true` throughout, ruling out a reconnect-backoff
    // explanation) showed the lighter budget reliably fails anyway,
    // giving none of the precondition-freshness benefit it was meant to
    // preserve. Keeping the keepalive diagnostic logging regardless — it
    // still feeds the flagged-for-later zombie-WS-connection hypothesis.
    let before = if verify_motion {
        if options.verbose {
            eprintln!(
                "[slam] before-screenshot: streamer_keepalive_connected={} (checked before the attempt)",
                client.streamer_keepalive_connected()
            );
        }
        let result = take_screenshot_with_retry(
            client,
            options.screenshot.unwrap(),
            VERIFY_SCREENSHOT_RETRY_MAX_ATTEMPTS,
            VERIFY_SCREENSHOT_RETRY_SETTLE_MS,
            options.verbose,
            "before",
            // Always false — the AFTER-only decision in
            // docs/corner-control-allow-keyboard-wake-decision.md was
            // deliberately scoped to just the after shot; before is a
            // separate, undecided question.
            false,
        )
        .await;
        if options.verbose {
            eprintln!(
                "[slam] before-screenshot: streamer_keepalive_connected={} (checked after the attempt, ok={})",
                client.streamer_keepalive_connected(),
                result.is_ok()
            );
        }
        Some(result?)
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
    // Both before and after are retried with the same budget now — see
    // VERIFY_SCREENSHOT_RETRY_MAX_ATTEMPTS's doc comment and
    // docs/slam-verify-screenshot-retry-plan.md for why.
    let after = take_screenshot_with_retry(
        client,
        options.screenshot.unwrap(),
        VERIFY_SCREENSHOT_RETRY_MAX_ATTEMPTS,
        VERIFY_SCREENSHOT_RETRY_SETTLE_MS,
        options.verbose,
        "after",
        options.allow_keyboard_wake_after,
    )
    .await?;

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

    // slam_to_corner touches two process-global statics indirectly:
    // emit_clock (via mouse_move_relative) and orientation's bounds cache
    // (via the verify_motion path). Serialize every test that runs a real
    // client call through this crate-wide lock — see
    // `crate::test_support::GLOBAL_STATE_LOCK`'s doc for why a per-file
    // lock doesn't actually serialize against cursor_keepalive.rs's/
    // cursor_anchor.rs's own tests touching the same globals.
    use crate::test_support::GLOBAL_STATE_LOCK as TEST_LOCK;

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

    /// Unit tests for `take_screenshot_with_retry`
    /// (docs/slam-verify-screenshot-retry-plan.md): the outer retry
    /// layered on top of `client.screenshot()`'s own built-in
    /// retry-once, added after 3 real live occurrences of the `after`
    /// screenshot 503ing post-slam.
    mod take_screenshot_with_retry_tests {
        use super::*;

        /// A snapshot-only stub: returns a 503 (via `ClientError::Api`,
        /// the same shape `fetch_snapshot_with_retry` checks
        /// `api_status()` against) for the first `fail_raw_calls` RAW
        /// HTTP calls to `/streamer/snapshot`, then succeeds. Counts
        /// every raw call (including the client's own internal
        /// retry-once sub-calls), not outer attempts — that's what lets
        /// these tests distinguish "failed within one outer attempt's
        /// internal retry" from "needed a second outer attempt".
        fn stub_snapshot_client(
            fail_raw_calls: usize,
            screenshot: Vec<u8>,
        ) -> (PiKVMClient, ShotCalls) {
            let shot_calls: ShotCalls = Arc::new(StdMutex::new(0));
            let shot_calls_bg = shot_calls.clone();
            let screenshot = Arc::new(screenshot);
            let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
                let shot_calls = shot_calls_bg.clone();
                let screenshot = screenshot.clone();
                Box::pin(async move {
                    if args.path.starts_with("/streamer/snapshot") {
                        let mut i = shot_calls.lock().unwrap();
                        *i += 1;
                        if *i <= fail_raw_calls {
                            return Err(ClientError::Api(
                                pikvm_mcp_kvmd_client::client::PiKVMApiError {
                                    status: 503,
                                    message: "Service Unavailable".to_string(),
                                },
                            ));
                        }
                        return Ok(ResponseBody::Image((*screenshot).clone()));
                    }
                    // screenshot() force-refreshes resolution via
                    // get_resolution(true) AFTER fetching the snapshot
                    // buffer — needs a stubbed /streamer response too, or
                    // the whole call fails downstream of the snapshot
                    // fetch this test is actually exercising.
                    if args.path == "/streamer" {
                        return Ok(ResponseBody::Json(serde_json::json!({
                            "ok": true,
                            "result": { "streamer": { "source": { "online": true, "resolution": { "width": 1920, "height": 1080 } } } }
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
            (client, shot_calls)
        }

        #[tokio::test]
        async fn succeeds_on_the_first_attempt_when_the_client_succeeds_immediately() {
            let _guard = TEST_LOCK.lock().await;
            // screenshot() decodes the returned bytes as a real image
            // (dimension check) — a real (if tiny) JPEG, not arbitrary bytes.
            let (client, shot_calls) =
                stub_snapshot_client(0, jpeg_encode(&[0u8; 3 * 4 * 4], 4, 4));
            let result = take_screenshot_with_retry(
                &client,
                ScreenshotMode::Raw,
                3,
                1,
                false,
                "test",
                false,
            )
            .await;
            assert!(result.is_ok());
            // No retry needed — the client's own single request succeeds.
            assert_eq!(*shot_calls.lock().unwrap(), 1);
        }

        #[tokio::test]
        async fn recovers_when_the_first_outer_attempt_fails_but_the_second_succeeds() {
            let _guard = TEST_LOCK.lock().await;
            // The client's own built-in retry-once means ONE outer attempt
            // consumes 2 raw calls when it fails throughout. Failing the
            // first 2 raw calls exhausts outer attempt 1; the 3rd raw call
            // (outer attempt 2's first try) succeeds.
            let (client, shot_calls) =
                stub_snapshot_client(2, jpeg_encode(&[0u8; 3 * 4 * 4], 4, 4));
            let result = take_screenshot_with_retry(
                &client,
                ScreenshotMode::Raw,
                3,
                1,
                false,
                "test",
                false,
            )
            .await;
            assert!(result.is_ok());
            assert_eq!(*shot_calls.lock().unwrap(), 3);
        }

        #[tokio::test]
        async fn exhausts_max_attempts_and_returns_the_last_error() {
            let _guard = TEST_LOCK.lock().await;
            // Never succeeds: fail every raw call.
            let (client, shot_calls) = stub_snapshot_client(usize::MAX, vec![1, 2, 3]);
            let result = take_screenshot_with_retry(
                &client,
                ScreenshotMode::Raw,
                2,
                1,
                false,
                "test",
                false,
            )
            .await;
            assert!(result.is_err());
            // 2 outer attempts × 2 raw calls each (client's own internal retry).
            assert_eq!(*shot_calls.lock().unwrap(), 4);
        }

        #[tokio::test]
        async fn slam_to_corner_recovers_verify_motion_from_a_transient_after_screenshot_failure() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let before = jpeg_encode(&vec![0u8; 3 * 100 * 100], 100, 100);
            let after = before.clone();
            // Fail the `after` screenshot's first outer attempt (2 raw
            // calls) — well within the 3-attempt default budget — then
            // succeed. This exercises the SAME code path
            // cursor_anchor_corner_control_smoke.rs hit live 2026-08-30:
            // a transient 503 right after the slam, now recovered instead
            // of propagating as an Err.
            let shot_calls: ShotCalls = Arc::new(StdMutex::new(0));
            let shot_calls_bg = shot_calls.clone();
            let shots = Arc::new(vec![before, after]);
            let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
                let shot_calls = shot_calls_bg.clone();
                let shots = shots.clone();
                Box::pin(async move {
                    if args.path.starts_with("/hid/events/send_mouse_relative") {
                        return Ok(ResponseBody::Empty);
                    }
                    if args.path.starts_with("/streamer/snapshot") {
                        let mut i = shot_calls.lock().unwrap();
                        *i += 1;
                        // Calls 1 = the `before` shot (always succeeds).
                        // Calls 2-3 = the `after` shot's first outer
                        // attempt (both fail). Call 4+ = the `after`
                        // shot's second outer attempt (succeeds).
                        if *i == 1 {
                            return Ok(ResponseBody::Image(shots[0].clone()));
                        }
                        if *i <= 3 {
                            return Err(ClientError::Api(
                                pikvm_mcp_kvmd_client::client::PiKVMApiError {
                                    status: 503,
                                    message: "Service Unavailable".to_string(),
                                },
                            ));
                        }
                        return Ok(ResponseBody::Image(shots[1].clone()));
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
            let client = PiKVMClient::with_request_fn(
                PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
                None,
                request_fn,
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
            .await;
            assert!(
                result.is_ok(),
                "expected the transient after-screenshot 503 to be recovered, got {result:?}"
            );
        }

        #[tokio::test]
        async fn slam_to_corner_recovers_verify_motion_from_a_transient_before_screenshot_failure()
        {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            // New evidence (docs/rust-port-plan.md §15, 2026-08-30): the
            // `before` shot hit the identical 503 signature live, with NO
            // slam traffic preceding it — this test reproduces that shape
            // (fail before's first outer attempt, then recover) using
            // `before`'s lighter 2-attempt budget.
            let shot = jpeg_encode(&[0u8; 3 * 100 * 100], 100, 100);
            let shot_calls: ShotCalls = Arc::new(StdMutex::new(0));
            let shot_calls_bg = shot_calls.clone();
            let shot = Arc::new(shot);
            let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
                let shot_calls = shot_calls_bg.clone();
                let shot = shot.clone();
                Box::pin(async move {
                    if args.path.starts_with("/hid/events/send_mouse_relative") {
                        return Ok(ResponseBody::Empty);
                    }
                    if args.path.starts_with("/streamer/snapshot") {
                        let mut i = shot_calls.lock().unwrap();
                        *i += 1;
                        // Calls 1-2 = the `before` shot's first outer
                        // attempt (both fail, exhausting its 2-raw-call
                        // internal retry). Call 3 = before's second outer
                        // attempt (succeeds). Call 4+ = the `after` shot
                        // (always succeeds — not what this test covers).
                        if *i <= 2 {
                            return Err(ClientError::Api(
                                pikvm_mcp_kvmd_client::client::PiKVMApiError {
                                    status: 503,
                                    message: "Service Unavailable".to_string(),
                                },
                            ));
                        }
                        return Ok(ResponseBody::Image((*shot).clone()));
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
            let client = PiKVMClient::with_request_fn(
                PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
                None,
                request_fn,
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
            .await;
            assert!(
                result.is_ok(),
                "expected the transient before-screenshot 503 to be recovered, got {result:?}"
            );
        }
    }

    /// Pins the plumbing behind
    /// docs/corner-control-allow-keyboard-wake-decision.md:
    /// `SlamOptions.allow_keyboard_wake_after` must reach the `after`
    /// screenshot's `ScreenshotOptions.allow_keyboard_wake`, and NEVER
    /// the `before` screenshot's (a deliberately separate, undecided
    /// question) — regardless of what the caller passes.
    mod allow_keyboard_wake_after_tests {
        use super::*;

        /// `before` (raw call 1) succeeds immediately — no escalation
        /// from it, isolating the assertions to `after` alone. `after`
        /// (raw calls 2-3) 503s twice then succeeds on the 3rd — the
        /// exact shape `fetch_snapshot_with_retry`'s own retry-once-
        /// then-escalate needs to fire (not `take_screenshot_with_retry`'s
        /// separate OUTER retry, which never triggers here since each
        /// shot succeeds on its first attempt). Records whether the
        /// escalation used `/hid/events/send_key` (keyboard) or
        /// `/hid/events/send_mouse_relative` (mouse-move fallback).
        fn stub_with_escalation_tracking(
            shot: Vec<u8>,
        ) -> (PiKVMClient, Arc<StdMutex<Vec<&'static str>>>) {
            let snapshot_calls: Arc<StdMutex<u32>> = Arc::new(StdMutex::new(0));
            let escalations: Arc<StdMutex<Vec<&'static str>>> = Arc::new(StdMutex::new(Vec::new()));
            let shot = Arc::new(shot);
            let snapshot_calls_bg = snapshot_calls.clone();
            let escalations_bg = escalations.clone();
            let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
                let snapshot_calls = snapshot_calls_bg.clone();
                let escalations = escalations_bg.clone();
                let shot = shot.clone();
                Box::pin(async move {
                    if args.path.starts_with("/streamer/snapshot") {
                        let mut i = snapshot_calls.lock().unwrap();
                        *i += 1;
                        // `before` (raw call 1) succeeds immediately, no
                        // escalation. `after` (raw calls 2-3) fails twice
                        // then succeeds on the 3rd — the exact shape
                        // `fetch_snapshot_with_retry`'s own escalation
                        // needs to fire, isolated to just the after shot.
                        if *i == 2 || *i == 3 {
                            return Err(ClientError::Api(
                                pikvm_mcp_kvmd_client::client::PiKVMApiError {
                                    status: 503,
                                    message: "Service Unavailable".to_string(),
                                },
                            ));
                        }
                        return Ok(ResponseBody::Image((*shot).clone()));
                    }
                    if args.path.starts_with("/hid/events/send_key") {
                        escalations.lock().unwrap().push("keyboard");
                        return Ok(ResponseBody::Empty);
                    }
                    // The slam loop itself (±127 deltas) and the pre-
                    // verify in-corner nudge (±3, see slam_to_corner's own
                    // comment) also go through this same endpoint — only
                    // count it as an ESCALATION nudge when the magnitude
                    // matches `WAKE_NUDGE_DELTA_PX` (5), distinct from
                    // both.
                    if args.path.starts_with("/hid/events/send_mouse_relative") {
                        if args.path.contains("delta_x=5") || args.path.contains("delta_x=-5") {
                            escalations.lock().unwrap().push("mouse");
                        }
                        return Ok(ResponseBody::Empty);
                    }
                    if args.path == "/streamer" {
                        return Ok(ResponseBody::Json(serde_json::json!({
                            "ok": true,
                            "result": { "streamer": { "source": { "online": true, "resolution": { "width": 4, "height": 4 } } } }
                        })));
                    }
                    Ok(ResponseBody::Empty)
                })
            });
            let config = PiKVMConfig {
                source_online_wake_nudge: true,
                ..PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw")
            };
            (
                PiKVMClient::with_request_fn(config, None, request_fn),
                escalations,
            )
        }

        #[tokio::test]
        async fn allow_keyboard_wake_after_true_escalates_the_after_shot_with_a_keypress() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let shot = jpeg_encode(&[0u8; 3 * 4 * 4], 4, 4);
            let (client, escalations) = stub_with_escalation_tracking(shot);
            let result = slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    verify_motion: true,
                    screenshot: Some(ScreenshotMode::Raw),
                    corner: Some(Corner::TopLeft),
                    bounds_hint: Some(None),
                    allow_keyboard_wake_after: true,
                    ..Default::default()
                },
            )
            .await;
            assert!(result.is_ok(), "expected recovery, got {result:?}");
            // `before` never fails in this stub (no escalation from it);
            // `after`, opted in, escalates via keyboard.
            assert_eq!(*escalations.lock().unwrap(), vec!["keyboard"]);
        }

        #[tokio::test]
        async fn allow_keyboard_wake_after_false_escalates_the_after_shot_with_mouse_only() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let shot = jpeg_encode(&[0u8; 3 * 4 * 4], 4, 4);
            let (client, escalations) = stub_with_escalation_tracking(shot);
            let result = slam_to_corner(
                &client,
                SlamOptions {
                    pace_ms: Some(0),
                    verify_motion: true,
                    screenshot: Some(ScreenshotMode::Raw),
                    corner: Some(Corner::TopLeft),
                    bounds_hint: Some(None),
                    allow_keyboard_wake_after: false, // the default
                    ..Default::default()
                },
            )
            .await;
            assert!(result.is_ok(), "expected recovery, got {result:?}");
            // Not opted in (the default) — falls back to the mouse-move
            // nudge instead, even though `after` is the shot escalating.
            assert_eq!(*escalations.lock().unwrap(), vec!["mouse"]);
        }
    }
}
