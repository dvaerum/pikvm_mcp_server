//! Cursor detection via screenshot diffing.
//!
//! Decodes two JPEG frames to raw RGB, diffs them, and returns connected-
//! component clusters of changed pixels. Nearby clusters (e.g. cursor body
//! and its drop shadow) are merged into one.
//!
//! Faithful port of `src/pikvm/cursor-detect.ts`. `takeRawScreenshot` and
//! `locateCursor` are NOT ported here — both take `PiKVMClient` directly
//! and must wait for module 2's `client.rs` to land. Everything else in
//! the source file is pure/IO-only (no client dependency) and is ported
//! below.

use crate::decode::decode_to_rgb;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug)]
pub struct Cluster {
    pub pixels: usize,
    pub centroid_x: i64,
    pub centroid_y: i64,
    /// Tight axis-aligned bounding box of the connected component, in
    /// source-image pixel coordinates. Populated by `find_clusters` and
    /// preserved through `merge_clusters`.
    pub bbox_min_x: i64,
    pub bbox_max_x: i64,
    pub bbox_min_y: i64,
    pub bbox_max_y: i64,
    /// Cluster member pixel indices (flat: y*width + x). Only populated
    /// when `find_clusters` is called with `keep_members: true`.
    pub members: Option<Vec<usize>>,
    /// Mean RGB over the cluster's pixels in the source frame. Only
    /// populated when `find_clusters` is given a `source_rgb` buffer.
    pub mean_r: Option<f64>,
    pub mean_g: Option<f64>,
    pub mean_b: Option<f64>,
}

#[derive(Clone, Copy, Debug)]
pub struct DetectionConfig {
    pub diff_threshold: i32,
    pub min_cluster_size: usize,
    pub max_cluster_size: usize,
    pub merge_radius: f64,
    /// Per-channel brightness floor for a pixel to count as "cursor-bright".
    /// iPadOS's mouse cursor is white/gray (~200-240 per channel). Most
    /// widget-animation diffs change darker pixels (weather icons, clock
    /// hands). Requiring one frame's pixel to be bright filters those out.
    /// 0 disables brightness filtering.
    pub brightness_floor: i32,
    /// Maximum allowed channel imbalance for a pixel to count as cursor-
    /// colored. iPadOS cursor is achromatic (R≈G≈B); animated colored
    /// widgets have much larger channel deltas and are rejected. 0
    /// disables the filter.
    pub max_channel_delta: i32,
}

impl Default for DetectionConfig {
    fn default() -> Self {
        DEFAULT_DETECTION_CONFIG
    }
}

pub const DEFAULT_DETECTION_CONFIG: DetectionConfig = DetectionConfig {
    diff_threshold: 30,
    min_cluster_size: 4,
    max_cluster_size: 2500,
    merge_radius: 30.0,
    // Phase 193-A (v0.5.186): lowered 170 -> 100. A live frame-pair
    // diagnostic showed the iPadOS cursor rendering as a DARK arrow against
    // a light wallpaper; diff pixels through the cursor edge are dark
    // (~50-100), which the old 170 floor rejected outright, leaving
    // motion-diff with zero pairs to find. 100 still filters the darkest
    // wallpaper-only diffs (mostly < 80 brightness).
    brightness_floor: 100,
    // 0 = no pixel-level saturation filter. Pixel-level filtering kills
    // anti-aliased cursor edges (where R/G/B differ due to alpha blending
    // against the wallpaper) — that filtering belongs at the CLUSTER level
    // instead, which inspects the cluster's centroid colour once formed.
    max_channel_delta: 0,
};

// ============================================================================
// Low-level pixel operations
// ============================================================================

/// A screenshot together with its decoded RGB pixels. Avoids paying the
/// JPEG-decode cost more than once per frame.
pub struct DecodedScreenshot {
    /// The raw JPEG buffer — kept around so callers can still re-encode
    /// (e.g. saving a cursor template).
    pub buffer: Vec<u8>,
    /// Decoded RGB pixels, length = width * height * 3.
    pub rgb: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Decode a screenshot's JPEG buffer once and return both the buffer and
/// the decoded RGB pixels in a single object.
pub fn decode_screenshot(buffer: &[u8]) -> anyhow::Result<DecodedScreenshot> {
    let decoded = decode_to_rgb(buffer)?;
    Ok(DecodedScreenshot {
        buffer: buffer.to_vec(),
        rgb: decoded.data,
        width: decoded.width,
        height: decoded.height,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn diff_pixels(
    a: &[u8],
    b: &[u8],
    width: u32,
    height: u32,
    threshold: i32,
    brightness_floor: i32,
    // Maximum allowed channel imbalance (max - min over R/G/B) for a pixel
    // to count as cursor-colored. 0 disables saturation filtering.
    max_channel_delta: i32,
) -> Vec<bool> {
    let total = (width as usize) * (height as usize);
    let mut mask = vec![false; total];
    for (i, m) in mask.iter_mut().enumerate() {
        let offset = i * 3;
        let dr = (a[offset] as i32 - b[offset] as i32).abs();
        let dg = (a[offset + 1] as i32 - b[offset + 1] as i32).abs();
        let db = (a[offset + 2] as i32 - b[offset + 2] as i32).abs();
        if dr + dg + db < threshold {
            continue;
        }
        let (ar, ag, ab) = (a[offset] as i32, a[offset + 1] as i32, a[offset + 2] as i32);
        let (br, bg, bb) = (b[offset] as i32, b[offset + 1] as i32, b[offset + 2] as i32);
        if brightness_floor > 0 {
            // Phase 8: pass a pixel if EITHER frame has bright RGB at this
            // location. The cursor is bright in whichever frame contains
            // it; the other frame has the (often-dim) wallpaper revealed.
            let a_bright =
                ar >= brightness_floor && ag >= brightness_floor && ab >= brightness_floor;
            let b_bright =
                br >= brightness_floor && bg >= brightness_floor && bb >= brightness_floor;
            if !a_bright && !b_bright {
                continue;
            }
        }
        if max_channel_delta > 0 {
            let c_max = br.max(bg).max(bb);
            let c_min = br.min(bg).min(bb);
            if c_max - c_min > max_channel_delta {
                continue;
            }
        }
        *m = true;
    }
    mask
}

pub fn find_clusters(
    mask: &[bool],
    width: u32,
    height: u32,
    min_size: usize,
    max_size: usize,
    // Optional source RGB buffer (3 bytes per pixel, row-major). When
    // provided, each cluster gets mean_r/mean_g/mean_b populated.
    source_rgb: Option<&[u8]>,
    // When true, each returned cluster carries `members` — the flat pixel
    // indices of the connected component.
    keep_members: bool,
) -> Vec<Cluster> {
    let (w, h) = (width as usize, height as usize);
    let mut visited = vec![false; w * h];
    let mut clusters = Vec::new();

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            if !mask[idx] || visited[idx] {
                continue;
            }

            let mut queue: Vec<usize> = vec![idx];
            visited[idx] = true;
            let (mut sum_x, mut sum_y) = (0i64, 0i64);
            let (mut sum_r, mut sum_g, mut sum_b) = (0i64, 0i64, 0i64);
            let mut count = 0usize;
            let (mut b_min_x, mut b_max_x, mut b_min_y, mut b_max_y) =
                (x as i64, x as i64, y as i64, y as i64);
            let mut members: Option<Vec<usize>> =
                if keep_members { Some(Vec::new()) } else { None };

            while let Some(ci) = queue.pop() {
                let cx = ci % w;
                let cy = (ci - cx) / w;
                sum_x += cx as i64;
                sum_y += cy as i64;
                if (cx as i64) < b_min_x {
                    b_min_x = cx as i64;
                }
                if (cx as i64) > b_max_x {
                    b_max_x = cx as i64;
                }
                if (cy as i64) < b_min_y {
                    b_min_y = cy as i64;
                }
                if (cy as i64) > b_max_y {
                    b_max_y = cy as i64;
                }
                if let Some(src) = source_rgb {
                    let off = ci * 3;
                    sum_r += src[off] as i64;
                    sum_g += src[off + 1] as i64;
                    sum_b += src[off + 2] as i64;
                }
                if let Some(m) = members.as_mut() {
                    m.push(ci);
                }
                count += 1;

                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = cx as i64 + dx;
                        let ny = cy as i64 + dy;
                        if nx < 0 || nx >= w as i64 || ny < 0 || ny >= h as i64 {
                            continue;
                        }
                        let ni = (ny as usize) * w + (nx as usize);
                        if !mask[ni] || visited[ni] {
                            continue;
                        }
                        visited[ni] = true;
                        queue.push(ni);
                    }
                }
            }

            if count >= min_size && count <= max_size {
                let mut c = Cluster {
                    pixels: count,
                    centroid_x: (sum_x as f64 / count as f64).round() as i64,
                    centroid_y: (sum_y as f64 / count as f64).round() as i64,
                    bbox_min_x: b_min_x,
                    bbox_max_x: b_max_x,
                    bbox_min_y: b_min_y,
                    bbox_max_y: b_max_y,
                    members: None,
                    mean_r: None,
                    mean_g: None,
                    mean_b: None,
                };
                if source_rgb.is_some() {
                    c.mean_r = Some(sum_r as f64 / count as f64);
                    c.mean_g = Some(sum_g as f64 / count as f64);
                    c.mean_b = Some(sum_b as f64 / count as f64);
                }
                c.members = members;
                clusters.push(c);
            }
        }
    }

    clusters
}

pub fn merge_clusters(clusters: Vec<Cluster>, merge_radius: f64) -> Vec<Cluster> {
    if clusters.len() <= 1 {
        return clusters;
    }

    let mut parent: Vec<usize> = (0..clusters.len()).collect();

    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }

    fn union(parent: &mut [usize], a: usize, b: usize) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent[ra] = rb;
        }
    }

    for i in 0..clusters.len() {
        for j in (i + 1)..clusters.len() {
            let dx = (clusters[i].centroid_x - clusters[j].centroid_x) as f64;
            let dy = (clusters[i].centroid_y - clusters[j].centroid_y) as f64;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist <= merge_radius {
                union(&mut parent, i, j);
            }
        }
    }

    let mut groups: std::collections::BTreeMap<usize, Vec<usize>> =
        std::collections::BTreeMap::new();
    for i in 0..clusters.len() {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(i);
    }

    let mut merged = Vec::new();
    for group_members in groups.values() {
        let mut total_pixels = 0usize;
        let (mut weighted_x, mut weighted_y) = (0f64, 0f64);
        let (mut weighted_r, mut weighted_g, mut weighted_b) = (0f64, 0f64, 0f64);
        let mut have_color = true;
        let mut b_min_x: Option<i64> = None;
        let mut b_max_x: Option<i64> = None;
        let mut b_min_y: Option<i64> = None;
        let mut b_max_y: Option<i64> = None;
        let mut combined_members: Option<Vec<usize>> = None;
        for &idx in group_members {
            let c = &clusters[idx];
            total_pixels += c.pixels;
            weighted_x += c.centroid_x as f64 * c.pixels as f64;
            weighted_y += c.centroid_y as f64 * c.pixels as f64;
            match (c.mean_r, c.mean_g, c.mean_b) {
                (Some(r), Some(g), Some(b)) => {
                    weighted_r += r * c.pixels as f64;
                    weighted_g += g * c.pixels as f64;
                    weighted_b += b * c.pixels as f64;
                }
                _ => have_color = false,
            }
            b_min_x = Some(b_min_x.map_or(c.bbox_min_x, |v| v.min(c.bbox_min_x)));
            b_max_x = Some(b_max_x.map_or(c.bbox_max_x, |v| v.max(c.bbox_max_x)));
            b_min_y = Some(b_min_y.map_or(c.bbox_min_y, |v| v.min(c.bbox_min_y)));
            b_max_y = Some(b_max_y.map_or(c.bbox_max_y, |v| v.max(c.bbox_max_y)));
            if let Some(m) = &c.members {
                combined_members
                    .get_or_insert_with(Vec::new)
                    .extend(m.iter().copied());
            }
        }
        let mut m = Cluster {
            pixels: total_pixels,
            centroid_x: (weighted_x / total_pixels as f64).round() as i64,
            centroid_y: (weighted_y / total_pixels as f64).round() as i64,
            bbox_min_x: b_min_x.unwrap(),
            bbox_max_x: b_max_x.unwrap(),
            bbox_min_y: b_min_y.unwrap(),
            bbox_max_y: b_max_y.unwrap(),
            members: combined_members,
            mean_r: None,
            mean_g: None,
            mean_b: None,
        };
        if have_color {
            m.mean_r = Some(weighted_r / total_pixels as f64);
            m.mean_g = Some(weighted_g / total_pixels as f64);
            m.mean_b = Some(weighted_b / total_pixels as f64);
        }
        merged.push(m);
    }

    merged
}

/// Diff two pre-decoded screenshots. Use this when the decoded RGB is
/// already on hand to avoid a redundant JPEG decode.
pub fn diff_screenshots_decoded(
    a: &DecodedScreenshot,
    b: &DecodedScreenshot,
    config: &DetectionConfig,
) -> anyhow::Result<Vec<Cluster>> {
    if a.width != b.width || a.height != b.height {
        anyhow::bail!("Screenshot dimensions changed between captures");
    }
    let mask = diff_pixels(
        &a.rgb,
        &b.rgb,
        a.width,
        a.height,
        config.diff_threshold,
        config.brightness_floor,
        config.max_channel_delta,
    );
    let raw = find_clusters(
        &mask,
        a.width,
        a.height,
        config.min_cluster_size,
        config.max_cluster_size,
        Some(&b.rgb),
        false,
    );
    Ok(merge_clusters(raw, config.merge_radius))
}

/// Convenience wrapper for callers that only have the JPEG buffers.
pub fn diff_screenshots(
    buf_a: &[u8],
    buf_b: &[u8],
    config: &DetectionConfig,
) -> anyhow::Result<Vec<Cluster>> {
    let a = decode_screenshot(buf_a)?;
    let b = decode_screenshot(buf_b)?;
    diff_screenshots_decoded(&a, &b, config)
}

// ============================================================================
// Helpers for ballistics / move-to
// ============================================================================
//
// `takeRawScreenshot(client)` and `locateCursor(client, options)` both take
// `PiKVMClient` directly (screenshot capture + mouse-move emission) and are
// STILL deferred — this crate doesn't depend on kvmd-client, by design (see
// module-3's own crate-boundary decisions). `LocateCursorOptions` /
// `LocateCursorResult` are ported below on their own, though: they're pure
// data shapes (no client dependency), and cursor_locator.rs's
// `CursorLocatorDeps.locate_cursor` field needs the real contract, not a
// stand-in — matches the TS source's own `import type { LocateCursorOptions,
// LocateCursorResult } from './cursor-detect.js'` in cursor-locator.ts,
// which imports only the types, not the client-taking function.

/// Options for the (deferred) `locate_cursor` probe-and-diff function.
/// Ported now as a pure data shape for `cursor_locator.rs`'s DI contract.
#[derive(Clone, Debug, Default)]
pub struct LocateCursorOptions {
    /// Mickeys, +x direction. TS default 60.
    pub probe_delta: Option<f64>,
    /// ms between move and screenshot. TS default 300.
    pub settle_ms: Option<u64>,
    pub detection: Option<DetectionConfig>,
    /// TS default 3.
    pub max_attempts: Option<u32>,
    pub expected_near: Option<Point>,
    /// TS default 200.
    pub expected_near_radius: Option<f64>,
    pub verbose: bool,
}

/// Result of the (deferred) `locate_cursor` probe-and-diff function.
#[derive(Clone, Copy, Debug)]
pub struct LocateCursorResult {
    /// Cursor position AFTER the probe (i.e. where it is when this returns).
    pub position: Point,
    /// Where the cursor was BEFORE the probe — informational.
    pub pre_position: Point,
    /// Observed displacement from the probe.
    pub probe_offset_px: Point,
    /// Signed mickey count emitted in the successful probe.
    pub probe_mickeys: Point,
    /// For diagnostics.
    pub cluster_count: usize,
}

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

/// Persist a cursor template to disk for reuse across invocations.
pub async fn save_cursor_template(
    template: &CursorTemplate,
    file_path: &str,
) -> anyhow::Result<()> {
    let path = std::path::Path::new(file_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let img: image::RgbImage =
        image::ImageBuffer::from_raw(template.width, template.height, template.rgb.clone())
            .ok_or_else(|| {
                anyhow::anyhow!("save_cursor_template: rgb buffer doesn't match width*height*3")
            })?;
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
    encoder.encode_image(&img)?;
    tokio::fs::write(path, &buf).await?;
    Ok(())
}

/// Load a cursor template previously written by `save_cursor_template`.
/// Returns None if the file is missing.
pub async fn load_cursor_template(file_path: &str) -> anyhow::Result<Option<CursorTemplate>> {
    let buf = match tokio::fs::read(file_path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let decoded = decode_to_rgb(&buf)?;
    let mut tpl = CursorTemplate {
        rgb: decoded.data,
        width: decoded.width,
        height: decoded.height,
        hotspot: None,
    };
    // Legacy disk-format templates don't carry a hotspot; recompute it from
    // the loaded pixel data so callers report the cursor TIP, not
    // bbox-centre.
    tpl.hotspot = Some(compute_template_hotspot(&tpl));
    Ok(Some(tpl))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
        for i in 0..(w as usize) * (h as usize) {
            buf[i * 3] = fill[0];
            buf[i * 3 + 1] = fill[1];
            buf[i * 3 + 2] = fill[2];
        }
        buf
    }

    fn stamp_square(buf: &mut [u8], w: u32, h: u32, cx: i64, cy: i64, size: i64, colour: [u8; 3]) {
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
    }

    fn decoded(rgb: Vec<u8>, w: u32, h: u32) -> DecodedScreenshot {
        DecodedScreenshot {
            buffer: Vec::new(),
            rgb,
            width: w,
            height: h,
        }
    }

    // --- diff_screenshots_decoded -------------------------------------

    #[test]
    fn finds_two_clusters_for_cursor_moving_on_bright_wallpaper_at_floor_170() {
        let (w, h) = (300u32, 200u32);
        let wallpaper = [200u8, 200, 200];
        let cursor = [240u8, 240, 240];
        let mut a = solid(w, h, wallpaper);
        stamp_square(&mut a, w, h, 50, 50, 7, cursor);
        let mut b = solid(w, h, wallpaper);
        stamp_square(&mut b, w, h, 150, 80, 7, cursor);

        let cfg = DetectionConfig {
            brightness_floor: 170,
            merge_radius: 18.0,
            ..DEFAULT_DETECTION_CONFIG
        };
        let clusters =
            diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
        let sized: Vec<_> = clusters
            .iter()
            .filter(|c| c.pixels >= 8 && c.pixels <= 90)
            .collect();
        assert!(sized.len() >= 2);
    }

    #[test]
    fn floor_170_catches_both_clusters_on_dim_wallpaper_or_brightness() {
        let (w, h) = (300u32, 200u32);
        let wallpaper = [60u8, 60, 60];
        let cursor = [240u8, 240, 240];
        let mut a = solid(w, h, wallpaper);
        stamp_square(&mut a, w, h, 50, 50, 7, cursor);
        let mut b = solid(w, h, wallpaper);
        stamp_square(&mut b, w, h, 150, 80, 7, cursor);

        let cfg = DetectionConfig {
            brightness_floor: 170,
            merge_radius: 18.0,
            ..DEFAULT_DETECTION_CONFIG
        };
        let clusters =
            diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
        let sized: Vec<_> = clusters
            .iter()
            .filter(|c| c.pixels >= 8 && c.pixels <= 90)
            .collect();
        assert!(sized.len() >= 2);
    }

    #[test]
    fn floor_100_catches_both_clusters_on_dim_wallpaper() {
        let (w, h) = (300u32, 200u32);
        let wallpaper = [60u8, 60, 60];
        let cursor = [240u8, 240, 240];
        let mut a = solid(w, h, wallpaper);
        stamp_square(&mut a, w, h, 50, 50, 7, cursor);
        let mut b = solid(w, h, wallpaper);
        stamp_square(&mut b, w, h, 150, 80, 7, cursor);

        let cfg = DetectionConfig {
            brightness_floor: 100,
            merge_radius: 18.0,
            ..DEFAULT_DETECTION_CONFIG
        };
        let clusters =
            diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
        let sized: Vec<_> = clusters
            .iter()
            .filter(|c| c.pixels >= 8 && c.pixels <= 90)
            .collect();
        assert!(sized.len() >= 2);
    }

    #[test]
    fn dimension_mismatch_between_frames_errors() {
        let a = decoded(solid(10, 10, [0, 0, 0]), 10, 10);
        let b = decoded(solid(20, 10, [0, 0, 0]), 20, 10);
        let result = diff_screenshots_decoded(&a, &b, &DEFAULT_DETECTION_CONFIG);
        assert!(result.is_err());
    }

    // --- saturation filter ----------------------------------------------

    #[test]
    fn accepts_the_gray_cursor_r_approx_g_approx_b() {
        let (w, h) = (200u32, 150u32);
        let wallpaper = [60u8, 60, 60];
        let cursor = [240u8, 240, 240];
        let mut a = solid(w, h, wallpaper);
        stamp_square(&mut a, w, h, 50, 50, 7, cursor);
        let mut b = solid(w, h, wallpaper);
        stamp_square(&mut b, w, h, 100, 80, 7, cursor);

        let cfg = DetectionConfig {
            brightness_floor: 100,
            max_channel_delta: 25,
            merge_radius: 18.0,
            ..DEFAULT_DETECTION_CONFIG
        };
        let clusters =
            diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
        let sized: Vec<_> = clusters
            .iter()
            .filter(|c| c.pixels >= 8 && c.pixels <= 90)
            .collect();
        assert!(!sized.is_empty());
    }

    #[test]
    fn rejects_a_colored_widget_animation_moving_on_dark_background() {
        // Simulate iPad clock-second hand: bright red moving from one
        // position to another. Should produce 0 cursor-cluster matches at
        // max_channel_delta=25 (strong R but weak G/B).
        let (w, h) = (200u32, 150u32);
        let wallpaper = [60u8, 60, 60];
        let red_hand = [240u8, 60, 60];
        let mut a = solid(w, h, wallpaper);
        stamp_square(&mut a, w, h, 100, 50, 7, red_hand);
        let mut b = solid(w, h, wallpaper);
        stamp_square(&mut b, w, h, 100, 90, 7, red_hand);

        let cfg = DetectionConfig {
            brightness_floor: 100,
            max_channel_delta: 25,
            merge_radius: 18.0,
            ..DEFAULT_DETECTION_CONFIG
        };
        let clusters =
            diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
        let sized: Vec<_> = clusters
            .iter()
            .filter(|c| c.pixels >= 8 && c.pixels <= 90)
            .collect();
        assert_eq!(sized.len(), 0);
    }

    #[test]
    fn with_cursor_and_colored_widget_moving_simultaneously_only_cursor_passes() {
        let (w, h) = (300u32, 200u32);
        let wallpaper = [60u8, 60, 60];
        let cursor = [240u8, 240, 240];
        let blue_widget = [60u8, 100, 240];
        let mut a = solid(w, h, wallpaper);
        stamp_square(&mut a, w, h, 50, 50, 7, cursor);
        stamp_square(&mut a, w, h, 200, 100, 7, blue_widget);
        let mut b = solid(w, h, wallpaper);
        stamp_square(&mut b, w, h, 100, 80, 7, cursor);
        stamp_square(&mut b, w, h, 220, 120, 7, blue_widget);

        let filtered_cfg = DetectionConfig {
            brightness_floor: 100,
            max_channel_delta: 25,
            merge_radius: 18.0,
            ..DEFAULT_DETECTION_CONFIG
        };
        let unfiltered_cfg = DetectionConfig {
            brightness_floor: 100,
            max_channel_delta: 0,
            merge_radius: 18.0,
            ..DEFAULT_DETECTION_CONFIG
        };
        let filtered = diff_screenshots_decoded(
            &decoded(a.clone(), w, h),
            &decoded(b.clone(), w, h),
            &filtered_cfg,
        )
        .unwrap();
        let unfiltered =
            diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &unfiltered_cfg)
                .unwrap();
        let filtered_sized = filtered
            .iter()
            .filter(|c| c.pixels >= 8 && c.pixels <= 90)
            .count();
        let unfiltered_sized = unfiltered
            .iter()
            .filter(|c| c.pixels >= 8 && c.pixels <= 90)
            .count();

        assert!(filtered_sized <= unfiltered_sized);
        assert!(filtered_sized >= 1);
    }

    // --- DEFAULT_DETECTION_CONFIG pin -----------------------------------

    #[test]
    fn brightness_floor_default_is_100() {
        assert_eq!(DEFAULT_DETECTION_CONFIG.brightness_floor, 100);
    }

    #[test]
    fn default_config_catches_a_dark_cursor_moving_on_a_light_wallpaper() {
        let (w, h) = (300u32, 200u32);
        let light_wallpaper = [220u8, 220, 220];
        let dark_cursor = [70u8, 70, 70];
        let mut a = solid(w, h, light_wallpaper);
        stamp_square(&mut a, w, h, 50, 50, 7, dark_cursor);
        let mut b = solid(w, h, light_wallpaper);
        stamp_square(&mut b, w, h, 150, 80, 7, dark_cursor);

        let cfg = DetectionConfig {
            merge_radius: 18.0,
            ..DEFAULT_DETECTION_CONFIG
        };
        let clusters =
            diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
        let sized: Vec<_> = clusters
            .iter()
            .filter(|c| c.pixels >= 8 && c.pixels <= 90)
            .collect();
        assert!(sized.len() >= 2);
    }

    // --- template matching ------------------------------------------------

    fn jpeg_encode(rgb: &[u8], w: u32, h: u32, quality: u8) -> Vec<u8> {
        let img: image::RgbImage = image::ImageBuffer::from_raw(w, h, rgb.to_vec()).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
        encoder.encode_image(&img).unwrap();
        buf
    }

    fn build_screenshot_with_cursor(w: u32, h: u32, cx: i64, cy: i64) -> Vec<u8> {
        let mut buf = vec![100u8; (w as usize) * (h as usize) * 3];
        for y in (cy - 12)..(cy + 12) {
            for x in (cx - 12)..(cx + 12) {
                if x < 0 || x >= w as i64 || y < 0 || y >= h as i64 {
                    continue;
                }
                let i = ((y as u32 * w + x as u32) as usize) * 3;
                let (dx, dy) = ((x - cx) as f64, (y - cy) as f64);
                let v = (200.0 + dx * 2.0 + dy * 2.0).clamp(0.0, 255.0) as u8;
                buf[i] = v;
                buf[i + 1] = v;
                buf[i + 2] = v;
            }
        }
        buf
    }

    #[test]
    fn exact_match_step_1_scores_at_least_0_95_sanity_baseline() {
        let (w, h) = (200u32, 150u32);
        let rgb = build_screenshot_with_cursor(w, h, 50, 50);
        let jpeg = jpeg_encode(&rgb, w, h, 100);
        let screenshot = decode_screenshot(&jpeg).unwrap();
        let tmpl = extract_cursor_template_decoded(&screenshot, Point { x: 50.0, y: 50.0 }, 24);
        let opts = FindCursorOptions {
            step: Some(1),
            min_score: Some(0.5),
            ..Default::default()
        };
        let exact = find_cursor_by_template_decoded(&screenshot, &tmpl, &opts).unwrap();
        assert!(exact.score > 0.95);
    }

    #[test]
    fn rejects_no_cursor_uniform_frame_at_default_min_score() {
        let (w, h) = (200u32, 150u32);
        let rgb = build_screenshot_with_cursor(w, h, 50, 50);
        let jpeg = jpeg_encode(&rgb, w, h, 100);
        let with_cursor = decode_screenshot(&jpeg).unwrap();
        let tmpl = extract_cursor_template_decoded(&with_cursor, Point { x: 50.0, y: 50.0 }, 24);

        let uniform_rgb = vec![100u8; (w as usize) * (h as usize) * 3];
        let uniform_jpeg = jpeg_encode(&uniform_rgb, w, h, 100);
        let uniform = decode_screenshot(&uniform_jpeg).unwrap();

        let result =
            find_cursor_by_template_decoded(&uniform, &tmpl, &FindCursorOptions::default());
        assert!(result.is_none());
    }

    #[test]
    fn caller_can_lower_min_score_for_permissive_search() {
        let (w, h) = (200u32, 150u32);
        let rgb = build_screenshot_with_cursor(w, h, 50, 50);
        let jpeg = jpeg_encode(&rgb, w, h, 100);
        let with_cursor = decode_screenshot(&jpeg).unwrap();
        let tmpl = extract_cursor_template_decoded(&with_cursor, Point { x: 50.0, y: 50.0 }, 24);

        let uniform_rgb = vec![100u8; (w as usize) * (h as usize) * 3];
        let uniform_jpeg = jpeg_encode(&uniform_rgb, w, h, 100);
        let uniform = decode_screenshot(&uniform_jpeg).unwrap();

        let opts = FindCursorOptions {
            min_score: Some(-1.0),
            ..Default::default()
        };
        let permissive = find_cursor_by_template_decoded(&uniform, &tmpl, &opts);
        assert!(permissive.is_some());
    }

    // --- compute_template_hotspot ------------------------------------------

    #[test]
    fn finds_the_topmost_bright_pixel_as_the_hotspot() {
        // A template that's dim everywhere except a bright dot near the top.
        let (w, h) = (10u32, 10u32);
        let mut rgb = vec![50u8; (w as usize) * (h as usize) * 3];
        let i = ((2 * w + 5) as usize) * 3;
        rgb[i] = 255;
        rgb[i + 1] = 255;
        rgb[i + 2] = 255;
        let tpl = CursorTemplate {
            rgb,
            width: w,
            height: h,
            hotspot: None,
        };
        let hs = compute_template_hotspot(&tpl);
        assert_eq!(hs.y, 2.0);
        assert_eq!(hs.x, 5.0);
    }

    #[test]
    fn falls_back_to_bbox_centre_for_a_uniform_low_contrast_template() {
        let (w, h) = (10u32, 8u32);
        let rgb = vec![120u8; (w as usize) * (h as usize) * 3];
        let tpl = CursorTemplate {
            rgb,
            width: w,
            height: h,
            hotspot: None,
        };
        let hs = compute_template_hotspot(&tpl);
        assert_eq!(hs, Point { x: 5.0, y: 4.0 });
    }

    // --- extract_cursor_template_decoded ------------------------------

    #[test]
    fn crops_a_centred_square_and_sets_a_hotspot() {
        let (w, h) = (100u32, 100u32);
        let rgb = build_screenshot_with_cursor(w, h, 50, 50);
        let screenshot = decoded(rgb, w, h);
        let tpl = extract_cursor_template_decoded(&screenshot, Point { x: 50.0, y: 50.0 }, 24);
        assert_eq!(tpl.width, 24);
        assert_eq!(tpl.height, 24);
        assert_eq!(tpl.rgb.len(), 24 * 24 * 3);
        assert!(tpl.hotspot.is_some());
    }

    #[test]
    fn clamps_the_crop_window_at_the_screenshot_edge() {
        let (w, h) = (100u32, 100u32);
        let rgb = build_screenshot_with_cursor(w, h, 0, 0);
        let screenshot = decoded(rgb, w, h);
        // Centred at the very corner — crop must still stay in-bounds.
        let tpl = extract_cursor_template_decoded(&screenshot, Point { x: 0.0, y: 0.0 }, 24);
        assert_eq!(tpl.width, 24);
        assert_eq!(tpl.height, 24);
    }

    // --- find_cursor_by_template_set ----------------------------------

    #[test]
    fn picks_the_highest_scoring_template_across_a_set() {
        let (w, h) = (200u32, 150u32);
        let rgb_a = build_screenshot_with_cursor(w, h, 50, 50);
        let jpeg_a = jpeg_encode(&rgb_a, w, h, 100);
        let screenshot_a = decode_screenshot(&jpeg_a).unwrap();
        let good_tmpl =
            extract_cursor_template_decoded(&screenshot_a, Point { x: 50.0, y: 50.0 }, 24);

        // A template captured from a different, unrelated flat region —
        // should score far worse against screenshot_a.
        let bad_rgb = vec![10u8; (w as usize) * (h as usize) * 3];
        let bad_screenshot = decoded(bad_rgb, w, h);
        let bad_tmpl =
            extract_cursor_template_decoded(&bad_screenshot, Point { x: 50.0, y: 50.0 }, 24);

        let result = find_cursor_by_template_set(
            &screenshot_a,
            &[bad_tmpl, good_tmpl],
            &FindCursorOptions {
                min_score: Some(0.5),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.template_index, 1);
    }

    #[test]
    fn returns_none_for_an_empty_template_set() {
        let (w, h) = (50u32, 50u32);
        let screenshot = decoded(vec![100u8; (w as usize) * (h as usize) * 3], w, h);
        let result = find_cursor_by_template_set(&screenshot, &[], &FindCursorOptions::default());
        assert!(result.is_none());
    }

    #[test]
    fn require_within_radius_rejects_a_far_high_scoring_match() {
        let (w, h) = (200u32, 150u32);
        let rgb = build_screenshot_with_cursor(w, h, 50, 50);
        let jpeg = jpeg_encode(&rgb, w, h, 100);
        let screenshot = decode_screenshot(&jpeg).unwrap();
        let tmpl = extract_cursor_template_decoded(&screenshot, Point { x: 50.0, y: 50.0 }, 24);

        let opts = FindCursorOptions {
            min_score: Some(0.5),
            expected_near: Some(Point { x: 190.0, y: 140.0 }), // far from the real (50,50) match
            expected_near_radius: Some(10.0),
            require_within_radius: true,
            ..Default::default()
        };
        let result = find_cursor_by_template_set(&screenshot, &[tmpl], &opts);
        assert!(result.is_none());
    }

    // --- cursor_moved_as_expected ---------------------------------------

    #[test]
    fn accepts_movement_matching_expected_direction_and_magnitude() {
        let before = Point { x: 100.0, y: 100.0 };
        let after = Point { x: 130.0, y: 100.0 };
        assert!(cursor_moved_as_expected(before, after, 30.0, 0.0, 0.5));
    }

    #[test]
    fn rejects_movement_in_the_wrong_direction() {
        let before = Point { x: 100.0, y: 100.0 };
        let after = Point { x: 70.0, y: 100.0 };
        assert!(!cursor_moved_as_expected(before, after, 30.0, 0.0, 0.5));
    }

    #[test]
    fn rejects_no_movement_when_significant_movement_was_expected() {
        let before = Point { x: 100.0, y: 100.0 };
        let after = Point { x: 100.0, y: 100.0 };
        assert!(!cursor_moved_as_expected(before, after, 30.0, 0.0, 0.5));
    }

    #[test]
    fn treats_a_near_zero_expected_delta_as_always_satisfied() {
        let before = Point { x: 100.0, y: 100.0 };
        let after = Point { x: 250.0, y: 250.0 };
        assert!(cursor_moved_as_expected(before, after, 0.0, 0.0, 0.5));
    }

    // --- save/load cursor template round trip ---------------------------

    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("pikvm-cursor-tmpl-test-{}", std::process::id()))
            .join(format!(
                "{:?}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn saves_and_reloads_a_cursor_template_recomputing_its_hotspot() {
        let dir = tempfile_dir();
        let target = dir.join("nested").join("tmpl.jpg"); // parent dir doesn't exist yet
        let (w, h) = (24u32, 24u32);
        let rgb = build_screenshot_with_cursor(w, h, 12, 12);
        let tpl = CursorTemplate {
            rgb,
            width: w,
            height: h,
            hotspot: None,
        };

        save_cursor_template(&tpl, target.to_str().unwrap())
            .await
            .unwrap();
        let loaded = load_cursor_template(target.to_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.width, w);
        assert_eq!(loaded.height, h);
        assert!(loaded.hotspot.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn load_returns_none_for_a_missing_file() {
        let dir = tempfile_dir();
        let missing = dir.join("does-not-exist.jpg");
        let result = load_cursor_template(missing.to_str().unwrap())
            .await
            .unwrap();
        assert!(result.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
