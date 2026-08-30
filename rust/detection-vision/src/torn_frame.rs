//! Detect a torn/corrupted streamer capture frame (flood-fill placeholder
//! regions from a mid-transition or partial-decode glitch), so it can be
//! retried before ever reaching a human confirmation step.
//!
//! See `docs/torn-frame-detection-plan.md` for the real, measured evidence
//! behind this design (2026-08-30) and nixos-dev's review.
//!
//! Live-confirmed twice this session (`cursor_anchor_corner_control_smoke.rs`
//! confirmation step, ~07:01 and ~07:04): a real torn frame — a flood-filled
//! placeholder colour and/or black bars replacing part or all of the real
//! content — while the underlying device state was fine (a follow-up
//! screenshot moments later showed a clean, genuine lock screen). The human
//! veto correctly caught both, but relying on that alone wastes the whole
//! confirm window on an unjudgeable frame.

use crate::brightness::Region;

#[derive(Clone, Debug, PartialEq)]
pub struct TornFrameReport {
    /// Fraction of rows (within the analysed region) where every pixel is
    /// byte-identical to the row's first pixel.
    pub uniform_row_fraction: f64,
    pub is_torn: bool,
}

/// Calibration (2026-08-30, tight-region-cropped, see the plan doc):
///  - clean home screen + clean pre-lock baseline: 1.5% uniform rows
///    (14/956), both STATIC captures (not mid-transition).
///  - one real torn confirmation frame (flood-fill green + black bars):
///    22.4% (214/956).
///
/// nixos-dev review: the two clean samples were both settled/static shots,
/// not the screen-just-woke moment this check actually runs at (more likely
/// to carry some transitional artifact) — start conservative, near the
/// geometric mean of the two data points (~5.8%) rather than the midpoint
/// biased toward the clean end. 6% leaves a ~2.5x margin above the clean
/// samples and a ~3.7x margin below the one torn sample. Treat as a
/// starting point, not a final calibration — `uniform_row_fraction` is
/// always returned (not just the boolean), so real-world runs accumulate
/// more data points before this is retuned.
pub const UNIFORM_ROW_FRACTION_THRESHOLD: f64 = 0.06;

#[derive(Clone, Copy, Debug, Default)]
pub struct AnalyzeTornFrameOptions {
    /// Restrict the analysis to a region of the frame — required for a
    /// meaningful result. The full HDMI frame is majority black letterbox
    /// even on a clean capture (measured ~63% on this rig), which would
    /// swamp the signal; callers should pass the actual freshly-detected
    /// iPad content bounds (e.g. `orientation::detect_ipad_bounds_from_buffer`)
    /// rather than a hardcoded rectangle, since per-frame bounds do drift
    /// (auto_crop.rs's own calibration work measured up to ~4.6% edge-delta
    /// across captures).
    pub region: Option<Region>,
}

/// Analyse a JPEG/PNG buffer for a torn/flood-fill capture artifact.
pub fn analyze_torn_frame(
    buffer: &[u8],
    options: AnalyzeTornFrameOptions,
) -> anyhow::Result<TornFrameReport> {
    let img = image::load_from_memory(buffer)?;
    let cropped;
    let view = if let Some(r) = options.region {
        cropped = img.crop_imm(r.x, r.y, r.width, r.height);
        &cropped
    } else {
        &img
    };
    let rgb = view.to_rgb8();
    let (width, height) = (rgb.width(), rgb.height());
    if height == 0 || width == 0 {
        anyhow::bail!("torn-frame: empty region, 0 pixels");
    }

    let mut uniform_rows = 0u32;
    for y in 0..height {
        let first = rgb.get_pixel(0, y);
        let row_uniform = (1..width).all(|x| rgb.get_pixel(x, y) == first);
        if row_uniform {
            uniform_rows += 1;
        }
    }
    let uniform_row_fraction = uniform_rows as f64 / height as f64;

    Ok(TornFrameReport {
        uniform_row_fraction,
        is_torn: uniform_row_fraction >= UNIFORM_ROW_FRACTION_THRESHOLD,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn encode_jpeg(img: &ImageBuffer<Rgb<u8>, Vec<u8>>) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
        encoder.encode_image(img).unwrap();
        buf
    }

    fn uniform_jpeg(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(width, height, Rgb(rgb));
        encode_jpeg(&img)
    }

    /// Deterministic pseudo-noise (no real content/gradient needed — just
    /// enough per-pixel variation that no row is uniform), standing in for
    /// legitimate frame content.
    fn noisy_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, |x, y| {
            let v = ((x * 37 + y * 91) % 251) as u8;
            Rgb([v, v.wrapping_add(40), v.wrapping_add(80)])
        });
        encode_jpeg(&img)
    }

    /// Half real noise, half flood-filled — approximates the real torn
    /// sample's shape (partial correct content + a flood-fill band).
    fn half_flood_filled_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, |x, y| {
            if y < height / 2 {
                let v = ((x * 37 + y * 91) % 251) as u8;
                Rgb([v, v.wrapping_add(40), v.wrapping_add(80)])
            } else {
                Rgb([0, 136, 0]) // the real sample's flood-fill green
            }
        });
        encode_jpeg(&img)
    }

    #[test]
    fn uniform_solid_frame_is_torn() {
        let buf = uniform_jpeg(64, 64, [0, 136, 0]);
        let report = analyze_torn_frame(&buf, AnalyzeTornFrameOptions::default()).unwrap();
        assert!(report.uniform_row_fraction > 0.9);
        assert!(report.is_torn);
    }

    #[test]
    fn noisy_frame_is_not_torn() {
        let buf = noisy_jpeg(64, 64);
        let report = analyze_torn_frame(&buf, AnalyzeTornFrameOptions::default()).unwrap();
        assert!(report.uniform_row_fraction < UNIFORM_ROW_FRACTION_THRESHOLD);
        assert!(!report.is_torn);
    }

    #[test]
    fn half_flood_filled_frame_is_torn() {
        let buf = half_flood_filled_jpeg(64, 64);
        let report = analyze_torn_frame(&buf, AnalyzeTornFrameOptions::default()).unwrap();
        // Half the rows (the flood-filled half) are uniform — well above
        // threshold regardless of the noisy half's exact behaviour.
        assert!(report.uniform_row_fraction >= 0.4);
        assert!(report.is_torn);
    }

    #[test]
    fn region_option_restricts_the_analysis() {
        // Noisy content in the top half, solid fill in the bottom half —
        // analysing only the top region should NOT flag torn.
        let buf = half_flood_filled_jpeg(64, 64);
        let report = analyze_torn_frame(
            &buf,
            AnalyzeTornFrameOptions {
                region: Some(Region {
                    x: 0,
                    y: 0,
                    width: 64,
                    height: 30,
                }),
            },
        )
        .unwrap();
        assert!(!report.is_torn);
    }

    #[test]
    fn empty_region_is_an_error() {
        let buf = noisy_jpeg(64, 64);
        let err = analyze_torn_frame(
            &buf,
            AnalyzeTornFrameOptions {
                region: Some(Region {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                }),
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("empty region"));
    }
}
