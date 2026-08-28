//! Template-based cursor matching: capture a cursor template from a
//! screenshot, correlate it against a frame to find the cursor's
//! position, and track it across a maintained template set.
//!
//! Split out of `cursor_detect.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use super::diff::{decode_screenshot, DecodedScreenshot, Point};

// ============================================================================
// Template matching — fallback cursor detection that doesn't rely on motion.
// ============================================================================

/// A cursor template captured from a screenshot at a known cursor position.
/// Stored as raw RGB pixels with explicit dimensions so match doesn't pay
/// the decode cost per call.
#[derive(Clone)]
pub struct CursorTemplate {
    /// Raw RGB pixel data, length = width * height * 3.
    pub rgb: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Optional hotspot offset (within the template's coordinate space) of
    /// the cursor's clickable point. For an iPadOS arrow cursor, this is
    /// the arrow TIP — near the upper-left of the template, NOT the
    /// bounding-box centre. When absent, callers fall back to bbox centre.
    pub hotspot: Option<Point>,
}

/// Locate the cursor's clickable hotspot within a captured cursor template.
///
/// The iPadOS cursor over wallpaper / non-interactive content is a small
/// upper-left-pointing arrow with the bright TIP at the top of the visible
/// shape. The bounding-box centre sits in the dark region below-and-right
/// of the tip — typically 8-12px away from where iPadOS actually registers
/// the click.
///
/// Algorithm: find pixels brighter than the template's mean luminance plus
/// a margin, then return the topmost (smallest y) bright pixel — averaged
/// over equally-topmost pixels to be robust against JPEG noise. Returns
/// bbox-centre as a safe fallback for a uniform/low-contrast template.
///
/// Pure: deterministic, no I/O.
pub fn compute_template_hotspot(template: &CursorTemplate) -> Point {
    let (width, height, rgb) = (template.width, template.height, &template.rgb);
    let n = (width as usize) * (height as usize);

    let mut sum = 0f64;
    let mut max = 0f64;
    for i in 0..n {
        let o = i * 3;
        let lum = (rgb[o] as f64 + rgb[o + 1] as f64 + rgb[o + 2] as f64) / 3.0;
        sum += lum;
        if lum > max {
            max = lum;
        }
    }
    let mean = sum / n as f64;
    // Adaptive threshold: pixels within 30% of peak luminance, but also at
    // least 20 above mean. iPadOS soft cursors peak around 100-130
    // luminance — a fixed threshold misses the cursor entirely and picks
    // up isolated noise instead.
    let threshold = (mean + 20.0).max(mean + (max - mean) * 0.7);

    let fallback = Point {
        x: (width / 2) as f64,
        y: (height / 2) as f64,
    };

    if max - mean < 30.0 {
        return fallback; // very low contrast -> no clear cursor
    }

    let mut min_y: i64 = -1;
    let mut same_y_x_sum = 0f64;
    let mut same_y_x_count = 0f64;
    for y in 0..height {
        for x in 0..width {
            let o = ((y * width + x) as usize) * 3;
            let lum = (rgb[o] as f64 + rgb[o + 1] as f64 + rgb[o + 2] as f64) / 3.0;
            if lum < threshold {
                continue;
            }
            if min_y == -1 || (y as i64) < min_y {
                min_y = y as i64;
                same_y_x_sum = x as f64;
                same_y_x_count = 1.0;
            } else if y as i64 == min_y {
                same_y_x_sum += x as f64;
                same_y_x_count += 1.0;
            }
        }
    }

    if min_y == -1 {
        return fallback;
    }
    Point {
        x: (same_y_x_sum / same_y_x_count).round(),
        y: min_y as f64,
    }
}

/// Crop a square region from a pre-decoded screenshot centred on a known
/// cursor position and return it as a `CursorTemplate`.
pub fn extract_cursor_template_decoded(
    screenshot: &DecodedScreenshot,
    centre: Point,
    size: u32,
) -> CursorTemplate {
    let half = (size / 2) as f64;
    let left = 0f64
        .max((screenshot.width as f64 - size as f64).min(centre.x - half))
        .round() as u32;
    let top = 0f64
        .max((screenshot.height as f64 - size as f64).min(centre.y - half))
        .round() as u32;

    let mut out = vec![0u8; (size as usize) * (size as usize) * 3];
    for y in 0..size {
        let src_offset = (((top + y) * screenshot.width + left) as usize) * 3;
        let dst_offset = (y as usize) * (size as usize) * 3;
        let row_len = (size as usize) * 3;
        out[dst_offset..dst_offset + row_len]
            .copy_from_slice(&screenshot.rgb[src_offset..src_offset + row_len]);
    }
    let mut tpl = CursorTemplate {
        rgb: out,
        width: size,
        height: size,
        hotspot: None,
    };
    tpl.hotspot = Some(compute_template_hotspot(&tpl));
    tpl
}

/// Convenience wrapper for callers that only have the JPEG buffer.
pub fn extract_cursor_template(
    screenshot: &[u8],
    centre: Point,
    size: u32,
) -> anyhow::Result<CursorTemplate> {
    let decoded = decode_screenshot(screenshot)?;
    Ok(extract_cursor_template_decoded(&decoded, centre, size))
}

/// Pre-computed sums used by normalised cross-correlation; computed once
/// per template so repeated matching is fast.
struct TemplateStats<'a> {
    template: &'a CursorTemplate,
    mean: [f64; 3],
    /// sum of (px - mean)^2 across all template pixels and channels.
    variance_sum: f64,
}

fn compute_template_stats(t: &CursorTemplate) -> TemplateStats<'_> {
    let n = (t.width as usize) * (t.height as usize);
    let (mut sum_r, mut sum_g, mut sum_b) = (0f64, 0f64, 0f64);
    for i in 0..n {
        let o = i * 3;
        sum_r += t.rgb[o] as f64;
        sum_g += t.rgb[o + 1] as f64;
        sum_b += t.rgb[o + 2] as f64;
    }
    let mean = [sum_r / n as f64, sum_g / n as f64, sum_b / n as f64];
    let mut variance_sum = 0f64;
    for i in 0..n {
        let o = i * 3;
        let dr = t.rgb[o] as f64 - mean[0];
        let dg = t.rgb[o + 1] as f64 - mean[1];
        let db = t.rgb[o + 2] as f64 - mean[2];
        variance_sum += dr * dr + dg * dg + db * db;
    }
    TemplateStats {
        template: t,
        mean,
        variance_sum,
    }
}

/// Normalised cross-correlation between a template and a region of the
/// screenshot. Returns a value in [-1, 1]; 1 = identical, 0 = uncorrelated.
///
/// Resilient to per-channel brightness offsets (e.g. cursor over a darker
/// vs lighter wallpaper area), because the mean of each region is
/// subtracted before correlation.
fn correlate_at(
    screen: &[u8],
    screen_width: u32,
    region: &TemplateStats,
    top_left_x: i64,
    top_left_y: i64,
) -> f64 {
    let t = region.template;
    let n = (t.width as usize) * (t.height as usize);
    let (mut sum_r, mut sum_g, mut sum_b) = (0f64, 0f64, 0f64);
    for y in 0..t.height as i64 {
        let screen_row = (((top_left_y + y) * screen_width as i64 + top_left_x) * 3) as usize;
        for x in 0..t.width as usize {
            let o = screen_row + x * 3;
            sum_r += screen[o] as f64;
            sum_g += screen[o + 1] as f64;
            sum_b += screen[o + 2] as f64;
        }
    }
    let mean_r = sum_r / n as f64;
    let mean_g = sum_g / n as f64;
    let mean_b = sum_b / n as f64;

    let mut dot = 0f64;
    let mut region_variance = 0f64;
    for y in 0..t.height as i64 {
        let screen_row = (((top_left_y + y) * screen_width as i64 + top_left_x) * 3) as usize;
        let t_row = (y as usize) * (t.width as usize) * 3;
        for x in 0..t.width as usize {
            let so = screen_row + x * 3;
            let to = t_row + x * 3;
            let sr = screen[so] as f64 - mean_r;
            let sg = screen[so + 1] as f64 - mean_g;
            let sb = screen[so + 2] as f64 - mean_b;
            let tr = t.rgb[to] as f64 - region.mean[0];
            let tg = t.rgb[to + 1] as f64 - region.mean[1];
            let tb = t.rgb[to + 2] as f64 - region.mean[2];
            dot += sr * tr + sg * tg + sb * tb;
            region_variance += sr * sr + sg * sg + sb * sb;
        }
    }
    let denom = (region_variance * region.variance_sum).sqrt();
    if denom == 0.0 {
        return 0.0;
    }
    dot / denom
}

#[derive(Clone, Debug, Default)]
pub struct FindCursorOptions {
    /// Optional search window — only correlate within
    /// (centre.x +/- window, centre.y +/- window). Defaults to whole frame.
    pub search_centre: Option<Point>,
    pub search_window: Option<f64>,
    /// Minimum correlation score to accept (0..1). Default 0.6 in the
    /// caller helper below — live data: real cursor matches score
    /// 0.85-0.97, stable false positives over a dimmed modal scrim score
    /// 0.74-0.82; 0.83 separates them cleanly.
    pub min_score: Option<f64>,
    /// Step in pixels between correlation samples. 1 = exhaustive (slowest,
    /// pixel-perfect); higher values trade accuracy for speed. Default 4.
    pub step: Option<u32>,
    /// When supplied, prefer per-template matches whose position is within
    /// `expected_near_radius` of this hint over far high-scoring matches.
    pub expected_near: Option<Point>,
    pub expected_near_radius: Option<f64>,
    /// When true and `expected_near` is set, return None if NO match falls
    /// within `expected_near_radius` rather than falling back to the
    /// highest-scoring match anywhere on screen.
    pub require_within_radius: bool,
    /// When set together with `verbose`, log the top-K highest-scoring
    /// positions in this template's correlation surface. Diagnostic only —
    /// does NOT change selection.
    pub top_k: Option<usize>,
    pub verbose: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct FindCursorResult {
    pub position: Point,
    pub score: f64,
}

/// Find the cursor in a pre-decoded screenshot by template matching.
/// Returns the best match position and its correlation score, or None if
/// the score fell below `min_score`.
pub fn find_cursor_by_template_decoded(
    screenshot: &DecodedScreenshot,
    template: &CursorTemplate,
    options: &FindCursorOptions,
) -> Option<FindCursorResult> {
    let stats = compute_template_stats(template);
    let step = options.step.unwrap_or(4) as i64;
    let min_score = options.min_score.unwrap_or(0.83);

    let mut x_min: i64 = 0;
    let mut x_max: i64 = screenshot.width as i64 - template.width as i64;
    let mut y_min: i64 = 0;
    let mut y_max: i64 = screenshot.height as i64 - template.height as i64;
    if let (Some(centre), Some(w)) = (options.search_centre, options.search_window) {
        x_min = 0i64.max((centre.x - w - template.width as f64 / 2.0).floor() as i64);
        x_max = (screenshot.width as i64 - template.width as i64)
            .min((centre.x + w - template.width as f64 / 2.0).ceil() as i64);
        y_min = 0i64.max((centre.y - w - template.height as f64 / 2.0).floor() as i64);
        y_max = (screenshot.height as i64 - template.height as i64)
            .min((centre.y + w - template.height as f64 / 2.0).ceil() as i64);
    }

    let mut best_score = f64::NEG_INFINITY;
    let mut best_x: i64 = 0;
    let mut best_y: i64 = 0;

    // Optional intra-template top-K heap (verbose diagnostic only). We
    // dedupe candidates within `step*2` px so we don't surface several
    // sub-pixel-adjacent peaks of the same correlation hill.
    let want_top_k = options.top_k.is_some() && options.verbose;
    let top_k = if want_top_k {
        options.top_k.unwrap().max(1)
    } else {
        0
    };
    let dedupe_radius = step * 2;
    struct Cand {
        score: f64,
        x: i64,
        y: i64,
    }
    let mut candidates: Vec<Cand> = Vec::new();

    let mut y = y_min;
    while y <= y_max {
        let mut x = x_min;
        while x <= x_max {
            let score = correlate_at(&screenshot.rgb, screenshot.width, &stats, x, y);
            if score > best_score {
                best_score = score;
                best_x = x;
                best_y = y;
            }
            if want_top_k {
                let mut merged = false;
                for c in candidates.iter_mut() {
                    if (c.x - x).abs() <= dedupe_radius && (c.y - y).abs() <= dedupe_radius {
                        if score > c.score {
                            c.score = score;
                            c.x = x;
                            c.y = y;
                        }
                        merged = true;
                        break;
                    }
                }
                if !merged {
                    candidates.push(Cand { score, x, y });
                    if candidates.len() as i64 > top_k as i64 * 4 {
                        candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
                        candidates.truncate((top_k * 2).max(1));
                    }
                }
            }
            x += step;
        }
        y += step;
    }

    // Report the cursor's clickable HOTSPOT (arrow tip for an iPadOS arrow
    // cursor), not the bounding-box centre — templates without a hotspot
    // (legacy disk-loaded templates) fall back to bbox centre.
    let hs = template.hotspot.unwrap_or(Point {
        x: (template.width / 2) as f64,
        y: (template.height / 2) as f64,
    });

    if options.verbose {
        eprintln!(
            "[template-match] best score={:.3} at ({}, {}) hotspot=({},{}) (window={}-{}x{}-{}, step={})",
            best_score,
            best_x as f64 + hs.x,
            best_y as f64 + hs.y,
            hs.x,
            hs.y,
            x_min,
            x_max,
            y_min,
            y_max,
            step
        );
        if want_top_k {
            candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
            let top_list: Vec<String> = candidates
                .iter()
                .take(top_k)
                .enumerate()
                .map(|(i, c)| {
                    format!(
                        " {}={:.3}@({},{})",
                        i + 1,
                        c.score,
                        c.x as f64 + hs.x,
                        c.y as f64 + hs.y
                    )
                })
                .collect();
            eprintln!(
                "[template-match] top-{}:{}",
                top_list.len(),
                top_list.join("")
            );
        }
    }

    if best_score < min_score {
        return None;
    }
    Some(FindCursorResult {
        position: Point {
            x: best_x as f64 + hs.x,
            y: best_y as f64 + hs.y,
        },
        score: best_score,
    })
}

#[derive(Clone, Copy, Debug)]
pub struct FindCursorSetResult {
    pub position: Point,
    pub score: f64,
    /// Index in the input templates[] of the template that won.
    pub template_index: usize,
}

/// Multi-template variant of `find_cursor_by_template_decoded`. Iterates
/// the supplied template set, runs each one's NCC search, and returns the
/// highest-scoring match across all templates.
///
/// LEGACY (NCC template-set) — refuted as primary; retained only as a
/// vestigial fallback in move-to.ts. NOT the tracker; see
/// cursor-ml-detect.ts findCursorByV8FullFrame.
pub fn find_cursor_by_template_set(
    screenshot: &DecodedScreenshot,
    templates: &[CursorTemplate],
    options: &FindCursorOptions,
) -> Option<FindCursorSetResult> {
    if templates.is_empty() {
        return None;
    }
    // Pass min_score=0 to each individual call so we always get the
    // best-available score back; the min_score threshold is applied once
    // at the outer level after picking the winner.
    let mut inner_opts = options.clone();
    inner_opts.min_score = Some(0.0);
    let mut all_matches: Vec<FindCursorSetResult> = Vec::new();
    for (i, tpl) in templates.iter().enumerate() {
        if let Some(r) = find_cursor_by_template_decoded(screenshot, tpl, &inner_opts) {
            all_matches.push(FindCursorSetResult {
                position: r.position,
                score: r.score,
                template_index: i,
            });
        }
    }
    if all_matches.is_empty() {
        return None;
    }

    // Locality-aware ranking. When a hint is provided, prefer matches
    // within the hint radius over far high-scoring matches — the iPad UI
    // has fixed elements that score 0.85-0.95 against varied templates;
    // without the hint those false positives win over the real cursor
    // sitting near the previous confirmed position.
    let mut best: Option<FindCursorSetResult> = None;
    if let Some(hint) = options.expected_near {
        let radius = options.expected_near_radius.unwrap_or(100.0);
        let within: Vec<&FindCursorSetResult> = all_matches
            .iter()
            .filter(|m| {
                ((m.position.x - hint.x).powi(2) + (m.position.y - hint.y).powi(2)).sqrt() <= radius
            })
            .collect();
        if !within.is_empty() {
            best = Some(
                *within
                    .into_iter()
                    .reduce(|a, b| if a.score >= b.score { a } else { b })
                    .unwrap(),
            );
        } else if options.require_within_radius {
            // Caller asked us NOT to silently fall back to a far
            // high-score match.
            return None;
        }
    }
    if best.is_none() {
        best = Some(
            *all_matches
                .iter()
                .reduce(|a, b| if a.score >= b.score { a } else { b })
                .unwrap(),
        );
    }
    let best = best.unwrap();

    let min_score = options.min_score.unwrap_or(0.83);
    if best.score < min_score {
        return None;
    }
    Some(best)
}

/// Pure helper: given a candidate cursor position from one frame and a
/// re-found candidate position from a second frame after a known emit,
/// decide whether the candidate is the real cursor (it moved as expected)
/// or a static wallpaper false-positive (it didn't move).
///
/// Returns true iff the candidate moved by approximately `expected_dx`
/// pixels in the X axis and `expected_dy` in the Y axis, within a
/// tolerance of `tolerance_fraction` of the expected magnitude (TS default
/// 0.5 — iPad acceleration variance + JPEG re-quantisation easily shifts
/// the matched position by 50% of a small emit).
///
/// Pure: no I/O, deterministic.
pub fn cursor_moved_as_expected(
    before: Point,
    after: Point,
    expected_dx: f64,
    expected_dy: f64,
    tolerance_fraction: f64,
) -> bool {
    let actual_dx = after.x - before.x;
    let actual_dy = after.y - before.y;
    // If both axes are zero, the test is ill-defined — return true (no
    // expected motion to verify).
    let expected_magnitude = (expected_dx * expected_dx + expected_dy * expected_dy).sqrt();
    if expected_magnitude < 1.0 {
        return true;
    }
    // Per-axis tolerance: at least 3px (handle JPEG / detection
    // quantisation noise even for very small emits) and at most
    // tolerance_fraction * |expected|.
    let tol_x = 3f64.max(expected_dx.abs() * tolerance_fraction);
    let tol_y = 3f64.max(expected_dy.abs() * tolerance_fraction);
    if expected_dx.abs() >= 1.0 {
        if actual_dx.signum() != expected_dx.signum() {
            return false;
        }
        if (actual_dx - expected_dx).abs() > tol_x && actual_dx.abs() < expected_dx.abs() - tol_x {
            return false;
        }
    }
    if expected_dy.abs() >= 1.0 {
        if actual_dy.signum() != expected_dy.signum() {
            return false;
        }
        if (actual_dy - expected_dy).abs() > tol_y && actual_dy.abs() < expected_dy.abs() - tol_y {
            return false;
        }
    }
    true
}
