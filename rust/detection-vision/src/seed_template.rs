//! Phase 58/59 — bootstrap a cursor template via wake-and-capture.
//!
//! Faithful port of `src/pikvm/seed-template.ts`.
//!
//! The cursor-template chain needs at least ONE good template in the
//! template directory for `find_cursor_by_template_set` to do anything
//! useful. `seed_cursor_template` breaks the empty-set deadlock with a
//! deterministic one-shot capture: emit a known relative motion, diff
//! before/after, pick the largest motion cluster, extract a 24x24
//! template at its centroid, validate via `looks_like_cursor`, and
//! persist.
//!
//! `SeedTemplateClient` is the minimum PiKVM surface needed — modelled as
//! injectable closures (matching module 1's `HeaderAuthorizer`/module 5's
//! `HidRecoveryClient` DI convention) rather than the concrete
//! `PiKVMClient` type, so this crate stays free of a module-2 dependency.

use crate::cursor_detect::{
    compute_template_hotspot, decode_screenshot, diff_pixels, diff_screenshots_decoded,
    extract_cursor_template_decoded, CursorTemplate, DecodedScreenshot, DetectionConfig, Point,
};
use crate::looks_like_cursor::looks_like_cursor;
use crate::template_set::{
    load_template_set, persist_template, MaxAge, PlanDecision, PlanResult, DEFAULT_TEMPLATE_DIR,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub struct ScreenshotResult {
    pub buffer: Vec<u8>,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
}

/// The minimum surface of `PiKVMClient` needed by `seed_cursor_template`.
pub struct SeedTemplateClient {
    pub screenshot:
        Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<ScreenshotResult>> + Send + Sync>,
    /// If available, prefer this for the seed before/after screenshots —
    /// it keeps the iPad cursor visible by emitting a wake nudge before
    /// capture. Optional for back-compat with test doubles that don't
    /// supply the new method.
    pub screenshot_keeping_cursor_alive:
        Option<Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<ScreenshotResult>> + Send + Sync>>,
    pub mouse_move_relative:
        Arc<dyn Fn(f64, f64) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync>,
}

pub type SleepFn = Arc<dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync>;
pub type LoadExistingFn =
    Arc<dyn Fn(String) -> BoxFuture<'static, anyhow::Result<Vec<CursorTemplate>>> + Send + Sync>;
pub type PersistFn = Arc<
    dyn Fn(
            String,
            CursorTemplate,
            Vec<CursorTemplate>,
        ) -> BoxFuture<'static, anyhow::Result<PlanResult>>
        + Send
        + Sync,
>;

#[derive(Default)]
pub struct SeedTemplateOptions {
    /// X-axis mickeys for the wake motion. Default 100.
    pub emit_dx: Option<f64>,
    /// Y-axis mickeys for the wake motion. Default 0.
    pub emit_dy: Option<f64>,
    /// Delay between motion and post-screenshot. Default 500ms.
    pub settle_ms: Option<u64>,
    /// Override the template directory (tests).
    pub dir: Option<String>,
    /// Override the sleep (tests pass a stub that resolves immediately).
    pub sleep: Option<SleepFn>,
    /// Override the persisted-template loader (tests).
    pub load_existing: Option<LoadExistingFn>,
    /// Override the persist function (tests).
    pub persist: Option<PersistFn>,
}

pub struct SeedTemplateResult {
    /// True iff a template was newly added to the set. False on duplicate
    /// or any failure path.
    pub ok: bool,
    /// The detected cursor centroid (HDMI pixels), or None if motion-diff
    /// produced no clusters.
    pub cursor_position: Option<Point>,
    /// True iff a NEW template was written (decision = Added or
    /// Replaced). False on duplicate or any failure.
    pub template_persisted: bool,
    /// `persist_template`'s decision when reached, otherwise None.
    pub decision: Option<PlanDecision>,
    /// Total templates in the set after the operation.
    pub template_count: Option<usize>,
    /// Human-readable explanation of the outcome.
    pub reason: String,
}

async fn grab_screenshot(client: &SeedTemplateClient) -> anyhow::Result<ScreenshotResult> {
    match &client.screenshot_keeping_cursor_alive {
        Some(f) => f().await,
        None => (client.screenshot)().await,
    }
}

async fn sleep_for(sleep: &Option<SleepFn>, ms: u64) {
    match sleep {
        Some(f) => f(ms).await,
        None => tokio::time::sleep(Duration::from_millis(ms)).await,
    }
}

pub async fn seed_cursor_template(
    client: &SeedTemplateClient,
    options: SeedTemplateOptions,
) -> anyhow::Result<SeedTemplateResult> {
    let emit_dx = options.emit_dx.unwrap_or(100.0);
    let emit_dy = options.emit_dy.unwrap_or(0.0);
    let settle_ms = options.settle_ms.unwrap_or(500);
    let dir = options
        .dir
        .clone()
        .unwrap_or_else(|| DEFAULT_TEMPLATE_DIR.to_string());

    let before = grab_screenshot(client).await?;
    (client.mouse_move_relative)(emit_dx, emit_dy).await?;
    sleep_for(&options.sleep, settle_ms).await;
    let after = grab_screenshot(client).await?;

    let dec_before = decode_screenshot(&before.buffer)?;
    let dec_after = decode_screenshot(&after.buffer)?;

    // Cluster-size bounds tuned from live measurement: the actual iPadOS
    // cursor in a plain area produces diff clusters of 80-90px (anti-
    // aliased edges + soft shadow); 120 admits real cursors comfortably
    // while excluding pointer-effect halos (200-400+px). Lower bound 15
    // excludes JPEG noise.
    let config = DetectionConfig {
        diff_threshold: 30,
        min_cluster_size: 15,
        max_cluster_size: 120,
        merge_radius: 20.0,
        brightness_floor: 100,
        max_channel_delta: 0,
    };
    let clusters = diff_screenshots_decoded(&dec_before, &dec_after, &config)?;
    if clusters.is_empty() {
        return Ok(SeedTemplateResult {
            ok: false,
            cursor_position: None,
            template_persisted: false,
            decision: None,
            template_count: None,
            reason: "no cursor-sized motion-diff clusters detected (15-120 px). Cursor may be off-screen, dim, faded, or already at the wake-emit destination. Try a larger emitDx/emitDy or wait for iPadOS to render the cursor before seeding.".to_string(),
        });
    }

    // Compute the per-pixel diff mask once. Used to mask the template
    // extract — pixels that didn't change (static background context)
    // get zeroed out, leaving only the cursor's contribution.
    let diff_mask = diff_pixels(
        &dec_before.rgb,
        &dec_after.rgb,
        dec_before.width,
        dec_before.height,
        30,  // diff_threshold (matches diff_screenshots_decoded above)
        100, // brightness_floor
        0,   // max_channel_delta
    );

    // Motion-diff produces TWO clusters per cursor move — the BEFORE
    // position (now empty in dec_after, extraction yields a dark template
    // that fails the brightness gate) and the AFTER position (now bright,
    // extraction yields a real cursor template). Cluster sizes are often
    // similar, so picking "largest" doesn't reliably pick the AFTER
    // cluster. Trying both, largest-first, is robust.
    let mut sorted = clusters.clone();
    sorted.sort_by_key(|c| std::cmp::Reverse(c.pixels));
    let mut chosen: Option<(usize, CursorTemplate)> = None;
    let mut reject_reasons: Vec<String> = Vec::new();
    for (i, cluster) in sorted.iter().enumerate() {
        let (px, py) = (cluster.centroid_x, cluster.centroid_y);
        let candidate = extract_masked_template(
            &dec_after,
            Point {
                x: px as f64,
                y: py as f64,
            },
            24,
            &diff_mask,
        );
        if looks_like_cursor(&candidate) {
            chosen = Some((i, candidate));
            break;
        }
        reject_reasons.push(format!(
            "({px},{py}) {}px → looksLikeCursor rejected",
            cluster.pixels
        ));
    }
    let (chosen_idx, chosen_template) = match chosen {
        Some(c) => c,
        None => {
            let first = &sorted[0];
            return Ok(SeedTemplateResult {
                ok: false,
                cursor_position: Some(Point {
                    x: first.centroid_x as f64,
                    y: first.centroid_y as f64,
                }),
                template_persisted: false,
                decision: None,
                template_count: None,
                reason: format!(
                    "looksLikeCursor rejected all {} candidate cluster(s). Tried: {}. The motion-diff clusters may not be the cursor — try a different wake emit direction, or check that the iPad screen is bright enough.",
                    sorted.len(),
                    reject_reasons.iter().take(5).cloned().collect::<Vec<_>>().join("; ")
                ),
            });
        }
    };
    let chosen_cluster = &sorted[chosen_idx];
    let cursor_pos = Point {
        x: chosen_cluster.centroid_x as f64,
        y: chosen_cluster.centroid_y as f64,
    };

    let existing = match &options.load_existing {
        Some(f) => f(dir.clone()).await?,
        None => load_template_set(&dir, None, MaxAge::Default).await?,
    };
    let result = match &options.persist {
        Some(f) => f(dir.clone(), chosen_template, existing).await?,
        None => persist_template(&dir, &chosen_template, &existing).await?,
    };

    let decision_word = match result.decision {
        PlanDecision::Added => "added",
        PlanDecision::Replaced => "replaced",
        PlanDecision::Duplicate => "duplicate",
    };
    Ok(SeedTemplateResult {
        ok: result.decision != PlanDecision::Duplicate,
        cursor_position: Some(cursor_pos),
        template_persisted: result.decision != PlanDecision::Duplicate,
        decision: Some(result.decision),
        template_count: Some(result.kept.len()),
        reason: if result.decision == PlanDecision::Duplicate {
            "Template was perceptually similar to an existing one — kept the existing copy."
                .to_string()
        } else {
            format!("Template {decision_word} ({} total).", result.kept.len())
        },
    })
}

/// Extract a 24x24 cursor template from `screenshot` centred on `centre`,
/// but ZERO OUT pixels that are NOT in the supplied diff mask.
///
/// The motivation: the cursor's footprint is a small subset of the 24x24
/// template region. The rest is static background context (text, icons,
/// indicator bars) that contaminates the template — `looks_like_cursor`'s
/// brightness gate then rejects the extract because the surrounding
/// context contributes too many bright pixels. The diff mask flags pixels
/// that CHANGED between BEFORE and AFTER frames — exactly the cursor's
/// contribution (because the cursor moved). Masking the extract to the
/// diff signature gives a template that has bright cursor pixels in the
/// right shape and zeros everywhere else, regardless of what was
/// originally underneath the cursor.
///
/// Pure: no I/O, deterministic.
pub fn extract_masked_template(
    screenshot: &DecodedScreenshot,
    centre: Point,
    size: u32,
    diff_mask: &[bool],
) -> CursorTemplate {
    // Extract first via the existing path (handles edge clamping correctly).
    let mut tpl = extract_cursor_template_decoded(screenshot, centre, size);
    // Re-derive the same clamped top-left as extract_cursor_template_decoded
    // so we can index back into the diff mask at the matching pixel.
    let half = (size / 2) as f64;
    let left = 0f64
        .max((screenshot.width as f64 - size as f64).min(centre.x - half))
        .round() as u32;
    let top = 0f64
        .max((screenshot.height as f64 - size as f64).min(centre.y - half))
        .round() as u32;
    for y in 0..size {
        let src_y = top + y;
        for x in 0..size {
            let src_x = left + x;
            let mask_idx = (src_y as usize) * (screenshot.width as usize) + (src_x as usize);
            if !diff_mask[mask_idx] {
                let tpl_off = ((y * size + x) as usize) * 3;
                tpl.rgb[tpl_off] = 0;
                tpl.rgb[tpl_off + 1] = 0;
                tpl.rgb[tpl_off + 2] = 0;
            }
        }
    }
    // Re-derive hotspot AFTER masking; the masked pixel distribution
    // differs from the un-masked pre-mask version, and the post-mask
    // distribution is what find_cursor_by_template actually correlates
    // against.
    tpl.hotspot = Some(compute_template_hotspot(&tpl));
    tpl
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor_detect::find_cursor_by_template_set;
    use crate::cursor_detect::FindCursorOptions;
    use std::sync::Mutex;

    struct ScriptedState {
        call_index: usize,
        shots: Vec<Vec<u8>>,
        emits: Vec<(f64, f64)>,
    }

    fn scripted_client(shots: Vec<Vec<u8>>) -> (SeedTemplateClient, Arc<Mutex<ScriptedState>>) {
        let state = Arc::new(Mutex::new(ScriptedState {
            call_index: 0,
            shots,
            emits: Vec::new(),
        }));

        let state_for_screenshot = state.clone();
        let screenshot: Arc<
            dyn Fn() -> BoxFuture<'static, anyhow::Result<ScreenshotResult>> + Send + Sync,
        > = Arc::new(move || {
            let state = state_for_screenshot.clone();
            Box::pin(async move {
                let mut s = state.lock().unwrap();
                let idx = s.call_index.min(s.shots.len() - 1);
                s.call_index += 1;
                let buf = s.shots[idx].clone();
                Ok(ScreenshotResult {
                    buffer: buf,
                    screenshot_width: 256,
                    screenshot_height: 256,
                })
            })
        });

        let state_for_move = state.clone();
        let mouse_move_relative: Arc<
            dyn Fn(f64, f64) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync,
        > = Arc::new(move |dx, dy| {
            let state = state_for_move.clone();
            Box::pin(async move {
                state.lock().unwrap().emits.push((dx, dy));
                Ok(())
            })
        });

        (
            SeedTemplateClient {
                screenshot,
                screenshot_keeping_cursor_alive: None,
                mouse_move_relative,
            },
            state,
        )
    }

    fn immediate_sleep() -> SleepFn {
        Arc::new(|_ms| Box::pin(async {}))
    }

    fn empty_load_existing() -> LoadExistingFn {
        Arc::new(|_dir| Box::pin(async { Ok(Vec::new()) }))
    }

    /// Build a 256x256 JPEG with an optional bright cluster at (cx, cy).
    fn jpeg_with_cluster(cx: Option<i64>, cy: Option<i64>, gray: u8, size: i64) -> Vec<u8> {
        let (w, h) = (256u32, 256u32);
        let mut raw = vec![30u8; (w as usize) * (h as usize) * 3]; // dark grey background
        if let (Some(cx), Some(cy)) = (cx, cy) {
            let half = size / 2;
            for y in (cy - half)..(cy - half + size) {
                for x in (cx - half)..(cx - half + size) {
                    let idx = ((y as u32 * w + x as u32) as usize) * 3;
                    raw[idx] = gray;
                    raw[idx + 1] = gray;
                    raw[idx + 2] = gray;
                }
            }
        }
        let img: image::RgbImage = image::ImageBuffer::from_raw(w, h, raw).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 100);
        encoder.encode_image(&img).unwrap();
        buf
    }

    #[tokio::test]
    async fn happy_path_cursor_cluster_detected_template_added() {
        let before = jpeg_with_cluster(None, None, 220, 6); // no cursor (faded)
        let after = jpeg_with_cluster(Some(100), Some(100), 220, 6); // bright cluster appears
        let (client, state) = scripted_client(vec![before, after]);

        let persist_called = Arc::new(Mutex::new(false));
        let persist_called_for_closure = persist_called.clone();
        let persist: PersistFn = Arc::new(move |_dir, t, _existing| {
            *persist_called_for_closure.lock().unwrap() = true;
            Box::pin(async move {
                Ok(PlanResult {
                    kept: vec![t],
                    decision: PlanDecision::Added,
                })
            })
        });

        let result = seed_cursor_template(
            &client,
            SeedTemplateOptions {
                sleep: Some(immediate_sleep()),
                load_existing: Some(empty_load_existing()),
                persist: Some(persist),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(result.ok);
        let pos = result.cursor_position.unwrap();
        assert!((95.0..=105.0).contains(&pos.x));
        assert!(result.template_persisted);
        assert_eq!(result.decision, Some(PlanDecision::Added));
        assert!(*persist_called.lock().unwrap());
        assert_eq!(state.lock().unwrap().emits, vec![(100.0, 0.0)]);
    }

    #[tokio::test]
    async fn returns_failure_when_motion_diff_finds_no_clusters() {
        // Both screenshots identical -> no diff -> no clusters.
        let same = jpeg_with_cluster(None, None, 220, 6);
        let (client, _state) = scripted_client(vec![same.clone(), same]);

        let persist: PersistFn = Arc::new(|_dir, _t, _existing| {
            Box::pin(async {
                anyhow::bail!("persist should not be called when there are no clusters")
            })
        });

        let result = seed_cursor_template(
            &client,
            SeedTemplateOptions {
                sleep: Some(immediate_sleep()),
                load_existing: Some(empty_load_existing()),
                persist: Some(persist),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(!result.ok);
        assert!(result.cursor_position.is_none());
        assert!(!result.template_persisted);
        assert!(result
            .reason
            .contains("no cursor-sized motion-diff clusters"));
    }

    #[tokio::test]
    async fn returns_failure_when_looks_like_cursor_rejects_the_extracted_template() {
        // 4x4 cluster (16 bright px) passes the motion-diff lower bound
        // (min_cluster_size=15) but is below the 4% threshold looks_like_cursor
        // requires. The cluster is detected, the template is extracted, but
        // looks_like_cursor rejects.
        let before = jpeg_with_cluster(None, None, 220, 6);
        let after = jpeg_with_cluster(Some(100), Some(100), 220, 4);
        let (client, _state) = scripted_client(vec![before, after]);

        let persist: PersistFn = Arc::new(|_dir, _t, _existing| {
            Box::pin(async {
                anyhow::bail!("persist should not be called when looks_like_cursor rejects")
            })
        });

        let result = seed_cursor_template(
            &client,
            SeedTemplateOptions {
                sleep: Some(immediate_sleep()),
                load_existing: Some(empty_load_existing()),
                persist: Some(persist),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(!result.ok);
        assert!(!result.template_persisted);
        assert!(result.reason.contains("looksLikeCursor"));
        assert!(result.cursor_position.is_some());
    }

    #[tokio::test]
    async fn tries_multiple_candidate_clusters_until_one_passes_looks_like_cursor() {
        // BEFORE has cluster at (50, 100). AFTER has cluster at (150, 100).
        // Diff sees both as "changed" — two cluster candidates. The BEFORE-
        // position candidate must be tried and rejected before the AFTER
        // one succeeds.
        let before = jpeg_with_cluster(Some(50), Some(100), 220, 6);
        let after = jpeg_with_cluster(Some(150), Some(100), 220, 6);
        let (client, _state) = scripted_client(vec![before, after]);

        let persist_called = Arc::new(Mutex::new(false));
        let persist_called_for_closure = persist_called.clone();
        let persist: PersistFn = Arc::new(move |_dir, t, _existing| {
            *persist_called_for_closure.lock().unwrap() = true;
            Box::pin(async move {
                Ok(PlanResult {
                    kept: vec![t],
                    decision: PlanDecision::Added,
                })
            })
        });

        let result = seed_cursor_template(
            &client,
            SeedTemplateOptions {
                sleep: Some(immediate_sleep()),
                load_existing: Some(empty_load_existing()),
                persist: Some(persist),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(result.ok);
        assert!(*persist_called.lock().unwrap());
        let pos = result.cursor_position.unwrap();
        assert!((145.0..=155.0).contains(&pos.x));
    }

    #[tokio::test]
    async fn returns_ok_false_on_duplicate_but_reports_the_cursor_position() {
        let before = jpeg_with_cluster(None, None, 220, 6);
        let after = jpeg_with_cluster(Some(100), Some(100), 220, 6);
        let (client, _state) = scripted_client(vec![before, after]);

        let load_existing: LoadExistingFn = Arc::new(|_dir| {
            Box::pin(async {
                Ok(vec![CursorTemplate {
                    rgb: Vec::new(),
                    width: 0,
                    height: 0,
                    hotspot: None,
                }])
            })
        });
        let persist: PersistFn = Arc::new(|_dir, _t, existing| {
            Box::pin(async move {
                Ok(PlanResult {
                    kept: existing,
                    decision: PlanDecision::Duplicate,
                })
            })
        });

        let result = seed_cursor_template(
            &client,
            SeedTemplateOptions {
                sleep: Some(immediate_sleep()),
                load_existing: Some(load_existing),
                persist: Some(persist),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(!result.ok);
        assert!(!result.template_persisted);
        assert_eq!(result.decision, Some(PlanDecision::Duplicate));
        assert!(result.reason.contains("perceptually similar"));
        assert!(result.cursor_position.is_some());
    }

    #[tokio::test]
    async fn emit_override_passes_custom_emit_dx_dy_through_to_mouse_move_relative() {
        let before = jpeg_with_cluster(None, None, 220, 6);
        let after = jpeg_with_cluster(Some(100), Some(100), 220, 6);
        let (client, state) = scripted_client(vec![before, after]);

        let persist: PersistFn = Arc::new(|_dir, t, _existing| {
            Box::pin(async move {
                Ok(PlanResult {
                    kept: vec![t],
                    decision: PlanDecision::Added,
                })
            })
        });

        seed_cursor_template(
            &client,
            SeedTemplateOptions {
                emit_dx: Some(50.0),
                emit_dy: Some(80.0),
                sleep: Some(immediate_sleep()),
                load_existing: Some(empty_load_existing()),
                persist: Some(persist),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(state.lock().unwrap().emits, vec![(50.0, 80.0)]);
    }

    // --- extract_masked_template ------------------------------------------

    fn frame(width: u32, height: u32, fill: impl Fn(usize) -> [u8; 3]) -> DecodedScreenshot {
        let px = (width as usize) * (height as usize);
        let mut rgb = vec![0u8; px * 3];
        for i in 0..px {
            let [r, g, b] = fill(i);
            rgb[i * 3] = r;
            rgb[i * 3 + 1] = g;
            rgb[i * 3 + 2] = b;
        }
        DecodedScreenshot {
            buffer: Vec::new(),
            rgb,
            width,
            height,
        }
    }

    #[test]
    fn all_true_mask_is_identity() {
        let screen = frame(50, 50, |i| {
            let (x, y) = (i % 50, i / 50);
            let in_cursor = (x as i64 - 25).abs() < 4 && (y as i64 - 25).abs() < 4;
            if in_cursor {
                [240, 240, 240]
            } else {
                [60, 60, 60]
            }
        });
        let all_true = vec![true; 50 * 50];
        let tpl = extract_masked_template(&screen, Point { x: 25.0, y: 25.0 }, 24, &all_true);

        let centre_off = (12 * 24 + 12) * 3;
        assert_eq!(tpl.rgb[centre_off], 240);
        assert_eq!(tpl.rgb[0], 60);
    }

    #[test]
    fn all_false_mask_produces_an_all_zero_template() {
        let screen = frame(50, 50, |_| [240, 240, 240]);
        let all_false = vec![false; 50 * 50];
        let tpl = extract_masked_template(&screen, Point { x: 25.0, y: 25.0 }, 24, &all_false);
        assert!(tpl.rgb.iter().all(|&v| v == 0));
    }

    #[test]
    fn mask_isolating_a_6x6_region_keeps_only_those_pixels_bright() {
        let screen = frame(50, 50, |_| [240, 240, 240]);
        let mut mask = vec![false; 50 * 50];
        for y in 22..28 {
            for x in 22..28 {
                mask[y * 50 + x] = true;
            }
        }
        let tpl = extract_masked_template(&screen, Point { x: 25.0, y: 25.0 }, 24, &mask);

        let bright = (0..24 * 24).filter(|&i| tpl.rgb[i * 3] > 100).count();
        assert_eq!(bright, 36);
    }

    #[test]
    fn masked_template_matches_the_same_cursor_shape_at_a_new_position() {
        let seed_frame = frame(80, 80, |i| {
            let (x, y) = (i % 80, i / 80);
            let in_cluster = (x as i64 - 25).abs() < 3 && (y as i64 - 25).abs() < 3;
            if in_cluster {
                [240, 240, 240]
            } else {
                [80, 80, 80]
            }
        });
        let mut seed_mask = vec![false; 80 * 80];
        for y in 22..28 {
            for x in 22..28 {
                seed_mask[y * 80 + x] = true;
            }
        }
        let masked_template =
            extract_masked_template(&seed_frame, Point { x: 25.0, y: 25.0 }, 24, &seed_mask);

        let search_frame = frame(80, 80, |i| {
            let (x, y) = (i % 80, i / 80);
            let in_cursor = (x as i64 - 40).abs() < 3 && (y as i64 - 30).abs() < 3;
            if in_cursor {
                [240, 240, 240]
            } else {
                [20, 20, 20]
            }
        });

        let found = find_cursor_by_template_set(
            &search_frame,
            &[masked_template],
            &FindCursorOptions {
                min_score: Some(0.1),
                ..Default::default()
            },
        )
        .unwrap();
        assert!((found.position.x - 40.0).abs() <= 2.0);
        assert!((found.position.y - 30.0).abs() <= 2.0);
        assert!(found.score > 0.3);
    }
}
