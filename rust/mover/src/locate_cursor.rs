//! Locate the current cursor position by probing: send a small known
//! delta, diff before/after screenshots, identify the displaced cluster
//! pair.
//!
//! Faithful port of `src/pikvm/cursor-detect.ts`'s `locateCursor`. Lives
//! in `mover` (not `detection-vision`, which owns the pure
//! `LocateCursorOptions`/`LocateCursorResult` shapes this function
//! consumes/produces) because it drives the real `PiKVMClient` — same
//! crate-boundary reasoning as `cursor_anchor.rs`/`ballistics.rs`'s
//! `take_raw_screenshot`. This is `cursor_locator.rs`'s (detection-vision)
//! `CursorLocatorDeps.locate_cursor` DI slot's real implementation.
//!
//! **Caller contract** (from the TS source): after this returns
//! `Some(result)`, the cursor is at `result.position` — NOT at its
//! original pre-probe position. This function does NOT attempt to
//! restore the cursor: iPadOS pointer acceleration is asymmetric, so a
//! compensating move can leave the cursor anywhere between the pre and
//! post positions, silently lying about its post-call state. Callers
//! that want the cursor restored should re-locate after their move.

use std::time::Duration;

use pikvm_mcp_detection_vision::cursor_detect::{
    diff_screenshots, Cluster, DetectionConfig, LocateCursorOptions, LocateCursorResult, Point,
    DEFAULT_DETECTION_CONFIG,
};
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::ballistics::take_raw_screenshot;

/// Faithful port of `locateCursor`. Returns `None` if detection fails
/// after `max_attempts` (default 3) — e.g. cursor hidden, screen too
/// noisy, cursor on a region that doesn't diff well.
pub async fn locate_cursor(
    client: &PiKVMClient,
    options: LocateCursorOptions,
) -> anyhow::Result<Option<LocateCursorResult>> {
    // Phase 29 finding (TS source): probeDelta=10 was too small — iPadOS
    // amplifies small mickey commands by up to 20x. 60 gives the cursor
    // pair a displacement that dwarfs animation-noise inter-cluster
    // distances (typically <50px), which is what makes pair selection work.
    let base_probe_delta = options.probe_delta.unwrap_or(60.0);
    let settle_ms = options.settle_ms.unwrap_or(300);
    let max_attempts = options.max_attempts.unwrap_or(3);
    // Default brightness floor lowered from 170 to 100 — same fix as
    // detectMotion in move-to.ts. iPadOS dimmed-modal contexts render the
    // cursor with channel values 100-160; the 170 floor was rejecting them.
    let detection = DetectionConfig {
        brightness_floor: 100,
        ..options.detection.unwrap_or(DEFAULT_DETECTION_CONFIG)
    };

    // Probe-size sweep: try increasing sizes per attempt so we don't fail
    // on busy screens just because the default 60-mickey probe was too
    // small.
    let probe_deltas = [
        base_probe_delta,
        (base_probe_delta * 3.0).max(30.0),
        (base_probe_delta * 6.0).max(60.0),
    ];

    for attempt in 0..max_attempts {
        let probe_delta = probe_deltas[(attempt as usize).min(probe_deltas.len() - 1)];
        // Phase 29: widened sanity window to [probeDelta*0.3, probeDelta*25]
        // to accommodate iPadOS pointer-acceleration amplification of up to
        // ~20x on small mickey emits. The high lower bound still rejects
        // animation-noise pairs (typically separated by < 0.3*probeDelta).
        let expected_disp_min = probe_delta * 0.3;
        let expected_disp_max = probe_delta * 25.0;

        // Wake-up move: iPadOS fades the cursor after ~1s of inactivity. A
        // larger one-shot motion (-120 mickeys) makes iPadOS render the
        // cursor before the BEFORE shot — no compensating move afterward
        // (see this function's own doc comment: no restore, ever).
        client.mouse_move_relative(-120.0, 0.0).await?;
        tokio::time::sleep(Duration::from_millis(settle_ms)).await;

        let before = take_raw_screenshot(client).await?;
        tokio::time::sleep(Duration::from_millis(settle_ms)).await;

        client.mouse_move_relative(probe_delta, 0.0).await?;
        tokio::time::sleep(Duration::from_millis(settle_ms)).await;
        let after = take_raw_screenshot(client).await?;

        let clusters = match diff_screenshots(&before, &after, &detection) {
            Ok(c) => c,
            Err(_) => {
                if options.verbose {
                    eprintln!("[locate_cursor] attempt {}: diff failed", attempt + 1);
                }
                continue;
            }
        };

        // Cursor-sized clusters only — rejects animated widget noise
        // (clock seconds, weather, etc.) on busy iPad backdrops. The iPad
        // cursor cluster is just 4-7 bright pixels after the brightness
        // floor culls anti-aliased edges.
        let sized: Vec<&Cluster> = clusters
            .iter()
            .filter(|c| c.pixels >= 4 && c.pixels <= 90)
            .collect();

        if sized.len() < 2 {
            if options.verbose {
                eprintln!(
                    "[locate_cursor] attempt {}: {} total, {} cursor-sized [4-90px] (need >=2)",
                    attempt + 1,
                    clusters.len(),
                    sized.len()
                );
            }
            continue;
        }

        // The probe was +x by probe_delta mickeys — pick the pair whose
        // displacement is roughly +x, magnitude close to probe_delta.
        let mut pre: Option<&Cluster> = None;
        let mut post: Option<&Cluster> = None;
        let mut best_score = f64::NEG_INFINITY;
        let expected_near = options.expected_near;
        let expected_near_radius = options.expected_near_radius.unwrap_or(200.0);

        for a_clu in &sized {
            for b_clu in &sized {
                if std::ptr::eq(*a_clu, *b_clu) {
                    continue;
                }
                let dx = (b_clu.centroid_x - a_clu.centroid_x) as f64;
                let dy = (b_clu.centroid_y - a_clu.centroid_y) as f64;
                if dx <= 0.0 {
                    continue;
                }
                let mag = dx.hypot(dy);
                if mag < expected_disp_min || mag > expected_disp_max {
                    continue;
                }
                // Direction within ~30 degrees of +x.
                if dx / mag < 0.85 {
                    continue;
                }
                if let Some(near) = expected_near {
                    let dist = ((b_clu.centroid_x as f64 - near.x).powi(2)
                        + (b_clu.centroid_y as f64 - near.y).powi(2))
                    .sqrt();
                    if dist > expected_near_radius {
                        continue;
                    }
                }
                let size_ratio = (a_clu.pixels.max(b_clu.pixels) as f64)
                    / (1usize.max(a_clu.pixels.min(b_clu.pixels)) as f64);
                if size_ratio > 4.0 {
                    continue;
                }
                let mut score = -(mag - probe_delta).abs() - 5.0 * size_ratio.log2();
                if let Some(near) = expected_near {
                    let dist = ((b_clu.centroid_x as f64 - near.x).powi(2)
                        + (b_clu.centroid_y as f64 - near.y).powi(2))
                    .sqrt();
                    score -= dist * 0.05;
                }
                if score > best_score {
                    best_score = score;
                    pre = Some(a_clu);
                    post = Some(b_clu);
                }
            }
        }

        let (Some(pre), Some(post)) = (pre, post) else {
            if options.verbose {
                eprintln!(
                    "[locate_cursor] attempt {}: {} cursor-sized clusters but no +x pair within {}-{}px",
                    attempt + 1,
                    sized.len(),
                    expected_disp_min,
                    expected_disp_max
                );
            }
            continue;
        };

        let probe_offset_px = Point {
            x: (post.centroid_x - pre.centroid_x) as f64,
            y: (post.centroid_y - pre.centroid_y) as f64,
        };

        if options.verbose {
            eprintln!(
                "[locate_cursor] pre=({},{}) post=({},{}) offset=({},{}) — cursor now at post",
                pre.centroid_x,
                pre.centroid_y,
                post.centroid_x,
                post.centroid_y,
                probe_offset_px.x,
                probe_offset_px.y
            );
        }

        return Ok(Some(LocateCursorResult {
            probe_mickeys: Point {
                x: probe_delta,
                y: 0.0,
            },
            // post = where the cursor IS after this function returns.
            position: Point {
                x: post.centroid_x as f64,
                y: post.centroid_y as f64,
            },
            pre_position: Point {
                x: pre.centroid_x as f64,
                y: pre.centroid_y as f64,
            },
            probe_offset_px,
            cluster_count: clusters.len(),
        }));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};
    use std::sync::{Arc, Mutex};

    fn raw_solid(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
        for i in 0..(w as usize) * (h as usize) {
            buf[i * 3] = fill[0];
            buf[i * 3 + 1] = fill[1];
            buf[i * 3 + 2] = fill[2];
        }
        buf
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

    fn solid_jpeg(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
        jpeg_encode(&raw_solid(w, h, fill), w, h)
    }

    /// Real `PiKVMClient` test double: every screenshot is an identical
    /// uniform-grey frame — no diff cluster can ever form. Matches
    /// `auto_calibrate`'s own `uniform_frame_client` test-double
    /// convention.
    fn uniform_frame_client(resolution: (u32, u32)) -> PiKVMClient {
        let (w, h) = resolution;
        let frame = solid_jpeg(w, h, [128, 128, 128]);
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let frame = frame.clone();
            Box::pin(async move {
                if args.path.starts_with("/hid/events/send_mouse_relative") {
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
        PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
            None,
            request_fn,
        )
    }

    /// A client whose screenshot renders a small bright square at the
    /// CURRENT tracked cursor position — updated on every
    /// `send_mouse_relative` call the same way the real HID emit moves a
    /// real cursor. Lets a test exercise the real probe → diff → cluster-
    /// pair-selection path end to end.
    fn tracking_cursor_client(
        resolution: (u32, u32),
        start: (f64, f64),
    ) -> (PiKVMClient, Arc<Mutex<(f64, f64)>>) {
        let (w, h) = resolution;
        let position = Arc::new(Mutex::new(start));
        let position_bg = position.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let position = position_bg.clone();
            let (w, h) = (w, h);
            Box::pin(async move {
                if let Some(query) = args.path.strip_prefix("/hid/events/send_mouse_relative?") {
                    let mut dx = 0.0;
                    let mut dy = 0.0;
                    for pair in query.split('&') {
                        if let Some(v) = pair.strip_prefix("delta_x=") {
                            dx = v.parse::<f64>().unwrap_or(0.0);
                        } else if let Some(v) = pair.strip_prefix("delta_y=") {
                            dy = v.parse::<f64>().unwrap_or(0.0);
                        }
                    }
                    let mut pos = position.lock().unwrap();
                    pos.0 = (pos.0 + dx).clamp(0.0, (w - 1) as f64);
                    pos.1 = (pos.1 + dy).clamp(0.0, (h - 1) as f64);
                    return Ok(ResponseBody::Empty);
                }
                if args.path.starts_with("/streamer/snapshot") {
                    let (cx, cy) = *position.lock().unwrap();
                    let base = raw_solid(w, h, [30, 30, 30]);
                    let stamped =
                        stamp_square(&base, w, h, cx as i64, cy as i64, 5, [220, 220, 220]);
                    return Ok(ResponseBody::Image(jpeg_encode(&stamped, w, h)));
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
        (client, position)
    }

    #[tokio::test]
    async fn returns_none_after_max_attempts_when_the_frame_never_diffs() {
        let client = uniform_frame_client((320, 240));
        let result = locate_cursor(
            &client,
            LocateCursorOptions {
                settle_ms: Some(0),
                max_attempts: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn finds_the_probe_pair_and_reports_post_position_not_a_restored_one() {
        // Start well away from the frame edges so the -120 wake move and
        // the +60 probe both land in-bounds.
        let (client, position) = tracking_cursor_client((640, 480), (300.0, 200.0));
        let result = locate_cursor(
            &client,
            LocateCursorOptions {
                settle_ms: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .expect("a real +x-moving cursor cluster pair should be found");

        let (final_x, final_y) = *position.lock().unwrap();
        // Contract (this function's own doc comment): no compensating
        // restore — the cursor is at its ACTUAL current (post-probe)
        // position when this returns, and result.position matches it.
        assert_eq!(result.position.x, final_x);
        assert_eq!(result.position.y, final_y);
        // pre_position is BEFORE the probe (i.e. after the wake move,
        // before the +probe_delta emit) — strictly less than post on X.
        assert!(result.pre_position.x < result.position.x);
        assert_eq!(result.probe_mickeys, Point { x: 60.0, y: 0.0 });
        assert_eq!(
            result.probe_offset_px,
            Point {
                x: result.position.x - result.pre_position.x,
                y: 0.0
            }
        );
    }
}
