//! Characterise "always-animating" regions (clock widgets, weather
//! tickers, pointer-trail fades, etc.) so measurement diffs can filter
//! them out. Faithful port of `captureNoiseBaseline`/`filterOutNoise`.

use pikvm_mcp_detection_vision::cursor_detect::{diff_screenshots, Cluster, DetectionConfig};
use pikvm_mcp_kvmd_client::client::{ClientError, PiKVMClient};

use super::capture::take_raw_screenshot;
use super::types::{NoiseBaseline, NoiseCentroid};

#[derive(Debug, Clone)]
pub struct CaptureNoiseBaselineOptions {
    pub frames: u32,
    pub interval_ms: u64,
    pub detection: DetectionConfig,
    pub verbose: bool,
}

impl Default for CaptureNoiseBaselineOptions {
    fn default() -> Self {
        Self {
            frames: 4,
            interval_ms: 500,
            detection: DetectionConfig::default(),
            verbose: false,
        }
    }
}

/// Take several screenshots with NO mouse input and diff consecutive
/// pairs. Anything that consistently shows up is background noise, not
/// the cursor.
pub async fn capture_noise_baseline(
    client: &PiKVMClient,
    options: CaptureNoiseBaselineOptions,
) -> Result<NoiseBaseline, ClientError> {
    let mut shots: Vec<Vec<u8>> = Vec::with_capacity(options.frames as usize);
    for i in 0..options.frames {
        shots.push(take_raw_screenshot(client).await?);
        if i + 1 < options.frames {
            tokio::time::sleep(std::time::Duration::from_millis(options.interval_ms)).await;
        }
    }

    // Collect every cluster from every consecutive diff. A dimension
    // mismatch between frames is ignored — we'll still have some data.
    let mut all: Vec<Cluster> = Vec::new();
    for pair in shots.windows(2) {
        if let Ok(clusters) = diff_screenshots(&pair[0], &pair[1], &options.detection) {
            all.extend(clusters);
        }
    }

    // Deduplicate: any cluster whose centroid is within mergeRadius of
    // another collapses into a single noise centroid (max size seen).
    let radius = options.detection.merge_radius;
    let mut deduped: Vec<NoiseCentroid> = Vec::new();
    for c in &all {
        let existing = deduped.iter_mut().find(|d| {
            let dx = (d.x - c.centroid_x) as f64;
            let dy = (d.y - c.centroid_y) as f64;
            (dx * dx + dy * dy).sqrt() <= radius
        });
        match existing {
            Some(d) => d.size = d.size.max(c.pixels),
            None => deduped.push(NoiseCentroid {
                x: c.centroid_x,
                y: c.centroid_y,
                size: c.pixels,
            }),
        }
    }

    if options.verbose {
        eprintln!(
            "[noise-baseline] {} persistent regions from {} frames:",
            deduped.len(),
            options.frames
        );
        let mut top = deduped.clone();
        top.sort_by_key(|d| std::cmp::Reverse(d.size));
        for d in top.iter().take(8) {
            eprintln!("  ({},{}) size={}px", d.x, d.y, d.size);
        }
    }

    Ok(NoiseBaseline {
        centroids: deduped,
        frames: options.frames,
    })
}

/// Reject clusters that overlap known noise regions. This is a hard
/// filter: if the cursor happens to be over a noise region (e.g. a clock
/// widget), we'd rather lose that sample than mistake the widget's
/// animation for the cursor. With multi-axis sampling across several
/// reps, we have enough other samples to get a reliable median.
pub fn filter_out_noise(
    clusters: Vec<Cluster>,
    noise: Option<&NoiseBaseline>,
    exclude_radius: f64,
) -> Vec<Cluster> {
    let Some(noise) = noise else {
        return clusters;
    };
    if noise.centroids.is_empty() {
        return clusters;
    }
    clusters
        .into_iter()
        .filter(|c| {
            !noise.centroids.iter().any(|n| {
                let dx = (n.x - c.centroid_x) as f64;
                let dy = (n.y - c.centroid_y) as f64;
                (dx * dx + dy * dy).sqrt() <= exclude_radius
            })
        })
        .collect()
}
