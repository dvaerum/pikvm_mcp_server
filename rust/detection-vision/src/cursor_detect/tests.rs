//! Tests for the `cursor_detect` module family (`diff`, `template`,
//! `persist`). Split into its own file (Rust 2018+ submodule layout)
//! per the idiomatic-file-structure standing rule.

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
    let clusters = diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
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
    let clusters = diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
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
    let clusters = diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
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
    let clusters = diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
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
    let clusters = diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
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
        diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &unfiltered_cfg).unwrap();
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
    let clusters = diff_screenshots_decoded(&decoded(a, w, h), &decoded(b, w, h), &cfg).unwrap();
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

    let result = find_cursor_by_template_decoded(&uniform, &tmpl, &FindCursorOptions::default());
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
    let good_tmpl = extract_cursor_template_decoded(&screenshot_a, Point { x: 50.0, y: 50.0 }, 24);

    // A template captured from a different, unrelated flat region —
    // should score far worse against screenshot_a.
    let bad_rgb = vec![10u8; (w as usize) * (h as usize) * 3];
    let bad_screenshot = decoded(bad_rgb, w, h);
    let bad_tmpl = extract_cursor_template_decoded(&bad_screenshot, Point { x: 50.0, y: 50.0 }, 24);

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
