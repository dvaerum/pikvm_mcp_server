//! Empirical calibration for the auto-crop design's dual-detector
//! agreement tolerance (task_f04c3909db11) — measures how much
//! `orientation::detect_ipad_bounds_from_buffer` (full-res scan) and
//! `ipad_region_detect::detect_ipad_region` (240px-downscale) actually
//! disagree on REAL captured frames already committed to this repo, per
//! the project's own "prove it before committing" discipline (the
//! reviewer's pushback on the design's first-draft 5% guess — see the
//! task's own notes 44/45).
//!
//! This is a one-off measurement tool, not a smoke test — no hardware
//! needed, it runs entirely against the real frames already checked into
//! `data/` and `benches/fixtures/` from prior real-hardware sessions.
//!
//! **Real bug found while building this**: `detect_ipad_bounds_from_buffer`
//! caches its last SANE detection process-wide and falls back to it when
//! a later frame's own detection looks aspect-insane. Measuring many
//! frames in one process without clearing that cache between them means
//! a later frame's "bounds" can silently be an EARLIER frame's cached
//! value, not its own detection — this script explicitly
//! `clear_orientation_cache()`s before every single frame so each
//! measurement reflects that frame in isolation (the same cold-cache
//! condition a real first-call `pikvm_screenshot` sees), not a
//! best-case warm cache carried over from whatever frame happened to
//! sort before it alphabetically.
//!
//! Run: cargo run -p pikvm-mcp-detection-vision --example calibrate_crop_tolerance

use pikvm_mcp_detection_vision::ipad_region_detect::detect_ipad_region;
use pikvm_mcp_detection_vision::orientation::{
    clear_orientation_cache, detect_ipad_bounds_from_buffer, DetectOptions,
};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .canonicalize()
        .expect("repo root should exist two levels up from this crate")
}

fn find_jpegs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            find_jpegs(&path, out);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
                out.push(path);
            }
        }
    }
}

struct Deltas {
    left_frac: f64,
    top_frac: f64,
    right_frac: f64,
    bottom_frac: f64,
}

fn main() {
    let root = repo_root();
    let mut frames = Vec::new();
    for dir in ["data", "benches/fixtures"] {
        find_jpegs(&root.join(dir), &mut frames);
    }
    frames.sort();
    if frames.is_empty() {
        eprintln!("FAILED: no .jpg/.jpeg frames found under {}/{{data,benches/fixtures}} — nothing to calibrate against", root.display());
        std::process::exit(1);
    }
    eprintln!(
        "found {} real captured frames to measure against",
        frames.len()
    );

    let mut all_deltas: Vec<(std::path::PathBuf, Deltas)> = Vec::new();
    let mut skipped = 0usize;
    let mut region_fallback_count = 0usize;

    for path in &frames {
        // Every frame measured in isolation — see this file's header on
        // why a warm cache from a PRIOR frame in this loop would silently
        // contaminate this one's result.
        clear_orientation_cache();
        let Ok(buf) = std::fs::read(path) else {
            skipped += 1;
            continue;
        };
        let bounds = match detect_ipad_bounds_from_buffer(&buf, DetectOptions::default()) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("skip {}: full-res detector errored: {e}", path.display());
                skipped += 1;
                continue;
            }
        };
        let region = match detect_ipad_region(&buf) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("skip {}: downscaled detector errored: {e}", path.display());
                skipped += 1;
                continue;
            }
        };
        if bounds.resolution.0 != region.frame_w || bounds.resolution.1 != region.frame_h {
            eprintln!(
                "skip {}: detectors disagreed on FRAME dimensions ({}x{} vs {}x{}) — shouldn't happen, both decode the same buffer",
                path.display(),
                bounds.resolution.0,
                bounds.resolution.1,
                region.frame_w,
                region.frame_h
            );
            skipped += 1;
            continue;
        }
        let frame_w = bounds.resolution.0 as f64;
        let frame_h = bounds.resolution.1 as f64;
        // `detect_ipad_region` falls back to the FULL FRAME when its own
        // <30%-of-frame-area heuristic fires (its documented "detection
        // failed" signal, not a real sub-frame region) — treating that as
        // "disagreement" would make cross-validation fail on every frame
        // where the SECONDARY detector merely had no opinion, not on
        // frames where the two detectors actually disagree about content
        // vs. letterbox. Skip these from the edge-delta comparison
        // (real finding from running this against the actual corpus —
        // not assumed up front) and count them separately.
        let region_is_full_frame_fallback = region.x == 0
            && region.y == 0
            && region.w == region.frame_w
            && region.h == region.frame_h;
        if region_is_full_frame_fallback {
            eprintln!(
                "{:<55} region detector fell back to full-frame (its own <30%-area heuristic) — no opinion to cross-validate against; bounds alone = ({},{})-({},{})",
                path.strip_prefix(&root).unwrap_or(path).display(),
                bounds.x,
                bounds.y,
                bounds.x + bounds.width,
                bounds.y + bounds.height,
            );
            region_fallback_count += 1;
            continue;
        }
        let bounds_right = bounds.x + bounds.width;
        let bounds_bottom = bounds.y + bounds.height;
        let region_right = region.x + region.w;
        let region_bottom = region.y + region.h;
        let region_x = region.x;
        let region_y = region.y;

        let deltas = Deltas {
            left_frac: (bounds.x as f64 - region_x as f64).abs() / frame_w,
            top_frac: (bounds.y as f64 - region_y as f64).abs() / frame_h,
            right_frac: (bounds_right as f64 - region_right as f64).abs() / frame_w,
            bottom_frac: (bounds_bottom as f64 - region_bottom as f64).abs() / frame_h,
        };
        eprintln!(
            "{:<55} bounds=({},{})-({},{}) region=({},{})-({},{})  deltas: L={:.3} T={:.3} R={:.3} B={:.3}",
            path.strip_prefix(&root).unwrap_or(path).display(),
            bounds.x,
            bounds.y,
            bounds_right,
            bounds_bottom,
            region_x,
            region_y,
            region_right,
            region_bottom,
            deltas.left_frac,
            deltas.top_frac,
            deltas.right_frac,
            deltas.bottom_frac,
        );
        all_deltas.push((path.clone(), deltas));
    }

    if all_deltas.is_empty() {
        eprintln!("FAILED: every frame was skipped — no data to calibrate from");
        std::process::exit(1);
    }

    let mut worst: Vec<f64> = all_deltas
        .iter()
        .flat_map(|(_, d)| [d.left_frac, d.top_frac, d.right_frac, d.bottom_frac])
        .collect();
    worst.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let max = *worst.last().unwrap();
    let mean = worst.iter().sum::<f64>() / worst.len() as f64;
    let p95_idx = ((worst.len() as f64) * 0.95).floor() as usize;
    let p95 = worst[p95_idx.min(worst.len() - 1)];

    eprintln!();
    eprintln!(
        "=== summary: {} genuine sub-frame comparisons, {} region-detector-fallback (no opinion, excluded), {} skipped (errors), {} edge measurements ===",
        all_deltas.len(),
        region_fallback_count,
        skipped,
        worst.len()
    );
    eprintln!(
        "max edge delta:  {max:.4} ({:.1}px @ 1920 wide)",
        max * 1920.0
    );
    eprintln!(
        "p95 edge delta:  {p95:.4} ({:.1}px @ 1920 wide)",
        p95 * 1920.0
    );
    eprintln!(
        "mean edge delta: {mean:.4} ({:.1}px @ 1920 wide)",
        mean * 1920.0
    );

    let worst_frame = all_deltas
        .iter()
        .max_by(|(_, a), (_, b)| {
            let am = a
                .left_frac
                .max(a.top_frac)
                .max(a.right_frac)
                .max(a.bottom_frac);
            let bm = b
                .left_frac
                .max(b.top_frac)
                .max(b.right_frac)
                .max(b.bottom_frac);
            am.partial_cmp(&bm).unwrap()
        })
        .unwrap();
    eprintln!(
        "worst-agreement frame: {}",
        worst_frame
            .0
            .strip_prefix(&root)
            .unwrap_or(&worst_frame.0)
            .display()
    );
    eprintln!();
    eprintln!(
        "=== calibrate_crop_tolerance: DONE — pick a tolerance comfortably above the measured max \
         ({max:.4}) on this corpus, not the mean; report the measured numbers, not a guess ==="
    );
}
