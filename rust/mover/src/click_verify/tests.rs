//! Faithful port of `src/pikvm/__tests__/click-verify.test.ts`.

use super::*;

fn make_frame(width: u32, height: u32, fill: [u8; 3]) -> DecodedScreenshot {
    let mut rgb = vec![0u8; (width as usize) * (height as usize) * 3];
    for px in rgb.chunks_mut(3) {
        px.copy_from_slice(&fill);
    }
    DecodedScreenshot {
        buffer: Vec::new(),
        rgb,
        width,
        height,
    }
}

fn paint_rect(frame: &mut DecodedScreenshot, x0: u32, y0: u32, w: u32, h: u32, rgb: [u8; 3]) {
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let i = ((y * frame.width + x) as usize) * 3;
            frame.rgb[i..i + 3].copy_from_slice(&rgb);
        }
    }
}

fn encode_png(w: u32, h: u32, rgb: &[u8]) -> Vec<u8> {
    let img: image::ImageBuffer<image::Rgb<u8>, Vec<u8>> =
        image::ImageBuffer::from_raw(w, h, rgb.to_vec()).unwrap();
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
    buf
}

// -- verify_click_by_decoded_frames --

#[test]
fn reports_zero_change_when_pre_and_post_are_identical() {
    let pre = make_frame(100, 100, [128, 128, 128]);
    let post = make_frame(100, 100, [128, 128, 128]);
    let r = verify_click_by_decoded_frames(&pre, &post, ClickVerifyOptions::default()).unwrap();
    assert_eq!(r.changed_pixels, 0);
    assert_eq!(r.changed_fraction, 0.0);
    assert!(!r.screen_changed);
}

#[test]
fn reports_screen_changed_when_a_large_region_differs() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 10, 10, 20, 20, [255, 255, 255]);
    let r = verify_click_by_decoded_frames(&pre, &post, ClickVerifyOptions::default()).unwrap();
    assert!(r.changed_pixels >= 400);
    assert!(r.changed_fraction > 0.005);
    assert!(r.screen_changed);
}

#[test]
fn reports_screen_not_changed_when_only_a_tiny_patch_differs() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 10, 10, 5, 5, [255, 255, 255]);
    let r = verify_click_by_decoded_frames(&pre, &post, ClickVerifyOptions::default()).unwrap();
    assert!(!r.screen_changed);
}

#[test]
fn honours_a_custom_min_changed_fraction() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 10, 10, 5, 5, [255, 255, 255]);
    let r = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            min_changed_fraction: Some(0.001),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(r.screen_changed);
}

#[test]
fn honours_a_custom_pixel_threshold() {
    let pre = make_frame(100, 100, [100, 100, 100]);
    let mut post = make_frame(100, 100, [100, 100, 100]);
    paint_rect(&mut post, 0, 0, 100, 100, [103, 103, 103]);
    let low = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            pixel_threshold: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    let high = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            pixel_threshold: Some(30),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(low.changed_pixels > 0);
    assert_eq!(high.changed_pixels, 0);
}

#[test]
fn region_option_scopes_the_diff_to_the_area_around_the_click_target() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 0, 0, 30, 30, [255, 255, 255]);
    let full = verify_click_by_decoded_frames(&pre, &post, ClickVerifyOptions::default()).unwrap();
    let scoped = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            region: Some(Region {
                x: 90.0,
                y: 90.0,
                half_width: 5.0,
                half_height: 5.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(full.changed_fraction > 0.05);
    assert_eq!(scoped.changed_pixels, 0);
    assert!(!scoped.screen_changed);
}

#[test]
fn region_option_clamps_to_frame_bounds_near_the_edge() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 95, 95, 5, 5, [255, 255, 255]);
    let r = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            region: Some(Region {
                x: 99.0,
                y: 99.0,
                half_width: 50.0,
                half_height: 50.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(r.total_pixels <= 100 * 100);
    assert!(r.changed_pixels > 0);
}

#[test]
fn region_rect_a_small_dot_inside_the_expected_box_registers_as_changed() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 42, 42, 3, 3, [255, 255, 255]);
    let global =
        verify_click_by_decoded_frames(&pre, &post, ClickVerifyOptions::default()).unwrap();
    let scoped = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            region_rect: Some(RegionRect {
                x: 40.0,
                y: 40.0,
                width: 10.0,
                height: 10.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!global.screen_changed);
    assert_eq!(scoped.total_pixels, 100);
    assert_eq!(scoped.changed_pixels, 9);
    assert!(scoped.screen_changed);
}

#[test]
fn region_rect_the_same_dot_outside_the_expected_box_does_not_register() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 5, 5, 3, 3, [255, 255, 255]);
    let scoped = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            region_rect: Some(RegionRect {
                x: 40.0,
                y: 40.0,
                width: 10.0,
                height: 10.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(scoped.changed_pixels, 0);
    assert!(!scoped.screen_changed);
}

#[test]
fn region_rect_takes_precedence_over_the_target_centered_region() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 42, 42, 3, 3, [255, 255, 255]);
    let r = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            region: Some(Region {
                x: 90.0,
                y: 90.0,
                half_width: 5.0,
                half_height: 5.0,
            }),
            region_rect: Some(RegionRect {
                x: 40.0,
                y: 40.0,
                width: 10.0,
                height: 10.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(r.total_pixels, 100);
    assert_eq!(r.changed_pixels, 9);
    assert!(r.screen_changed);
}

#[test]
fn region_rect_clamps_to_frame_bounds_when_the_box_overruns_the_edge() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 95, 95, 5, 5, [255, 255, 255]);
    let r = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            region_rect: Some(RegionRect {
                x: 90.0,
                y: 90.0,
                width: 50.0,
                height: 50.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(r.total_pixels, 100);
    assert_eq!(r.changed_pixels, 25);
}

#[test]
fn region_rect_message_reports_the_roi_scope_not_the_full_screen() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 42, 42, 3, 3, [255, 255, 255]);
    let r = verify_click_by_decoded_frames(
        &pre,
        &post,
        ClickVerifyOptions {
            region_rect: Some(RegionRect {
                x: 40.0,
                y: 40.0,
                width: 10.0,
                height: 10.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(r.message(true, 0.005).contains("ROI"));
}

#[test]
fn throws_when_pre_and_post_screenshots_have_mismatched_dimensions() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let post = make_frame(200, 100, [0, 0, 0]);
    let err =
        verify_click_by_decoded_frames(&pre, &post, ClickVerifyOptions::default()).unwrap_err();
    let msg = err.to_string().to_lowercase();
    assert!(msg.contains("size") || msg.contains("dimension") || msg.contains("mismatch"));
}

#[test]
fn message_text_is_informative_for_screen_changed_true() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let mut post = make_frame(100, 100, [0, 0, 0]);
    paint_rect(&mut post, 0, 0, 50, 50, [255, 255, 255]);
    let r = verify_click_by_decoded_frames(&pre, &post, ClickVerifyOptions::default()).unwrap();
    assert!(r.screen_changed);
    let msg = r.message(false, 0.005).to_lowercase();
    assert!(msg.contains("changed") || msg.contains("landed") || msg.contains("triggered"));
}

#[test]
fn message_text_flags_suspected_miss_for_screen_changed_false() {
    let pre = make_frame(100, 100, [0, 0, 0]);
    let post = make_frame(100, 100, [0, 0, 0]);
    let r = verify_click_by_decoded_frames(&pre, &post, ClickVerifyOptions::default()).unwrap();
    assert!(!r.screen_changed);
    let msg = r.message(false, 0.005).to_lowercase();
    assert!(msg.contains("miss") || msg.contains("no") && msg.contains("change"));
}

// -- verify_click_by_diff (end-to-end via PNG decode) --

#[test]
fn decodes_png_buffers_and_reports_zero_change_for_identical_frames() {
    let pre = encode_png(50, 50, &vec![128u8; 50 * 50 * 3]);
    let post = encode_png(50, 50, &vec![128u8; 50 * 50 * 3]);
    let r = verify_click_by_diff(&pre, &post, ClickVerifyOptions::default()).unwrap();
    assert_eq!(r.changed_pixels, 0);
    assert!(!r.screen_changed);
}

#[test]
fn decodes_png_buffers_and_detects_screen_change_when_post_differs_significantly() {
    let mut post_frame = make_frame(50, 50, [0, 0, 0]);
    paint_rect(&mut post_frame, 5, 5, 20, 20, [255, 255, 255]);
    let pre = encode_png(50, 50, &vec![0u8; 50 * 50 * 3]);
    let post = encode_png(50, 50, &post_frame.rgb);
    let r = verify_click_by_diff(&pre, &post, ClickVerifyOptions::default()).unwrap();
    assert!(r.changed_pixels >= 400);
    assert!(r.screen_changed);
}

#[test]
fn rejects_mismatched_png_dimensions_with_a_clear_error() {
    let pre = encode_png(50, 50, &vec![0u8; 50 * 50 * 3]);
    let post = encode_png(60, 50, &vec![0u8; 60 * 50 * 3]);
    let err = verify_click_by_diff(&pre, &post, ClickVerifyOptions::default()).unwrap_err();
    let msg = err.to_string().to_lowercase();
    assert!(msg.contains("size") || msg.contains("dimension") || msg.contains("mismatch"));
}

#[test]
fn passes_options_through_to_the_decoded_frame_variant_region_scoping() {
    let mut post_frame = make_frame(50, 50, [0, 0, 0]);
    paint_rect(&mut post_frame, 0, 0, 20, 20, [255, 255, 255]);
    let pre = encode_png(50, 50, &vec![0u8; 50 * 50 * 3]);
    let post = encode_png(50, 50, &post_frame.rgb);
    let r = verify_click_by_diff(
        &pre,
        &post,
        ClickVerifyOptions {
            region: Some(Region {
                x: 45.0,
                y: 45.0,
                half_width: 4.0,
                half_height: 4.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(r.changed_pixels, 0);
    assert!(!r.screen_changed);
}

// -- is_screen_too_dim_for_cursor_detection / bias_corrected_aim_point /
// -- residual_for_skip: new-ground unit tests (no TS-side dedicated test
// -- file — click-at.test.ts exercises these only indirectly through the
// -- full clickAt() orchestration).

use pikvm_mcp_detection_vision::brightness::Severity;

#[test]
fn dim_gate_fires_only_on_very_dim_below_threshold() {
    assert!(is_screen_too_dim_for_cursor_detection(
        10.0,
        Severity::VeryDim,
        20.0
    ));
    assert!(!is_screen_too_dim_for_cursor_detection(
        10.0,
        Severity::Dim,
        20.0
    ));
    assert!(!is_screen_too_dim_for_cursor_detection(
        30.0,
        Severity::VeryDim,
        20.0
    ));
}

#[test]
fn bias_corrected_aim_point_shifts_y_down_by_the_tap_bias_magnitude() {
    let aim = bias_corrected_aim_point(Point { x: 100.0, y: 200.0 });
    assert_eq!(aim.x, 100.0);
    assert!((aim.y - 205.9).abs() < 1e-9);
}

#[test]
fn residual_for_skip_none_when_gate_is_disabled() {
    assert_eq!(
        residual_for_skip(Point { x: 0.0, y: 0.0 }, Point { x: 100.0, y: 100.0 }, None),
        None
    );
}

#[test]
fn residual_for_skip_none_when_within_gate() {
    assert_eq!(
        residual_for_skip(
            Point { x: 10.0, y: 0.0 },
            Point { x: 0.0, y: 0.0 },
            Some(15.0)
        ),
        None
    );
}

#[test]
fn residual_for_skip_some_when_beyond_gate() {
    let r = residual_for_skip(
        Point { x: 30.0, y: 40.0 },
        Point { x: 0.0, y: 0.0 },
        Some(15.0),
    );
    assert_eq!(r, Some(50.0));
}
