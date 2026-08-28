//! Auto-detect the iPad's region inside a PiKVM screenshot.
//!
//! Faithful port of `src/pikvm/ipad-region-detect.ts`.
//!
//! PiKVM's HDMI capture is letterboxed: the iPad's display occupies a
//! centered sub-rectangle of the 1920×1080 (or whatever the capture
//! resolution is) frame, with black bars around it. This function scans
//! column / row luminance to find where the black bars end and the iPad
//! content begins.
//!
//! Used by `bench-collect-synthetic.ts` for calibration: combined with the
//! iPad app's reported logical screen size, this gives an affine transform
//! from iPad-logical coordinates to PiKVM-screenshot pixel coordinates.

use image::GenericImageView;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IpadRegion {
    /// Top-left x in screenshot pixels.
    pub x: u32,
    /// Top-left y in screenshot pixels.
    pub y: u32,
    /// Width of the iPad region in screenshot pixels.
    pub w: u32,
    /// Height of the iPad region in screenshot pixels.
    pub h: u32,
    /// Width of the source screenshot in pixels.
    pub frame_w: u32,
    /// Height of the source screenshot in pixels.
    pub frame_h: u32,
}

const SCAN_WIDTH: u32 = 240;
/// mean RGB; below this is treated as black-bar. JPEG-compressed black
/// letterbox columns decode at ~16 luminance; real iPad content is 100+.
/// 40 leaves a comfortable gap between the two.
const BRIGHT_THRESHOLD: f32 = 40.0;
/// Bounds are inflated by this many native px on each side, mainly so a
/// cursor right at the iPad edge isn't clipped when extracted as a
/// template. Callers that need the *tight* content rect (e.g. building a
/// logical→screenshot transform for label coordinates) should subtract
/// this on each side.
pub const NATIVE_MARGIN: u32 = 6;
/// If detected region < 30% of frame area, assume detection failed.
const MIN_REGION_FRACTION: f64 = 0.3;

pub fn detect_ipad_region(screenshot_jpeg: &[u8]) -> anyhow::Result<IpadRegion> {
    let img = image::load_from_memory_with_format(screenshot_jpeg, image::ImageFormat::Jpeg)?;
    let (frame_w, frame_h) = img.dimensions();
    if frame_w == 0 || frame_h == 0 {
        anyhow::bail!("detect_ipad_region: screenshot has no dimensions");
    }

    // Downscale to a small RGB buffer for fast column/row scanning. The
    // tiny resolution is plenty to find dark/bright transitions and keeps
    // the inner loop cheap. Non-aspect-preserving resize (matches sharp's
    // `fit: 'fill'`) since we only care about per-axis bright/dark
    // transitions, not the aspect ratio of the thumbnail itself.
    let w = SCAN_WIDTH;
    let h = ((w as u64 * frame_h as u64) / frame_w as u64).max(1) as u32;
    let thumb = img
        .resize_exact(w, h, image::imageops::FilterType::Triangle)
        .to_rgb8();

    // Per-column and per-row average luminance.
    let mut col_bright = vec![0.0f32; w as usize];
    let mut row_bright = vec![0.0f32; h as usize];
    for y in 0..h {
        for x in 0..w {
            let p = thumb.get_pixel(x, y);
            let lum = (p[0] as f32 + p[1] as f32 + p[2] as f32) / 3.0;
            col_bright[x as usize] += lum;
            row_bright[y as usize] += lum;
        }
    }
    for v in col_bright.iter_mut() {
        *v /= h as f32;
    }
    for v in row_bright.iter_mut() {
        *v /= w as f32;
    }

    let first_bright =
        |arr: &[f32]| -> u32 { arr.iter().position(|&v| v > BRIGHT_THRESHOLD).unwrap_or(0) as u32 };
    let last_bright = |arr: &[f32]| -> u32 {
        arr.iter()
            .rposition(|&v| v > BRIGHT_THRESHOLD)
            .unwrap_or(arr.len().saturating_sub(1)) as u32
    };

    let x0 = first_bright(&col_bright);
    let x1 = last_bright(&col_bright);
    let y0 = first_bright(&row_bright);
    let y1 = last_bright(&row_bright);

    let sx = frame_w as f64 / w as f64;
    let sy = frame_h as f64 / h as f64;

    let region_x = ((x0 as f64 * sx).round() as i64 - NATIVE_MARGIN as i64).max(0) as u32;
    let region_y = ((y0 as f64 * sy).round() as i64 - NATIVE_MARGIN as i64).max(0) as u32;
    let region_w = (((x1 - x0 + 1) as f64 * sx).round() as u32 + 2 * NATIVE_MARGIN).min(frame_w);
    let region_h = (((y1 - y0 + 1) as f64 * sy).round() as u32 + 2 * NATIVE_MARGIN).min(frame_h);

    let region_area = (region_w as u64 * region_h as u64) as f64;
    let frame_area = (frame_w as u64 * frame_h as u64) as f64;
    if region_area < frame_area * MIN_REGION_FRACTION {
        // Almost-black frame or detection failed — fall back to full frame so
        // callers still get sensible coordinates.
        return Ok(IpadRegion {
            x: 0,
            y: 0,
            w: frame_w,
            h: frame_h,
            frame_w,
            frame_h,
        });
    }
    Ok(IpadRegion {
        x: region_x,
        y: region_y,
        w: region_w,
        h: region_h,
        frame_w,
        frame_h,
    })
}

/// Affine transform from iPad-logical-points to PiKVM-screenshot pixels.
/// The iPad app reports cursor positions in its logical coordinate space;
/// the screenshot stores them centered inside the detected iPad region.
pub struct LogicalToScreenshot {
    pub region: IpadRegion,
    pub logical_w: f64,
    pub logical_h: f64,
    scale_x: f64,
    scale_y: f64,
}

impl LogicalToScreenshot {
    pub fn to_screenshot_px(&self, logical_x: f64, logical_y: f64) -> (f64, f64) {
        (
            self.region.x as f64 + logical_x * self.scale_x,
            self.region.y as f64 + logical_y * self.scale_y,
        )
    }
}

pub fn build_transform(
    region: IpadRegion,
    logical_w: f64,
    logical_h: f64,
) -> anyhow::Result<LogicalToScreenshot> {
    if logical_w <= 0.0 || logical_h <= 0.0 {
        anyhow::bail!("build_transform: invalid logical size {logical_w}×{logical_h}");
    }
    let scale_x = region.w as f64 / logical_w;
    let scale_y = region.h as f64 / logical_h;
    Ok(LogicalToScreenshot {
        region,
        logical_w,
        logical_h,
        scale_x,
        scale_y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn raw_to_jpeg(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(width, height, |x, y| Rgb(pixel(x, y)));
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        // quality 90, matching the TS test's sharp(...).jpeg({ quality: 90 }).
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
        encoder.encode_image(&img).unwrap();
        buf
    }

    /// Build a frame with bright content in [x0,x1)×[y0,y1) and black
    /// letterbox bars everywhere else.
    fn letterbox_jpeg(
        frame_w: u32,
        frame_h: u32,
        x0: u32,
        x1: u32,
        y0: u32,
        y1: u32,
        bright: u8,
    ) -> Vec<u8> {
        raw_to_jpeg(frame_w, frame_h, |x, y| {
            if x >= x0 && x < x1 && y >= y0 && y < y1 {
                [bright, bright, bright]
            } else {
                [0, 0, 0]
            }
        })
    }

    #[test]
    fn build_transform_identity_full_frame_region_maps_corners_1_to_1() {
        let region = IpadRegion {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
            frame_w: 1920,
            frame_h: 1080,
        };
        let t = build_transform(region, 1920.0, 1080.0).unwrap();

        let origin = t.to_screenshot_px(0.0, 0.0);
        assert_eq!(origin, (0.0, 0.0));

        let corner = t.to_screenshot_px(1920.0, 1080.0);
        assert_eq!(corner, (1920.0, 1080.0));

        let mid = t.to_screenshot_px(960.0, 540.0);
        assert_eq!(mid, (960.0, 540.0));
    }

    #[test]
    fn build_transform_letterboxed_region_scales_by_region_over_logical_ratio() {
        let region = IpadRegion {
            x: 610,
            y: 50,
            w: 692,
            h: 980,
            frame_w: 1920,
            frame_h: 1080,
        };
        let logical_w = 820.0;
        let logical_h = 1180.0;
        let t = build_transform(region, logical_w, logical_h).unwrap();

        let origin = t.to_screenshot_px(0.0, 0.0);
        assert_eq!(origin, (region.x as f64, region.y as f64));

        let scale_x = region.w as f64 / logical_w;
        let scale_y = region.h as f64 / logical_h;
        let one_one = t.to_screenshot_px(1.0, 1.0);
        assert!((one_one.0 - (region.x as f64 + scale_x)).abs() < 1e-6);
        assert!((one_one.1 - (region.y as f64 + scale_y)).abs() < 1e-6);

        let center = t.to_screenshot_px(logical_w / 2.0, logical_h / 2.0);
        assert!((center.0 - (region.x as f64 + region.w as f64 / 2.0)).abs() < 1e-6);
        assert!((center.1 - (region.y as f64 + region.h as f64 / 2.0)).abs() < 1e-6);

        let far = t.to_screenshot_px(logical_w, logical_h);
        assert!((far.0 - (region.x as f64 + region.w as f64)).abs() < 1e-6);
        assert!((far.1 - (region.y as f64 + region.h as f64)).abs() < 1e-6);
    }

    #[test]
    fn build_transform_rejects_non_positive_logical_size() {
        let region = IpadRegion {
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            frame_w: 100,
            frame_h: 100,
        };
        assert!(build_transform(region, 0.0, 100.0).is_err());
        assert!(build_transform(region, -1.0, 100.0).is_err());
        assert!(build_transform(region, 100.0, 0.0).is_err());
        assert!(build_transform(region, 100.0, -1.0).is_err());
    }

    #[test]
    fn detect_ipad_region_locates_content_rectangle_inside_letterbox_bars() {
        // Bright content in [500,1400) × [100,980); black bars elsewhere.
        let jpeg = letterbox_jpeg(1920, 1080, 500, 1400, 100, 980, 200);
        let region = detect_ipad_region(&jpeg).unwrap();

        assert_eq!(region.frame_w, 1920);
        assert_eq!(region.frame_h, 1080);

        // Detector inflates by NATIVE_MARGIN on each side, then rounds via a
        // 240-wide downscaled scan, so allow a few px of slop (within ±5, same
        // as the TS test's toBeCloseTo(_, -1)).
        let close = |a: i64, b: i64| (a - b).abs() <= 5;
        assert!(close(region.x as i64, 500 - NATIVE_MARGIN as i64));
        assert!(close(
            (region.x + region.w) as i64,
            1400 + NATIVE_MARGIN as i64
        ));
        assert!(close(region.y as i64, 100 - NATIVE_MARGIN as i64));
        assert!(close(
            (region.y + region.h) as i64,
            980 + NATIVE_MARGIN as i64
        ));
    }

    #[test]
    fn detect_ipad_region_falls_back_to_full_frame_on_uniformly_black_image() {
        let jpeg = raw_to_jpeg(1920, 1080, |_, _| [0, 0, 0]);
        let region = detect_ipad_region(&jpeg).unwrap();
        assert_eq!(
            region,
            IpadRegion {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
                frame_w: 1920,
                frame_h: 1080
            }
        );
    }

    #[test]
    fn native_margin_is_6px_regression_guard_against_silent_retunes() {
        // Callers that need the *tight* content rect subtract this on each
        // side; changing it without updating those callers will silently
        // shift every label coordinate.
        assert_eq!(NATIVE_MARGIN, 6);
    }
}
