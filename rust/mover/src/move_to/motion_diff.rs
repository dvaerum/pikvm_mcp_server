//! Motion diff — find a cursor pair whose displacement matches a
//! commanded move, anchored by a known starting neighbourhood and a
//! predicted landing. The ~270-line cluster-pairing core of the legacy
//! correction loop; pure given decoded frames, independently testable.
//!
//! Faithful port of `detectMotion` (`src/pikvm/move-to.ts` lines
//! 1018-1285). Maps to `move-to.detectMotion.test.ts` (26 cases across
//! this function and `correction_math`'s helpers).

use pikvm_mcp_detection_vision::cursor_detect::{
    diff_screenshots_decoded, find_cursor_by_template_set, Cluster, CursorTemplate,
    DecodedScreenshot, DetectionConfig, FindCursorOptions, Point, DEFAULT_DETECTION_CONFIG,
};

/// Faithful port of `MotionPair`.
#[derive(Debug, Clone)]
pub struct MotionPair {
    pub pre: Cluster,
    pub post: Cluster,
    pub displacement: (f64, f64),
    pub live_px_per_mickey: f64,
}

/// Return shape for `detect_motion`. On success carries the pair; on
/// failure carries a structured reason so callers can surface it in
/// diagnostics rather than silently trusting prediction. Faithful port
/// of `MotionDiffResult`.
#[derive(Debug, Clone)]
pub struct MotionDiffResult {
    pub pair: Option<MotionPair>,
    /// Compact human-readable failure reason; `None` on success.
    pub reason: Option<String>,
    /// Cluster bookkeeping for diagnostics.
    pub raw_clusters: usize,
    pub sized_clusters: usize,
    pub pre_candidates: usize,
    pub post_candidates: usize,
}

fn dist(cx: f64, cy: f64, px: f64, py: f64) -> f64 {
    (cx - px).hypot(cy - py)
}

/// Faithful port of `detectMotion`.
///
/// `require_achromatic` (Phase 1): when true, sized clusters whose mean
/// RGB has a saturation > 40 are rejected before pair scoring — the
/// cursor is gray (R≈G≈B); colored animated widgets produce chromatic
/// clusters this filter removes. `templates` (Phase 2/3): when
/// non-empty, every valid candidate pair has its post-cluster region
/// scored against the WHOLE template set; the combined geometric +
/// template score re-ranks pair selection.
///
/// Deviates from the TS source in ONE way: returns `anyhow::Result`
/// rather than throwing synchronously. `diffScreenshotsDecoded`'s TS
/// counterpart is a throwing sync call this function does not itself
/// guard with a try/catch — an uncaught exception (e.g. a genuine
/// dimension mismatch between the two frames, which never happens for a
/// real caller since both frames come from the same streamer resolution)
/// propagates straight out of `detectMotion` to ITS caller. `Result` is
/// the idiomatic Rust equivalent of "doesn't catch its own callee's
/// throw" — same propagation, no behavior change for any real input.
#[allow(clippy::too_many_arguments)]
pub fn detect_motion(
    a: &DecodedScreenshot,
    b: &DecodedScreenshot,
    expected_start: (f64, f64),
    expected_end: (f64, f64),
    commanded_mickeys: (f64, f64),
    pre_window: f64,
    post_window: f64,
    verbose: bool,
    cluster_min: usize,
    cluster_max: usize,
    brightness_floor: i32,
    require_achromatic: bool,
    templates: &[CursorTemplate],
) -> anyhow::Result<MotionDiffResult> {
    // brightnessFloor lowered from 170 -> 100 upstream (Phase 193-A):
    // cursor pixels rendered over a dimmed-modal scrim or a dark
    // wallpaper land in the 100-160 range; a 170 floor rejected them
    // entirely.
    let config = DetectionConfig {
        brightness_floor,
        merge_radius: 18.0,
        ..DEFAULT_DETECTION_CONFIG
    };
    let clusters = diff_screenshots_decoded(a, b, &config)?;

    // Cursor is typically 15-50 px steady, can blur to ~70 px during
    // fast bursts. Tighten this range to reject iPadOS pointer-effect
    // highlights on icons (100+ px) and widget animations (variable).
    let sized: Vec<&Cluster> = clusters
        .iter()
        .filter(|c| c.pixels >= cluster_min && c.pixels <= cluster_max)
        .collect();

    let pre_candidates_window: Vec<&Cluster> = sized
        .iter()
        .copied()
        .filter(|c| {
            dist(
                c.centroid_x as f64,
                c.centroid_y as f64,
                expected_start.0,
                expected_start.1,
            ) <= pre_window
        })
        .collect();
    let mut post_candidates: Vec<&Cluster> = sized
        .iter()
        .copied()
        .filter(|c| {
            dist(
                c.centroid_x as f64,
                c.centroid_y as f64,
                expected_end.0,
                expected_end.1,
            ) <= post_window
        })
        .collect();

    // Phase 1: optional cluster-level achromatic filter applied to POST
    // candidates only. The post-cluster's mean colour comes from frame B
    // at cursor pixels — gray for the cursor, chromatic for a colored
    // widget animation. The PRE cluster's mean is whatever was underneath
    // (often the wallpaper, possibly chromatic), so filtering pre would
    // reject real cursors over colored wallpapers.
    if require_achromatic {
        let before = post_candidates.len();
        post_candidates.retain(|c| match (c.mean_r, c.mean_g, c.mean_b) {
            (Some(r), Some(g), Some(b)) => {
                let sat = r.max(g).max(b) - r.min(g).min(b);
                sat <= 40.0
            }
            _ => true, // no color info -> don't filter
        });
        if verbose {
            eprintln!(
                "[motion] achromatic filter: {before} post-candidates → {} achromatic",
                post_candidates.len()
            );
        }
    }

    // Fallback: if the windowed pre-search came up empty but we have
    // multiple sized clusters, the cursor probably wasn't where we
    // expected (slam mis-anchored, prior trial drifted, modal trapping,
    // etc.). Open the pre-pool to ALL sized clusters; the direction +
    // magnitude validation downstream still keeps bad pairs out.
    let mut pre_candidates = pre_candidates_window;
    let mut pre_window_expanded = false;
    if pre_candidates.is_empty() && sized.len() >= 2 {
        pre_candidates = sized.clone();
        pre_window_expanded = true;
    }

    // Phase 29 follow-up: symmetric fallback for post. iPadOS
    // pointer-acceleration amplification means the actual landing can be
    // 600+ px from the predicted end position. Same downstream sanity
    // (direction + magnitude) keeps bad pairs out.
    let mut post_window_expanded = false;
    if post_candidates.is_empty() && !sized.is_empty() {
        post_candidates = sized.clone();
        post_window_expanded = true;
    }

    if verbose {
        eprintln!(
            "[motion] {} total, {} cursor-sized [{cluster_min}-{cluster_max}px]; pre-cands(window={pre_window}@{},{})={}{}, \
             post-cands(window={post_window}@{},{})={}{}",
            clusters.len(),
            sized.len(),
            expected_start.0.round(),
            expected_start.1.round(),
            pre_candidates.len(),
            if pre_window_expanded {
                format!(" →expanded to {} (no pre in window)", pre_candidates.len())
            } else {
                String::new()
            },
            expected_end.0.round(),
            expected_end.1.round(),
            post_candidates.len(),
            if post_window_expanded {
                format!(" →expanded to {} (no post in window)", post_candidates.len())
            } else {
                String::new()
            },
        );
    }

    let result = |pair: Option<MotionPair>, reason: Option<String>| MotionDiffResult {
        pair,
        reason,
        raw_clusters: clusters.len(),
        sized_clusters: sized.len(),
        pre_candidates: pre_candidates.len(),
        post_candidates: post_candidates.len(),
    };

    if sized.is_empty() {
        return Ok(result(
            None,
            Some(format!(
                "no clusters in {cluster_min}-{cluster_max}px size range (raw={})",
                clusters.len()
            )),
        ));
    }
    if pre_candidates.is_empty() && post_candidates.is_empty() {
        return Ok(result(
            None,
            Some("no pre or post candidates within search windows".to_string()),
        ));
    }
    if pre_candidates.is_empty() {
        return Ok(result(
            None,
            Some(format!(
                "no pre candidate within {pre_window}px of expected start (and only {} sized cluster total)",
                sized.len()
            )),
        ));
    }
    if post_candidates.is_empty() {
        return Ok(result(
            None,
            Some(format!(
                "no post candidate within {post_window}px of expected end"
            )),
        ));
    }

    // Commanded direction in px (approximate — magnitude is approximate
    // because we haven't measured the actual ratio yet; direction only
    // is used for pair validation).
    let expected_dx = expected_end.0 - expected_start.0;
    let expected_dy = expected_end.1 - expected_start.1;
    let expected_dist = expected_dx.hypot(expected_dy);
    let unit = if expected_dist > 0.0 {
        (expected_dx / expected_dist, expected_dy / expected_dist)
    } else {
        (1.0, 0.0)
    };

    let max_mickeys = commanded_mickeys.0.abs().max(commanded_mickeys.1.abs());

    // Phase 2: collect ALL valid pairs (don't early-bind to best). The
    // template-validation pass below re-ranks them when a template is
    // available; without a template we still pick by max geometric
    // score.
    struct Candidate<'c> {
        pre: &'c Cluster,
        post: &'c Cluster,
        displacement: (f64, f64),
        live_px_per_mickey: f64,
        geom_score: f64,
        template_score: f64,
    }
    let mut valid_pairs: Vec<Candidate> = Vec::new();
    for &pre in &pre_candidates {
        for &post in &post_candidates {
            if std::ptr::eq(pre, post) {
                continue;
            }
            let disp_x = (post.centroid_x - pre.centroid_x) as f64;
            let disp_y = (post.centroid_y - pre.centroid_y) as f64;
            let disp_mag = disp_x.hypot(disp_y);
            if disp_mag < 10.0 {
                continue; // too short — probably the same cluster or noise
            }

            // Direction must roughly match commanded (dot product along unit).
            let along = disp_x * unit.0 + disp_y * unit.1;
            if along <= 0.0 {
                continue;
            }
            // Reject pairs whose direction diverges > 45° from commanded.
            if along / disp_mag < 0.7 {
                continue;
            }

            let live_px_per_mickey = if max_mickeys > 0.0 {
                disp_mag / max_mickeys
            } else {
                1.0
            };
            // Sanity: ratio must be in [0.3, 6] (Phase 21 bump from 4 —
            // live ballistics measurement showed iPad context ratios up
            // to 4.3 X / 5+ Y).
            if !(0.3..=6.0).contains(&live_px_per_mickey) {
                continue;
            }

            // Score: prefer pairs whose post is close to expectedEnd AND
            // pre is close to expectedStart, with similar sizes.
            let size_ratio =
                pre.pixels.max(post.pixels) as f64 / (pre.pixels.min(post.pixels) as f64).max(1.0);
            if size_ratio > 4.0 {
                continue;
            }

            let geom_score = -dist(
                post.centroid_x as f64,
                post.centroid_y as f64,
                expected_end.0,
                expected_end.1,
            ) - dist(
                pre.centroid_x as f64,
                pre.centroid_y as f64,
                expected_start.0,
                expected_start.1,
            ) - 30.0 * size_ratio.log2();
            valid_pairs.push(Candidate {
                pre,
                post,
                displacement: (disp_x, disp_y),
                live_px_per_mickey,
                geom_score,
                template_score: 0.0,
            });
        }
    }

    // Phase 2 + 3: when at least one template is cached, score each
    // candidate's post-cluster region against the WHOLE template set.
    if !templates.is_empty() && !valid_pairs.is_empty() {
        for cand in &mut valid_pairs {
            let tm = find_cursor_by_template_set(
                b,
                templates,
                &FindCursorOptions {
                    search_centre: Some(Point {
                        x: cand.post.centroid_x as f64,
                        y: cand.post.centroid_y as f64,
                    }),
                    search_window: Some(30.0),
                    min_score: Some(0.0), // accept anything; used for ranking
                    step: Some(2),
                    ..Default::default()
                },
            );
            cand.template_score = tm.map(|m| m.score).unwrap_or(0.0);
        }
    }

    // Combined ranking: geometric score plus 100×templateScore. Template
    // score in [0,1] dominates the geometric (typically [-300, 0] for
    // close-to-expected pairs) when present.
    let mut best: Option<(usize, f64)> = None; // (index into valid_pairs, total score)
    for (i, cand) in valid_pairs.iter().enumerate() {
        let total = cand.geom_score + cand.template_score * 100.0;
        if best.is_none_or(|(_, best_score)| total > best_score) {
            best = Some((i, total));
        }
    }

    if let Some((i, _)) = best {
        let cand = &valid_pairs[i];
        if verbose {
            let tmpl_part = if !templates.is_empty() {
                format!(" template={:.3}", cand.template_score)
            } else {
                String::new()
            };
            eprintln!(
                "[motion] picked pre=({},{},{}px) post=({},{},{}px) disp=({},{}) ratio={:.3}{tmpl_part}",
                cand.pre.centroid_x,
                cand.pre.centroid_y,
                cand.pre.pixels,
                cand.post.centroid_x,
                cand.post.centroid_y,
                cand.post.pixels,
                cand.displacement.0,
                cand.displacement.1,
                cand.live_px_per_mickey,
            );
        }
        return Ok(result(
            Some(MotionPair {
                pre: cand.pre.clone(),
                post: cand.post.clone(),
                displacement: cand.displacement,
                live_px_per_mickey: cand.live_px_per_mickey,
            }),
            None,
        ));
    }
    Ok(result(
        None,
        Some(format!(
            "{}×{} cands considered, no pair passed direction/sanity filters",
            pre_candidates.len(),
            post_candidates.len()
        )),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_detection_vision::cursor_detect::extract_cursor_template_decoded;

    fn make_frame(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
        for i in 0..(w as usize) * (h as usize) {
            buf[i * 3] = fill[0];
            buf[i * 3 + 1] = fill[1];
            buf[i * 3 + 2] = fill[2];
        }
        buf
    }

    fn stamp(base: &mut [u8], w: u32, h: u32, cx: i64, cy: i64, size: i64, colour: [u8; 3]) {
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
                base[i] = colour[0];
                base[i + 1] = colour[1];
                base[i + 2] = colour[2];
            }
        }
    }

    fn encode(w: u32, h: u32, rgb: &[u8]) -> DecodedScreenshot {
        // The real TS tests round-trip through PNG (lossless) so exact
        // pixel values survive; JPEG's lossy quantization would blur the
        // small stamped squares enough to shift cluster boundaries. This
        // port skips the encode/decode round trip entirely (no `image`
        // crate PNG dependency needed) — `decode_screenshot` only needs a
        // real `DecodedScreenshot`, and building one directly from the
        // already-known-correct RGB buffer is behaviourally identical to
        // decoding a lossless PNG of the same pixels, without pulling in
        // an extra codec just for test fixtures.
        DecodedScreenshot {
            buffer: Vec::new(),
            rgb: rgb.to_vec(),
            width: w,
            height: h,
        }
    }

    // Cursor moves from (50, 50) to (150, 80). expectedStart matches.
    #[test]
    fn finds_a_pair_when_both_pre_and_post_clusters_fall_within_their_windows() {
        let (w, h) = (300, 200);
        let wallpaper = [200, 200, 200];
        let cursor = [240, 240, 240];
        let mut a_buf = make_frame(w, h, wallpaper);
        stamp(&mut a_buf, w, h, 50, 50, 7, cursor);
        let mut b_buf = make_frame(w, h, wallpaper);
        stamp(&mut b_buf, w, h, 150, 80, 7, cursor);
        let a = encode(w, h, &a_buf);
        let b = encode(w, h, &b_buf);

        let r = detect_motion(
            &a,
            &b,
            (50.0, 50.0),
            (150.0, 80.0),
            (100.0, 30.0),
            120.0,
            600.0,
            false,
            8,
            90,
            170,
            false,
            &[],
        )
        .unwrap();
        assert!(r.pair.is_some());
        assert!(r.reason.is_none());
        assert!(r.pre_candidates >= 1);
        assert!(r.post_candidates >= 1);
    }

    // REGRESSION: cursor actually moved (50,50)->(150,80) but our
    // expectedStart guess was wildly wrong. Without the fallback,
    // motion-diff returns null even though the diff has both clusters.
    #[test]
    fn regression_recovers_pair_when_expected_start_is_wrong_but_at_least_2_sized_clusters_exist() {
        let (w, h) = (400, 300);
        let wallpaper = [200, 200, 200];
        let cursor = [240, 240, 240];
        let mut a_buf = make_frame(w, h, wallpaper);
        stamp(&mut a_buf, w, h, 50, 50, 7, cursor);
        let mut b_buf = make_frame(w, h, wallpaper);
        stamp(&mut b_buf, w, h, 150, 80, 7, cursor);
        let a = encode(w, h, &a_buf);
        let b = encode(w, h, &b_buf);

        let r = detect_motion(
            &a,
            &b,
            (350.0, 250.0), // WRONG
            (150.0, 80.0),
            (100.0, 30.0),
            120.0,
            600.0,
            false,
            8,
            90,
            170,
            false,
            &[],
        )
        .unwrap();
        assert!(r.pair.is_some());
        assert!(r.pre_candidates >= 2);
    }

    #[test]
    fn regression_phase1_require_achromatic_accepts_gray_cursor_pair_on_colored_background() {
        let (w, h) = (400, 300);
        let wallpaper = [180, 100, 60]; // orange
        let cursor = [240, 240, 240];
        let mut a_buf = make_frame(w, h, wallpaper);
        stamp(&mut a_buf, w, h, 50, 50, 7, cursor);
        let mut b_buf = make_frame(w, h, wallpaper);
        stamp(&mut b_buf, w, h, 150, 80, 7, cursor);
        let a = encode(w, h, &a_buf);
        let b = encode(w, h, &b_buf);

        let r = detect_motion(
            &a,
            &b,
            (50.0, 50.0),
            (150.0, 80.0),
            (100.0, 30.0),
            120.0,
            600.0,
            false,
            8,
            90,
            0, // brightnessFloor disabled
            true,
            &[],
        )
        .unwrap();
        assert!(r.pair.is_some());
    }

    #[test]
    fn phase1_require_achromatic_rejects_a_single_colored_widget_pair() {
        let (w, h) = (400, 300);
        let wallpaper = [200, 200, 200];
        let orange = [240, 80, 40];
        let mut a_buf = make_frame(w, h, wallpaper);
        stamp(&mut a_buf, w, h, 60, 60, 7, orange);
        let mut b_buf = make_frame(w, h, wallpaper);
        stamp(&mut b_buf, w, h, 160, 90, 7, orange);
        let a = encode(w, h, &a_buf);
        let b = encode(w, h, &b_buf);

        let baseline = detect_motion(
            &a,
            &b,
            (60.0, 60.0),
            (160.0, 90.0),
            (100.0, 30.0),
            120.0,
            600.0,
            false,
            8,
            90,
            0,
            false,
            &[],
        )
        .unwrap();
        assert!(baseline.pair.is_some());

        let filtered = detect_motion(
            &a,
            &b,
            (60.0, 60.0),
            (160.0, 90.0),
            (100.0, 30.0),
            120.0,
            600.0,
            false,
            8,
            90,
            0,
            true,
            &[],
        )
        .unwrap();
        assert!(filtered.pair.is_none());
    }

    #[test]
    fn phase2_template_re_ranks_pair_selection_when_geometry_is_ambiguous() {
        let (w, h) = (400, 250);
        let wallpaper = [200, 200, 200];
        let cursor = [240, 240, 240];
        let orange = [240, 80, 40];

        let mut a_buf = make_frame(w, h, wallpaper);
        stamp(&mut a_buf, w, h, 50, 50, 7, orange);
        stamp(&mut a_buf, w, h, 60, 100, 7, cursor);
        let mut b_buf = make_frame(w, h, wallpaper);
        stamp(&mut b_buf, w, h, 150, 80, 7, orange);
        stamp(&mut b_buf, w, h, 160, 130, 7, cursor);
        let a = encode(w, h, &a_buf);
        let b = encode(w, h, &b_buf);

        let template = extract_cursor_template_decoded(&b, Point { x: 160.0, y: 130.0 }, 24);

        let baseline = detect_motion(
            &a,
            &b,
            (50.0, 50.0),
            (150.0, 80.0),
            (100.0, 30.0),
            120.0,
            600.0,
            false,
            8,
            90,
            0,
            false,
            &[],
        )
        .unwrap();
        let pair = baseline.pair.unwrap();
        assert!((pair.post.centroid_x as f64 - 150.0).abs() < 10.0);
        assert!((pair.post.centroid_y as f64 - 80.0).abs() < 10.0);

        let with_template = detect_motion(
            &a,
            &b,
            (50.0, 50.0),
            (150.0, 80.0),
            (100.0, 30.0),
            120.0,
            600.0,
            false,
            8,
            90,
            0,
            false,
            &[template],
        )
        .unwrap();
        let pair = with_template.pair.unwrap();
        assert!((pair.post.centroid_y as f64 - 130.0).abs() < 10.0);
    }

    #[test]
    fn returns_none_when_commanded_direction_is_perpendicular_to_actual_cluster_pair() {
        let (w, h) = (400, 300);
        let wallpaper = [200, 200, 200];
        let cursor = [240, 240, 240];
        let mut a_buf = make_frame(w, h, wallpaper);
        stamp(&mut a_buf, w, h, 50, 50, 7, cursor);
        let mut b_buf = make_frame(w, h, wallpaper);
        stamp(&mut b_buf, w, h, 150, 80, 7, cursor);
        let a = encode(w, h, &a_buf);
        let b = encode(w, h, &b_buf);

        let r = detect_motion(
            &a,
            &b,
            (350.0, 250.0),
            (350.0, 200.0),
            (0.0, -50.0),
            120.0,
            600.0,
            false,
            8,
            90,
            170,
            false,
            &[],
        )
        .unwrap();
        assert!(r.pair.is_none());
        let reason = r.reason.unwrap().to_lowercase();
        assert!(
            reason.contains("no pair passed")
                || reason.contains("no post candidate")
                || reason.contains("no pre candidate")
        );
    }
}
