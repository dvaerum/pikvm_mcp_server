//! Phase 258 (v0.5.218) — shape-based cursor detector.
//!
//! Faithful port of `src/pikvm/cursor-shape-detect.ts`.
//!
//! Architectural alternative to template-based (NCC) cursor detection.
//! Finds the cursor by SHAPE descriptors instead of pixel matching: dark
//! connected component, cursor-sized (~80px), asymmetric mass distribution,
//! centroid offset from bbox centre. No template required, no "stale
//! cache" failure mode.
//!
//! LEGACY (shape heuristic) — REFUTED as a primary detector; weak fallback
//! only. NOT an alternative to the cascade; see cursor-ml-detect.ts
//! findCursorByV8FullFrame.

use crate::cursor_detect::{find_clusters, merge_clusters, Point};

#[derive(Clone, Copy, Debug)]
pub struct ShapeCandidate {
    /// Centroid in HDMI pixels.
    pub centroid_x: i64,
    pub centroid_y: i64,
    /// Connected-component pixel count (after merge).
    pub pixels: usize,
    /// Heuristic shape score (higher = more cursor-like).
    pub shape_score: f64,
}

#[derive(Clone, Debug, Default)]
pub struct ShapeOptions {
    /// Hint where the cursor is expected to be — e.g.
    /// `client.belief.position`. Filters candidates to those within
    /// `expected_near_radius` of this point. None = no filter (returns
    /// highest-scoring candidate anywhere).
    pub expected_near: Option<Point>,
    /// Radius around `expected_near` in pixels. Default 200 — tight enough
    /// to filter out unrelated dark UI features while loose enough to
    /// admit the real cursor even if belief drifts.
    pub expected_near_radius: Option<f64>,
    /// Override the dark-pixel threshold (0-255). Pixels with grayscale
    /// brightness below this are candidate cursor mass. Default 100 —
    /// admits anti-aliased iPadOS arrow shadow while excluding most
    /// wallpapers (teal/blue ~150-200).
    pub dark_threshold: Option<u8>,
    /// Phase 293: BRIGHT-pixel threshold (0-255). When set, also run a
    /// second cluster-extraction pass with mask = brightness > this.
    /// Candidates from both passes are scored uniformly and compete
    /// against each other. None = dark-only (back-compat).
    pub bright_threshold: Option<u8>,
    /// Min cluster size in pixels. Default 15 — excludes JPEG noise.
    pub min_cluster_pixels: Option<usize>,
    /// Max cluster size in pixels. Default 250 — admits cursor with
    /// generous edge-tolerance.
    pub max_cluster_pixels: Option<usize>,
    /// Phase 313 (v0.5.236): minimum shape score for a candidate to be
    /// considered. Below this, the candidate is dropped from the pool.
    /// Default 0.10 — empirically separates real cursor detections
    /// (0.20-0.33) from cursor-absent fallback picks (0.077-0.078). Set 0
    /// to disable.
    pub min_shape_score: Option<f64>,
}

/// Compute the shape score for a candidate. Pure helper, exported for unit
/// tests.
///
/// Scoring components:
///   - size_fit: peaks at 80px (calibrated cursor size). Falls off as a
///     Gaussian; very small (15px) and very large (200+px) clusters score
///     low.
///   - asymmetry: max-quadrant mass / min-quadrant mass, capped at 5.0.
///   - centroid offset from bbox centre: capped at 10px.
///   - aspect-ratio penalty: log-distance from 1.0.
pub fn shape_score_for(
    pixels: usize,
    asymmetry: f64,
    centroid_offset: f64,
    bbox_aspect_ratio: f64,
) -> f64 {
    let aspect_penalty = (0.01f64.max(bbox_aspect_ratio)).ln().abs();
    let size_fit = (-((pixels as f64 - 80.0).powi(2)) / 600.0).exp();
    let capped_asym = asymmetry.min(5.0);
    let capped_offset = centroid_offset.min(10.0);
    size_fit * (1.0 + capped_asym / 3.0) * (1.0 + capped_offset / 5.0) * (-aspect_penalty).exp()
}

/// Find the top-K shape candidates without picking a single winner.
/// Returns up to `k` candidates (within the locality gate if
/// `expected_near` is set), sorted by shape score descending.
pub fn find_cursor_shape_candidates(
    rgb: &[u8],
    width: u32,
    height: u32,
    k: usize,
    options: &ShapeOptions,
) -> Vec<ShapeCandidate> {
    let mut all = find_all_shape_candidates(rgb, width, height, options);
    all.truncate(k);
    all
}

/// Find the cursor in a screenshot by shape, not by template matching.
/// Returns the highest-scoring shape candidate (within the locality gate,
/// if `expected_near` was supplied), or None if no candidate passes the
/// filters.
pub fn find_cursor_by_shape(
    rgb: &[u8],
    width: u32,
    height: u32,
    options: &ShapeOptions,
) -> Option<ShapeCandidate> {
    let sorted = find_all_shape_candidates(rgb, width, height, options);
    sorted.into_iter().next()
}

/// Internal: find ALL shape candidates, locality-filtered and sorted by
/// score descending. Pure / no-IO. Both public entry points use this.
fn find_all_shape_candidates(
    rgb: &[u8],
    width: u32,
    height: u32,
    options: &ShapeOptions,
) -> Vec<ShapeCandidate> {
    let dark_threshold = options.dark_threshold.unwrap_or(100);
    let bright_threshold = options.bright_threshold;
    let min_px = options.min_cluster_pixels.unwrap_or(15);
    let max_px = options.max_cluster_pixels.unwrap_or(250);
    let (w, h) = (width as usize, height as usize);

    let mut gray = vec![0u8; w * h];
    for (i, g) in gray.iter_mut().enumerate() {
        let o = i * 3;
        *g = (rgb[o] as f64 * 0.299 + rgb[o + 1] as f64 * 0.587 + rgb[o + 2] as f64 * 0.114).round()
            as u8;
    }

    // Phase 293: dual-pass cluster extraction. Dark mask catches the
    // classic dark cursor over light wallpaper; bright mask (when enabled)
    // catches the cursor when it renders LIGHT over medium wallpaper. The
    // two cluster sets are processed INDEPENDENTLY (separate merge_clusters
    // calls) so dark-mask and bright-mask clusters don't accidentally
    // merge into single objects with double-counted pixels.
    let dark_mask: Vec<bool> = gray.iter().map(|&g| g < dark_threshold).collect();
    let dark_clusters = find_clusters(&dark_mask, width, height, min_px, max_px, Some(rgb), true);
    let dark_merged = merge_clusters(dark_clusters, 8.0);

    let mut bright_merged = Vec::new();
    if let Some(bt) = bright_threshold {
        let bright_mask: Vec<bool> = gray.iter().map(|&g| g > bt).collect();
        let bright_clusters =
            find_clusters(&bright_mask, width, height, min_px, max_px, Some(rgb), true);
        bright_merged = merge_clusters(bright_clusters, 8.0);
    }
    let mut merged = dark_merged;
    merged.extend(bright_merged);

    // Phase 290 (v0.5.227): shape descriptors from each cluster's ACTUAL
    // member pixels + true bbox, not a fixed-radius rescan around the
    // centroid — a rescan saturates a thin cluster's bbox with unrelated
    // neighbouring dark pixels, hiding its true (discriminating) aspect
    // ratio.
    let mut candidates: Vec<ShapeCandidate> = Vec::new();
    for c in &merged {
        let bbox_w = c.bbox_max_x - c.bbox_min_x + 1;
        let bbox_h = c.bbox_max_y - c.bbox_min_y + 1;
        let aspect_ratio = bbox_w as f64 / (bbox_h as f64).max(1.0);
        let bbox_center_x = (c.bbox_min_x + c.bbox_max_x) as f64 / 2.0;
        let bbox_center_y = (c.bbox_min_y + c.bbox_max_y) as f64 / 2.0;
        let centroid_offset = ((c.centroid_x as f64 - bbox_center_x).powi(2)
            + (c.centroid_y as f64 - bbox_center_y).powi(2))
        .sqrt();

        let (mut q_nw, mut q_ne, mut q_sw, mut q_se) = (0i64, 0i64, 0i64, 0i64);
        if let Some(members) = &c.members {
            for &idx in members {
                let px = (idx % w) as i64;
                let py = ((idx - px as usize) / w) as i64;
                if px < c.centroid_x && py < c.centroid_y {
                    q_nw += 1;
                } else if px >= c.centroid_x && py < c.centroid_y {
                    q_ne += 1;
                } else if px < c.centroid_x && py >= c.centroid_y {
                    q_sw += 1;
                } else {
                    q_se += 1;
                }
            }
        }
        let mut quad_masses = [q_nw, q_ne, q_sw, q_se];
        quad_masses.sort_by(|a, b| b.cmp(a));
        let asymmetry = if quad_masses[3] == 0 {
            0.0
        } else {
            quad_masses[0] as f64 / (quad_masses[3] as f64).max(1.0)
        };

        // Chroma from the cluster's own mean_r/g/b (computed by
        // find_clusters over cluster members only — no neighbour
        // pollution).
        let mut chroma = 0.0;
        if let (Some(r), Some(g), Some(b)) = (c.mean_r, c.mean_g, c.mean_b) {
            chroma = r.max(g).max(b) - r.min(g).min(b);
        }
        let chroma_penalty = (-chroma / 40.0).exp();

        // Phase 308 (v0.5.234): bright-background penalty. Sample a
        // 16-point ring just outside the cluster's bbox; text on a white
        // widget card sits on near-white ring pixels, a cursor on
        // wallpaper sits on mid-brightness ring pixels.
        let ring_radius = (bbox_w.max(bbox_h) as f64) / 2.0 + 10.0;
        let mut ring_sum = 0i64;
        let mut ring_count = 0i64;
        for k in 0..16 {
            let angle = (k as f64 / 16.0) * std::f64::consts::PI * 2.0;
            let rx = (c.centroid_x as f64 + ring_radius * angle.cos()).round() as i64;
            let ry = (c.centroid_y as f64 + ring_radius * angle.sin()).round() as i64;
            if rx < 0 || rx >= width as i64 || ry < 0 || ry >= height as i64 {
                continue;
            }
            ring_sum += gray[(ry as usize) * w + (rx as usize)] as i64;
            ring_count += 1;
        }
        let ring_brightness = if ring_count == 0 {
            128.0
        } else {
            ring_sum as f64 / ring_count as f64
        };
        let bright_bg_penalty = (-(0f64.max(ring_brightness - 180.0)) / 20.0).exp();

        candidates.push(ShapeCandidate {
            centroid_x: c.centroid_x,
            centroid_y: c.centroid_y,
            pixels: c.pixels,
            shape_score: shape_score_for(c.pixels, asymmetry, centroid_offset, aspect_ratio)
                * chroma_penalty
                * bright_bg_penalty,
        });
    }

    // Phase 307 (v0.5.233): co-linearity penalty. Text characters come in
    // HORIZONTAL ROWS with REGULAR SPACING; a real cursor is isolated — no
    // similar-sized sibling clusters at the same vertical position.
    let mut co_linear_counts = vec![0i64; candidates.len()];
    for i in 0..candidates.len() {
        let c = candidates[i];
        for (j, o) in candidates.iter().enumerate() {
            if j == i {
                continue;
            }
            let dy = (o.centroid_y - c.centroid_y).abs();
            if dy > 15 {
                continue;
            }
            let dx = (o.centroid_x - c.centroid_x).abs();
            if !(30..=300).contains(&dx) {
                continue;
            }
            let ratio = if c.pixels == 0 {
                0.0
            } else {
                o.pixels as f64 / c.pixels as f64
            };
            if !(0.5..=2.0).contains(&ratio) {
                continue;
            }
            co_linear_counts[i] += 1;
        }
    }
    for (i, cand) in candidates.iter_mut().enumerate() {
        let penalty = (-(co_linear_counts[i] as f64) / 1.5).exp();
        cand.shape_score *= penalty;
    }

    // Phase 311 (v0.5.235): radial cluster-density penalty. Icon-internal
    // clusters (gear teeth, glyph strokes, dial marks) live in
    // high-cluster-density neighbourhoods; a real cursor on wallpaper is
    // isolated.
    let mut density_counts = vec![0i64; candidates.len()];
    for i in 0..candidates.len() {
        let c = candidates[i];
        for (j, o) in candidates.iter().enumerate() {
            if j == i {
                continue;
            }
            let dy = o.centroid_y - c.centroid_y;
            let dx = o.centroid_x - c.centroid_x;
            if dx * dx + dy * dy > 50 * 50 {
                continue;
            }
            let ratio = if c.pixels == 0 {
                0.0
            } else {
                o.pixels as f64 / c.pixels as f64
            };
            if !(0.3..=3.0).contains(&ratio) {
                continue;
            }
            density_counts[i] += 1;
        }
    }
    for (i, cand) in candidates.iter_mut().enumerate() {
        let penalty = (-(density_counts[i] as f64) / 2.0).exp();
        cand.shape_score *= penalty;
    }

    // Phase 313 (v0.5.236): minimum-score gate. Drop candidates below the
    // threshold BEFORE locality filtering.
    let min_shape_score = options.min_shape_score.unwrap_or(0.10);
    let mut pool: Vec<ShapeCandidate> = if min_shape_score > 0.0 {
        candidates
            .iter()
            .copied()
            .filter(|c| c.shape_score >= min_shape_score)
            .collect()
    } else {
        candidates.clone()
    };

    // Locality gate.
    //
    // NOTE (faithful port): the TS source filters from `candidates` here,
    // not from `pool` — when `expectedNear` is set, the min-score gate
    // above is silently discarded and only the locality filter applies.
    // This looks like an unintentional interaction (order-of-operations
    // bug) rather than a deliberate design choice, but per the port's
    // faithful-first discipline it is preserved byte-for-byte rather than
    // "fixed" here.
    if let Some(hint) = options.expected_near {
        let r = options.expected_near_radius.unwrap_or(200.0);
        let r2 = r * r;
        pool = candidates
            .iter()
            .copied()
            .filter(|c| {
                let dx = c.centroid_x as f64 - hint.x;
                let dy = c.centroid_y as f64 - hint.y;
                dx * dx + dy * dy <= r2
            })
            .collect();
    }

    pool.sort_by(|a, b| b.shape_score.partial_cmp(&a.shape_score).unwrap());
    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- shape_score_for --------------------------------------------------

    #[test]
    fn peaks_for_cursor_sized_asymmetric_off_centre_clusters() {
        let cursor_score = shape_score_for(80, 2.5, 5.0, 0.9);
        assert!(cursor_score > 0.8);
    }

    #[test]
    fn penalises_clusters_far_from_cursor_size() {
        let tiny = shape_score_for(15, 2.5, 5.0, 0.9);
        let huge = shape_score_for(250, 2.5, 5.0, 0.9);
        let cursor = shape_score_for(80, 2.5, 5.0, 0.9);
        assert!(tiny < cursor / 4.0);
        assert!(huge < cursor / 4.0);
    }

    #[test]
    fn caps_asymmetry_contribution_to_prevent_tiny_blob_runaway() {
        let noise = shape_score_for(15, 1000.0, 0.0, 1.0);
        let cursor = shape_score_for(80, 2.5, 5.0, 0.9);
        assert!(noise < cursor);
    }

    #[test]
    fn penalises_elongated_bboxes() {
        let square = shape_score_for(80, 2.5, 5.0, 1.0);
        let elongated = shape_score_for(80, 2.5, 5.0, 3.0);
        assert!(elongated < square / 2.0);
    }

    #[test]
    fn symmetric_blob_scores_low_even_at_perfect_size() {
        let symmetric = shape_score_for(80, 1.0, 0.0, 1.0);
        let cursorlike = shape_score_for(80, 2.5, 5.0, 1.0);
        assert!(symmetric < cursorlike);
    }

    // --- find_cursor_by_shape — synthetic frames --------------------------

    fn frame_with_cursor(cx: i64, cy: i64, radius: i64) -> Vec<u8> {
        let (w, h) = (200i64, 200i64);
        let mut rgb = vec![150u8; (w as usize) * (h as usize) * 3];
        for dy in 0..radius * 2 {
            let y = cy + dy;
            if y < 0 || y >= h {
                continue;
            }
            let line_width = (radius * 2 - dy).max(1);
            for dx in 0..line_width {
                let x = cx + dx;
                if x < 0 || x >= w {
                    continue;
                }
                let o = (y as usize * w as usize + x as usize) * 3;
                rgb[o] = 30;
                rgb[o + 1] = 30;
                rgb[o + 2] = 30;
            }
        }
        rgb
    }

    fn place_blob(rgb: &mut [u8], w: usize, cx: i64, cy: i64) {
        for dy in 0..12i64 {
            let line_w = (12 - dy).max(1);
            for dx in 0..line_w {
                let o = (((cy + dy) as usize) * w + ((cx + dx) as usize)) * 3;
                rgb[o] = 20;
                rgb[o + 1] = 20;
                rgb[o + 2] = 20;
            }
        }
    }

    #[test]
    fn finds_a_synthetic_dark_blob() {
        let rgb = frame_with_cursor(100, 100, 6);
        let r = find_cursor_by_shape(&rgb, 200, 200, &ShapeOptions::default());
        let r = r.unwrap();
        assert!((r.centroid_x - 100).abs() < 15);
        assert!((r.centroid_y - 100).abs() < 15);
    }

    #[test]
    fn returns_none_when_no_cluster_passes_the_dark_threshold() {
        let rgb = vec![150u8; 200 * 200 * 3];
        let r = find_cursor_by_shape(&rgb, 200, 200, &ShapeOptions::default());
        assert!(r.is_none());
    }

    #[test]
    fn locality_gate_rejects_when_no_candidate_falls_within_radius() {
        let rgb = frame_with_cursor(150, 150, 6);
        let opts = ShapeOptions {
            expected_near: Some(Point { x: 30.0, y: 30.0 }),
            expected_near_radius: Some(50.0),
            ..Default::default()
        };
        let r = find_cursor_by_shape(&rgb, 200, 200, &opts);
        assert!(r.is_none());
    }

    #[test]
    fn locality_gate_accepts_when_candidate_is_within_radius() {
        let rgb = frame_with_cursor(150, 150, 6);
        let opts = ShapeOptions {
            expected_near: Some(Point { x: 145.0, y: 145.0 }),
            expected_near_radius: Some(30.0),
            ..Default::default()
        };
        let r = find_cursor_by_shape(&rgb, 200, 200, &opts).unwrap();
        assert!((r.centroid_x - 150).abs() < 15);
    }

    #[test]
    fn cluster_bbox_aware_scoring_penalises_thin_elongated_strokes() {
        let (w, h) = (300usize, 300usize);
        let mut rgb = vec![150u8; w * h * 3];
        // Compact arrow at (80, 80): asymmetric triangle ~12x12 bbox.
        for dy in 0..12i64 {
            let ly = 80 + dy;
            let line_w = (12 - dy).max(1);
            for dx in 0..line_w {
                let o = ((ly as usize) * w + (80 + dx) as usize) * 3;
                rgb[o] = 20;
                rgb[o + 1] = 20;
                rgb[o + 2] = 20;
            }
        }
        // Thin stroke at (220, 100): 3x27 vertical bar.
        for dy in 0..27usize {
            for dx in 0..3usize {
                let o = ((100 + dy) * w + (220 + dx)) * 3;
                rgb[o] = 20;
                rgb[o + 1] = 20;
                rgb[o + 2] = 20;
            }
        }
        let compact = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 85.0, y: 85.0 }),
                expected_near_radius: Some(30.0),
                ..Default::default()
            },
        )
        .unwrap();
        let stroke = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 221.0, y: 115.0 }),
                expected_near_radius: Some(30.0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(compact.shape_score > stroke.shape_score * 2.0);
    }

    #[test]
    fn locality_gate_disambiguates_when_there_are_multiple_dark_blobs() {
        let (w, h) = (200usize, 200usize);
        let mut rgb = vec![150u8; w * h * 3];
        for dy in 0..12i64 {
            for dx in 0..12i64 {
                let o = (((50 + dy) as usize) * w + (50 + dx) as usize) * 3;
                rgb[o] = 30;
                rgb[o + 1] = 30;
                rgb[o + 2] = 30;
            }
        }
        for dy in 0..12i64 {
            for dx in 0..12i64 {
                let o = (((150 + dy) as usize) * w + (150 + dx) as usize) * 3;
                rgb[o] = 30;
                rgb[o + 1] = 30;
                rgb[o + 2] = 30;
            }
        }
        let ra = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 55.0, y: 55.0 }),
                expected_near_radius: Some(30.0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(ra.centroid_x < 75);
        assert!(ra.centroid_y < 75);

        let rb = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 155.0, y: 155.0 }),
                expected_near_radius: Some(30.0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(rb.centroid_x > 125);
        assert!(rb.centroid_y > 125);
    }

    #[test]
    fn penalises_a_candidate_with_3_colinear_similar_sized_siblings() {
        let (w, h) = (600usize, 200usize);
        let mut rgb = vec![150u8; w * h * 3];
        place_blob(&mut rgb, w, 100, 100);
        place_blob(&mut rgb, w, 170, 100);
        place_blob(&mut rgb, w, 240, 100);
        place_blob(&mut rgb, w, 310, 100);
        place_blob(&mut rgb, w, 500, 50);

        let text_cand = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 105.0, y: 105.0 }),
                expected_near_radius: Some(30.0),
                ..Default::default()
            },
        )
        .unwrap();
        let iso_cand = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 505.0, y: 55.0 }),
                expected_near_radius: Some(30.0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(iso_cand.shape_score > text_cand.shape_score * 3.0);
    }

    #[test]
    fn does_not_penalise_isolated_cursors() {
        let (w, h) = (200usize, 200usize);
        let mut rgb = vec![150u8; w * h * 3];
        place_blob(&mut rgb, w, 100, 100);
        let r = find_cursor_by_shape(&rgb, w as u32, h as u32, &ShapeOptions::default()).unwrap();
        assert!(r.shape_score > 0.8);
    }

    #[test]
    fn does_not_penalise_vertically_stacked_candidates() {
        let (w, h) = (200usize, 600usize);
        let mut rgb = vec![150u8; w * h * 3];
        place_blob(&mut rgb, w, 100, 100);
        place_blob(&mut rgb, w, 100, 200);
        place_blob(&mut rgb, w, 100, 300);
        place_blob(&mut rgb, w, 100, 400);
        let r = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 100.0, y: 100.0 }),
                expected_near_radius: Some(20.0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(r.shape_score > 0.8);
    }

    #[test]
    fn penalises_candidates_in_dark_cluster_dense_regions() {
        let (w, h) = (400usize, 400usize);
        let mut rgb = vec![150u8; w * h * 3];
        for row in 0..3i64 {
            for col in 0..4i64 {
                place_blob(&mut rgb, w, 60 + col * 18, 60 + row * 18);
            }
        }
        place_blob(&mut rgb, w, 300, 300);

        let dense_cand = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 78.0, y: 78.0 }),
                expected_near_radius: Some(30.0),
                ..Default::default()
            },
        )
        .unwrap();
        let iso_cand = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 305.0, y: 305.0 }),
                expected_near_radius: Some(30.0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(iso_cand.shape_score > dense_cand.shape_score * 3.0);
    }

    #[test]
    fn minimum_score_gate_returns_none_when_no_candidate_clears_threshold() {
        let (w, h) = (200usize, 200usize);
        let mut rgb = vec![150u8; w * h * 3];
        for row in 0..3i64 {
            for col in 0..4i64 {
                place_blob(&mut rgb, w, 30 + col * 18, 30 + row * 18);
            }
        }
        assert!(find_cursor_by_shape(&rgb, w as u32, h as u32, &ShapeOptions::default()).is_none());
        let opts = ShapeOptions {
            min_shape_score: Some(0.0),
            ..Default::default()
        };
        assert!(find_cursor_by_shape(&rgb, w as u32, h as u32, &opts).is_some());
    }

    #[test]
    fn isolated_cursor_passes_the_default_min_score_threshold() {
        let (w, h) = (200usize, 200usize);
        let mut rgb = vec![150u8; w * h * 3];
        place_blob(&mut rgb, w, 100, 100);
        let r = find_cursor_by_shape(&rgb, w as u32, h as u32, &ShapeOptions::default()).unwrap();
        assert!(r.shape_score > 0.10);
    }

    #[test]
    fn does_not_penalise_widely_spaced_colinear_candidates() {
        let (w, h) = (800usize, 200usize);
        let mut rgb = vec![150u8; w * h * 3];
        place_blob(&mut rgb, w, 100, 100);
        place_blob(&mut rgb, w, 600, 100); // 500px away — out of 30-300 range
        let r = find_cursor_by_shape(
            &rgb,
            w as u32,
            h as u32,
            &ShapeOptions {
                expected_near: Some(Point { x: 105.0, y: 105.0 }),
                expected_near_radius: Some(20.0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(r.shape_score > 0.8);
    }

    #[test]
    fn find_cursor_shape_candidates_returns_up_to_k_sorted_by_score() {
        let rgb = frame_with_cursor(100, 100, 6);
        let candidates = find_cursor_shape_candidates(&rgb, 200, 200, 5, &ShapeOptions::default());
        assert!(!candidates.is_empty());
        assert!(candidates.len() <= 5);
        for pair in candidates.windows(2) {
            assert!(pair[0].shape_score >= pair[1].shape_score);
        }
    }
}
