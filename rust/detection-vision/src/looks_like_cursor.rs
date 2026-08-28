//! `looksLikeCursor` — guards template capture against bad motion-diff
//! pairs that point at icon corners or animated widgets.
//!
//! Faithful port of `looksLikeCursor` + its `cohesiveBlobInMask` helper
//! from `src/pikvm/move-to.ts` (module 4, mover). Extracted into module 3
//! (detection-vision) rather than left to wait for module 4: it's a pure
//! shape heuristic over `CursorTemplate` with zero `PiKVMClient`/mover
//! dependency, and `seed-template.ts` (this crate) needs it directly.
//! Matches the session's established shared-primitive-extraction pattern
//! (`ipad-primitives`, `cursor-belief`) — module 4 will depend on this
//! crate for it once built, rather than duplicating the logic.
//!
//! Bug context: live testing on the iPad caught a self-reinforcing failure
//! mode where motion-diff picked a wrong pair, captured a template from a
//! non-cursor region (e.g. orange-blue icon corner), persisted that bad
//! template, and then every subsequent template match scored 0.99 against
//! THE SAME WRONG SPOT — the algorithm thought it had found the cursor
//! every time.

use crate::cursor_detect::CursorTemplate;

// Phase 194-B (v0.5.188): also accept dark cursor patterns. Some iPad
// deployments render the cursor as DARK (~50-100px brightness) on a LIGHT
// wallpaper. The original looksLikeCursor only counted BRIGHT achromatic
// pixels, so every cursor template extracted on that hardware was
// rejected — leaving the runtime with no templates to use for
// findCursorByTemplateSet.
//
// Cursor pixels with cMax < 100 AND saturation <= 30 are dark achromatic.
// The cap of 100 keeps very-dark wallpaper specks (cMax < 80) from
// counting as "dark cursor" while still admitting the iPad's pointer
// (50-100 brightness range observed live).
const CURSOR_DARKNESS_CEILING: i32 = 100;
const CURSOR_BRIGHTNESS_FLOOR: i32 = 100;

/// Find a single cohesive achromatic blob within a mask. Returns total
/// mask pixels and the size of the largest connected component. 4-
/// connectivity BFS.
fn cohesive_blob_in_mask(mask: &[bool], w: u32, h: u32) -> (usize, usize) {
    let (w, h) = (w as usize, h as usize);
    let px = w * h;
    let count = mask.iter().filter(|&&m| m).count();
    let mut visited = vec![false; px];
    let mut queue = vec![0usize; px];
    let mut largest = 0usize;
    for i in 0..px {
        if !mask[i] || visited[i] {
            continue;
        }
        visited[i] = true;
        queue[0] = i;
        let (mut head, mut tail) = (0usize, 1usize);
        let mut size = 0usize;
        while head < tail {
            let idx = queue[head];
            head += 1;
            size += 1;
            let x = idx % w;
            let y = (idx - x) / w;
            if x > 0 {
                let n = idx - 1;
                if mask[n] && !visited[n] {
                    visited[n] = true;
                    queue[tail] = n;
                    tail += 1;
                }
            }
            if x < w - 1 {
                let n = idx + 1;
                if mask[n] && !visited[n] {
                    visited[n] = true;
                    queue[tail] = n;
                    tail += 1;
                }
            }
            if y > 0 {
                let n = idx - w;
                if mask[n] && !visited[n] {
                    visited[n] = true;
                    queue[tail] = n;
                    tail += 1;
                }
            }
            if y < h - 1 {
                let n = idx + w;
                if mask[n] && !visited[n] {
                    visited[n] = true;
                    queue[tail] = n;
                    tail += 1;
                }
            }
        }
        if size > largest {
            largest = size;
        }
    }
    (count, largest)
}

/// Does `t` look like a captured cursor, not a colored icon corner, a text
/// glyph, or an empty/uniform region?
pub fn looks_like_cursor(t: &CursorTemplate) -> bool {
    let (w, h) = (t.width, t.height);
    let px = (w as usize) * (h as usize);
    let mut bright = vec![false; px];
    let mut dark = vec![false; px];
    let mut total_saturation = 0i64;
    for i in 0..px {
        let o = i * 3;
        let (r, g, b) = (t.rgb[o] as i32, t.rgb[o + 1] as i32, t.rgb[o + 2] as i32);
        let c_min = r.min(g).min(b);
        let c_max = r.max(g).max(b);
        let sat = c_max - c_min;
        total_saturation += sat as i64;
        // Per-pixel sat <= 80 admits color-tinted iPad cursors (wallpaper
        // bleed through anti-aliasing pushes sat to 60-110); the
        // frame-mean mean_sat >= 50 gate below is the actual icon rejector.
        if c_min >= CURSOR_BRIGHTNESS_FLOOR && sat <= 80 {
            bright[i] = true;
        }
        if c_max < CURSOR_DARKNESS_CEILING && sat <= 80 {
            dark[i] = true;
        }
    }
    let mean_sat = total_saturation as f64 / px as f64;
    if mean_sat >= 50.0 {
        return false;
    }

    // Count window 4-18% keeps cursor in, rejects text glyphs / icons
    // (typically 14-26% of a 24x24 crop). Cohesion >= 75% keeps
    // single-blob cursors, rejects multi-blob icons / text fragments.
    //
    // Accept if EITHER bright OR dark cohesion matches. Bright path
    // serves the historic case (cursor lighter than backdrop, e.g. dim
    // wallpaper). Dark path serves the dark-pointer-on-light-wallpaper
    // case.
    let (bright_count, bright_largest) = cohesive_blob_in_mask(&bright, w, h);
    let bright_ok = bright_count as f64 >= px as f64 * 0.04
        && bright_count as f64 <= px as f64 * 0.18
        && bright_largest as f64 >= bright_count as f64 * 0.75;
    if bright_ok {
        return true;
    }

    let (dark_count, dark_largest) = cohesive_blob_in_mask(&dark, w, h);
    dark_count as f64 >= px as f64 * 0.04
        && dark_count as f64 <= px as f64 * 0.18
        && dark_largest as f64 >= dark_count as f64 * 0.75
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template(width: u32, height: u32, fill: impl Fn(usize) -> [u8; 3]) -> CursorTemplate {
        let px = (width as usize) * (height as usize);
        let mut rgb = vec![0u8; px * 3];
        for i in 0..px {
            let [r, g, b] = fill(i);
            rgb[i * 3] = r;
            rgb[i * 3 + 1] = g;
            rgb[i * 3 + 2] = b;
        }
        CursorTemplate {
            rgb,
            width,
            height,
            hotspot: None,
        }
    }

    #[test]
    fn accepts_a_typical_cursor_template_gray_cursor_on_dark_background() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let in_cursor = (x as i64 - 12).abs() < 4 && (y as i64 - 12).abs() < 4;
            if in_cursor {
                [240, 240, 240]
            } else {
                [60, 60, 60]
            }
        });
        assert!(looks_like_cursor(&t));
    }

    #[test]
    fn rejects_a_colored_icon_corner() {
        let t = template(24, 24, |i| {
            let y = i / 24;
            if y < 12 {
                [220, 100, 60]
            } else {
                [50, 100, 220]
            }
        });
        assert!(!looks_like_cursor(&t));
    }

    #[test]
    fn rejects_a_fully_colored_region() {
        let t = template(24, 24, |_| [220, 60, 60]);
        assert!(!looks_like_cursor(&t));
    }

    #[test]
    fn rejects_a_region_with_no_bright_pixels() {
        let t = template(24, 24, |_| [80, 80, 80]);
        assert!(!looks_like_cursor(&t));
    }

    #[test]
    fn accepts_a_barely_cursor_like_region() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let in_cursor = (x as i64 - 12).abs() < 3 && (y as i64 - 12).abs() < 3;
            if in_cursor {
                [200, 200, 200]
            } else {
                [40, 40, 40]
            }
        });
        assert!(looks_like_cursor(&t));
    }

    #[test]
    fn rejects_a_multi_glyph_text_fragment() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let in_glyph_row = (8..14).contains(&y);
            let x_col = x % 6;
            let in_glyph_col = (2..5).contains(&x_col);
            if in_glyph_row && in_glyph_col {
                [240, 240, 240]
            } else {
                [40, 40, 40]
            }
        });
        assert!(!looks_like_cursor(&t));
    }

    #[test]
    fn accepts_ipados_soft_grey_cursor() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let in_cursor = (x as i64 - 12).abs() < 4 && (y as i64 - 12).abs() < 4;
            if in_cursor {
                [120, 120, 120]
            } else {
                [40, 40, 40]
            }
        });
        assert!(looks_like_cursor(&t));
    }

    #[test]
    fn rejects_a_heavy_single_letter_glyph() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let on_top_or_bottom =
                ((5..=7).contains(&y) || (16..=18).contains(&y)) && (5..=18).contains(&x);
            let on_left_side = (5..=7).contains(&x) && (5..=18).contains(&y);
            let on_right_lower = (16..=18).contains(&x) && (12..=18).contains(&y);
            let on_serif = (11..=13).contains(&y) && (13..=18).contains(&x);
            let is_letter = on_top_or_bottom || on_left_side || on_right_lower || on_serif;
            if is_letter {
                [240, 240, 240]
            } else {
                [40, 40, 40]
            }
        });
        assert!(!looks_like_cursor(&t));
    }

    #[test]
    fn accepts_a_cursor_with_small_anti_alias_satellite_pixels() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let in_main = (x as i64 - 12).abs() < 3 && (y as i64 - 12).abs() < 3;
            let is_satellite = (x == 5 && y == 5) || (x == 19 && y == 19);
            if in_main || is_satellite {
                [240, 240, 240]
            } else {
                [40, 40, 40]
            }
        });
        assert!(looks_like_cursor(&t));
    }

    #[test]
    fn accepts_a_dark_cursor_template_on_a_light_backdrop() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let in_cursor = (x as i64 - 12).abs() < 4 && (y as i64 - 12).abs() < 4;
            if in_cursor {
                [70, 70, 70]
            } else {
                [220, 220, 220]
            }
        });
        assert!(looks_like_cursor(&t));
    }

    #[test]
    fn still_rejects_a_uniform_light_backdrop_with_no_cursor() {
        let t = template(24, 24, |_| [220, 220, 220]);
        assert!(!looks_like_cursor(&t));
    }

    #[test]
    fn rejects_a_colored_backdrop_with_a_small_dark_blob() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let in_cursor = (x as i64 - 12).abs() < 4 && (y as i64 - 12).abs() < 4;
            if in_cursor {
                [70, 70, 70]
            } else {
                [50, 200, 200]
            }
        });
        assert!(!looks_like_cursor(&t));
    }

    #[test]
    fn accepts_a_teal_tinted_ipad_cursor_masked_zero_background() {
        let t = template(24, 24, |i| {
            let (x, y) = (i % 24, i / 24);
            let in_cursor = (10..15).contains(&x) && (10..15).contains(&y);
            if in_cursor {
                [140, 200, 210]
            } else {
                [0, 0, 0]
            }
        });
        assert!(looks_like_cursor(&t));
    }

    #[test]
    fn still_rejects_multi_color_icon_at_saturated_pixels() {
        let t = template(24, 24, |i| {
            let x = i % 24;
            if x < 12 {
                [220, 100, 60]
            } else {
                [50, 100, 220]
            }
        });
        assert!(!looks_like_cursor(&t));
    }
}
