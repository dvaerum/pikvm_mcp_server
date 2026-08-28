//! Screenshot decode/diff geometry: connected-component clustering of
//! changed pixels between two frames, plus the pure locate-cursor
//! contract shapes `cursor_locator.rs` depends on.
//!
//! Split out of `cursor_detect.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

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
