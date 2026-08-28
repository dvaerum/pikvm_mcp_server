//! Screen brightness analysis for cursor-detection diagnostics.
//!
//! Faithful port of `src/pikvm/brightness.ts`.
//!
//! iPadOS auto-dims the display after inactivity. On a dim frame, cursor
//! pixels can fall below the cursor-detection brightness floor (100), which
//! makes every locateCursor probe fail. Surfacing the average brightness in
//! `pikvm_health_check` (and elsewhere) lets the operator notice this BEFORE
//! wasting retry attempts.
//!
//! Pure functions live here so tests can pin the threshold logic without
//! spinning up the MCP handler.
//!
//! Phase 37 (v0.5.22, 2026-04-26).

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Severity {
    Normal,
    Dim,
    VeryDim,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrightnessReport {
    /// Mean of (channel-mean-R + channel-mean-G + channel-mean-B) / 3, in
    /// [0, 255]. Approximates luminance without paying for a colourspace
    /// conversion.
    pub mean: f64,
    pub mean_r: f64,
    pub mean_g: f64,
    pub mean_b: f64,
    /// Mean of per-channel stddev across R,G,B. High stddev means the frame
    /// has BOTH bright and dark pixels (cursor will be detectable against
    /// the contrast). Low stddev means uniform brightness. Phase 48: stddev
    /// is a better gate than mean for dark-mode UI, where mean is low
    /// (~20) but UI text/icons provide enough contrast for cursor
    /// detection.
    pub stddev: f64,
    pub severity: Severity,
    /// 2026-05-27: iPad auto-brightness does NOT affect the HDMI mirror —
    /// HDMI brightness is determined entirely by iPad UI state. When this
    /// is true (severity == VeryDim), the iPad almost certainly has a
    /// modal/permission/security prompt up, and automation cannot proceed
    /// until a human dismisses it on the device itself.
    pub ipad_display_blocked: bool,
    /// Operator-facing one-liner with recovery guidance. Empty string when
    /// severity is Normal.
    pub hint: String,
}

/// Phase 48 (v0.5.36, 2026-04-26): switch from mean-based to stddev-based
/// gating because dark-mode iPad apps (Settings, Files in dark mode, etc.)
/// legitimately have low mean (~20/255) but are NOT a problem for cursor
/// detection — the cursor pixels (~150-200) contrast against the dark
/// background, producing high local stddev and clear motion-diff clusters.
///
/// Calibration data points (2026-04-26, iPad-content region only):
///  - mean=20, stddev<2:  Settings dark mode (cursor detectable, gate
///    should NOT fire — but mean<35 fired Phase 38 false-positively).
///  - mean=29, stddev<2:  hidden security popup with darkening overlay
///    (cursor detection broken — gate SHOULD fire).
///  - mean=41, stddev>5:  bright home screen with dark wallpaper (cursor
///    detectable, gate should NOT fire).
///
/// The discriminator is stddev, NOT mean. Low stddev = uniform low-contrast
/// surface = cursor blends in.
pub const VERY_DIM_THRESHOLD: f64 = 35.0;
/// Threshold below which cursor detection is intermittently unreliable.
pub const DIM_THRESHOLD: f64 = 60.0;
/// Minimum stddev (mean across RGB channels) for the frame to be considered
/// to have enough internal contrast for cursor detection. Calibrated
/// against Phase 48 live data points (popup overlay at stddev<2; dark-mode
/// UI at stddev>5).
pub const MIN_STDDEV_FOR_CONTRAST: f64 = 3.0;

pub struct BrightnessClass {
    pub severity: Severity,
    pub hint: String,
}

/// Bucket the brightness reading into Normal / Dim / VeryDim. Pure
/// function; test inputs directly.
///
/// Phase 48: takes BOTH mean and stddev. A frame is only flagged as
/// very-dim if mean is low AND stddev is also low (uniform dark surface).
/// Dark-mode UI has low mean but high stddev (text/icon contrast), so
/// passes the gate. `stddev` defaults to 100 (high contrast) matching the
/// TS default parameter, for callers that only care about mean.
pub fn classify_brightness(mean: f64, stddev: f64) -> BrightnessClass {
    // Phase 48: high contrast (stddev) means cursor is detectable regardless
    // of mean luminance — dark-mode UI passes here.
    if stddev >= MIN_STDDEV_FOR_CONTRAST && mean < VERY_DIM_THRESHOLD {
        // Borderline: low mean but contrast present. Soft warning only.
        return BrightnessClass {
            severity: Severity::Dim,
            hint: " ⚠ DIM (low mean, but contrast present — likely dark-mode UI). \
                   Cursor detection should still work; if it fails, raise concern."
                .to_string(),
        };
    }
    if mean < VERY_DIM_THRESHOLD && stddev < MIN_STDDEV_FOR_CONTRAST {
        return BrightnessClass {
            severity: Severity::VeryDim,
            hint: " ⚠ VERY DIM — iPad DISPLAY BLOCKED (uniform dark frame in HDMI capture). \
                   2026-05-27 finding: iPad auto-brightness does NOT affect the HDMI \
                   mirror, so a dim HDMI capture means an iOS modal/permission/security \
                   prompt is dimming the screen. AUTOMATION CANNOT PROCEED until a human \
                   dismisses the prompt physically on the iPad. The prompt is usually \
                   fully visible to the human at the device even when HDMI looks dark. \
                   Try-before-escalating: pikvm_key Escape, then Enter, then \
                   pikvm_shortcut Cmd+Period; these dismiss SOME modals. If none work, \
                   a human at the iPad must tap \"Not Now\" / \"Cancel\" / Touch ID."
                .to_string(),
        };
    }
    if mean < DIM_THRESHOLD {
        return BrightnessClass {
            severity: Severity::Dim,
            hint: " ⚠ DIM — cursor detection may fail intermittently. Likely a \
                   partially-transparent overlay in front of the screen (notification \
                   banner, partially-pulled Control Center, etc.) — auto-brightness \
                   does not affect HDMI, so this is a UI-state signal, not ambient light."
                .to_string(),
        };
    }
    BrightnessClass {
        severity: Severity::Normal,
        hint: String::new(),
    }
}

/// Convenience matching the TS default parameter (`stddev: number = 100`).
pub fn classify_brightness_mean_only(mean: f64) -> BrightnessClass {
    classify_brightness(mean, 100.0)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct AnalyzeBrightnessOptions {
    /// Restrict the brightness calculation to a region of the frame.
    /// Critical on iPad-portrait deployments where the HDMI frame includes
    /// ~67% black letterbox bars — computing mean over the full frame
    /// misclassifies a fully-bright iPad as VERY DIM (live-verified
    /// 2026-04-26). Pass the detected iPad bounds here so the report
    /// reflects actual display brightness, not the geometric framing of
    /// the capture.
    pub region: Option<Region>,
}

#[derive(Clone, Copy, Debug)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Compute brightness report for a JPEG/PNG buffer.
///
/// When `options.region` is supplied, the calculation is restricted to that
/// rectangle. Without it, the full frame is analysed.
pub fn analyze_brightness(
    buffer: &[u8],
    options: AnalyzeBrightnessOptions,
) -> anyhow::Result<BrightnessReport> {
    let img = image::load_from_memory(buffer)?;
    let cropped;
    let view = if let Some(r) = options.region {
        cropped = img.crop_imm(r.x, r.y, r.width, r.height);
        &cropped
    } else {
        &img
    };
    let rgb = view.to_rgb8();
    let n = (rgb.width() as u64 * rgb.height() as u64) as f64;
    if n == 0.0 {
        anyhow::bail!("brightness: empty region, 0 pixels");
    }

    let mut sum = [0f64; 3];
    for p in rgb.pixels() {
        sum[0] += p[0] as f64;
        sum[1] += p[1] as f64;
        sum[2] += p[2] as f64;
    }
    let mean_ch = [sum[0] / n, sum[1] / n, sum[2] / n];

    let mut sq_diff = [0f64; 3];
    for p in rgb.pixels() {
        for c in 0..3 {
            let d = p[c] as f64 - mean_ch[c];
            sq_diff[c] += d * d;
        }
    }
    // Population stddev (divide by N), matching sharp/libvips's stats().
    let stdev_ch = [
        (sq_diff[0] / n).sqrt(),
        (sq_diff[1] / n).sqrt(),
        (sq_diff[2] / n).sqrt(),
    ];

    let mean_r = mean_ch[0];
    let mean_g = mean_ch[1];
    let mean_b = mean_ch[2];
    let mean = (mean_r + mean_g + mean_b) / 3.0;
    // Phase 48: stddev across R,G,B.
    let stddev = (stdev_ch[0] + stdev_ch[1] + stdev_ch[2]) / 3.0;
    let class = classify_brightness(mean, stddev);
    Ok(BrightnessReport {
        mean,
        mean_r,
        mean_g,
        mean_b,
        stddev,
        severity: class.severity,
        ipad_display_blocked: class.severity == Severity::VeryDim,
        hint: class.hint,
    })
}

/// Format a brightness report as a single line for operator output.
pub fn format_brightness_report(report: &BrightnessReport) -> String {
    let blocked = if report.ipad_display_blocked {
        " iPadDisplayBlocked: yes."
    } else {
        ""
    };
    format!(
        "Screen brightness: mean={:.0}/255, stddev={:.1} (R={:.0}, G={:.0}, B={:.0}).{}{}",
        report.mean,
        report.stddev,
        report.mean_r,
        report.mean_g,
        report.mean_b,
        blocked,
        report.hint
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn uniform_jpeg(width: u32, height: u32, gray: u8) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(width, height, Rgb([gray, gray, gray]));
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
        encoder.encode_image(&img).unwrap();
        buf
    }

    #[test]
    fn classify_very_dim_below_threshold_when_stddev_also_low() {
        let r = classify_brightness(VERY_DIM_THRESHOLD - 10.0, 1.0);
        assert_eq!(r.severity, Severity::VeryDim);
        assert!(r.hint.contains("VERY DIM"));
        assert!(
            r.hint.to_lowercase().contains("uniform dark")
                || r.hint.to_lowercase().contains("security")
        );
        assert!(r.hint.contains("Escape") || r.hint.to_lowercase().contains("auto-brightness"));
    }

    #[test]
    fn classify_low_mean_high_stddev_is_dim_not_very_dim_dark_mode_ui() {
        let r = classify_brightness(VERY_DIM_THRESHOLD - 10.0, 5.0);
        assert_eq!(r.severity, Severity::Dim);
        assert!(!r.hint.contains("VERY DIM"));
        assert!(
            r.hint.to_lowercase().contains("contrast present")
                || r.hint.to_lowercase().contains("dark-mode")
        );
    }

    #[test]
    fn classify_dim_between_very_dim_and_dim_threshold() {
        let r = classify_brightness_mean_only((VERY_DIM_THRESHOLD + DIM_THRESHOLD) / 2.0);
        assert_eq!(r.severity, Severity::Dim);
        assert!(r.hint.contains("⚠ DIM"));
        assert!(!r.hint.contains("VERY DIM"));
    }

    #[test]
    fn classify_normal_at_and_above_dim_threshold() {
        assert_eq!(
            classify_brightness_mean_only(DIM_THRESHOLD).severity,
            Severity::Normal
        );
        assert_eq!(classify_brightness_mean_only(DIM_THRESHOLD).hint, "");
        assert_eq!(
            classify_brightness_mean_only(200.0).severity,
            Severity::Normal
        );
        assert_eq!(classify_brightness_mean_only(200.0).hint, "");
    }

    #[test]
    fn classify_boundary_just_below_very_dim_with_low_stddev_is_very_dim() {
        assert_eq!(
            classify_brightness(VERY_DIM_THRESHOLD - 0.1, 1.0).severity,
            Severity::VeryDim
        );
    }

    #[test]
    fn classify_boundary_just_below_dim_is_dim_not_very_dim() {
        assert_eq!(
            classify_brightness_mean_only(DIM_THRESHOLD - 0.1).severity,
            Severity::Dim
        );
    }

    #[test]
    fn analyze_reports_very_dim_for_uniform_black_ish_frame() {
        let buf = uniform_jpeg(200, 200, 30);
        let report = analyze_brightness(&buf, AnalyzeBrightnessOptions::default()).unwrap();
        assert!(report.mean >= 20.0);
        assert!(report.mean < VERY_DIM_THRESHOLD);
        assert_eq!(report.severity, Severity::VeryDim);
        assert!(report.hint.contains("VERY DIM"));
    }

    #[test]
    fn analyze_reports_dim_for_mid_low_luminance_frame() {
        let buf = uniform_jpeg(200, 200, 45);
        let report = analyze_brightness(&buf, AnalyzeBrightnessOptions::default()).unwrap();
        assert_eq!(report.severity, Severity::Dim);
        assert!(report.hint.contains("⚠ DIM"));
    }

    #[test]
    fn analyze_reports_normal_for_well_lit_frame() {
        let buf = uniform_jpeg(200, 200, 180);
        let report = analyze_brightness(&buf, AnalyzeBrightnessOptions::default()).unwrap();
        assert_eq!(report.severity, Severity::Normal);
        assert_eq!(report.hint, "");
    }

    #[test]
    fn analyze_per_channel_means_are_populated() {
        let buf = uniform_jpeg(100, 100, 100);
        let report = analyze_brightness(&buf, AnalyzeBrightnessOptions::default()).unwrap();
        assert!(report.mean_r > 0.0);
        assert!(report.mean_g > 0.0);
        assert!(report.mean_b > 0.0);
    }

    #[test]
    fn format_includes_mean_stddev_per_channel_and_hint_when_present() {
        let report = BrightnessReport {
            mean: 40.0,
            mean_r: 38.0,
            mean_g: 42.0,
            mean_b: 40.0,
            stddev: 1.5,
            severity: Severity::VeryDim,
            ipad_display_blocked: true,
            hint: " ⚠ VERY DIM — wake the screen.".to_string(),
        };
        let line = format_brightness_report(&report);
        assert!(line.contains("Screen brightness"));
        assert!(line.contains("mean=40/255"));
        assert!(line.contains("stddev=1.5"));
        assert!(line.contains("R=38"));
        assert!(line.contains("G=42"));
        assert!(line.contains("B=40"));
        assert!(line.contains("VERY DIM"));
    }

    #[test]
    fn format_omits_hint_visually_when_severity_is_normal() {
        let report = BrightnessReport {
            mean: 150.0,
            mean_r: 150.0,
            mean_g: 150.0,
            mean_b: 150.0,
            stddev: 50.0,
            severity: Severity::Normal,
            ipad_display_blocked: false,
            hint: String::new(),
        };
        let line = format_brightness_report(&report);
        assert!(line.contains("Screen brightness"));
        assert!(!line.contains('⚠'));
        assert!(!line.contains("DIM"));
    }
}
