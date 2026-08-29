//! Live-hardware smoke test for PR93's cascade hint-narrowing behavior
//! (task_484bed055820) — E2E validation risk category 4,
//! docs/rust-port-plan.md §8 item 4. Re-runs, against the real Rust
//! `find_cursor_by_v8_full_frame`, the same three-part live gate the TS
//! implementation was already validated with:
//!
//!   (a) an isolated detection-call test: a GOOD hint (the cursor's own
//!       just-detected position) is at least as fast as a full-frame
//!       scan, with equivalent accuracy.
//!   (b) a negative control: a deliberately bad/stale hint (the opposite
//!       corner of the frame) still falls back to a full scan and finds
//!       the real cursor — proves the narrow-then-fallback logic
//!       (`run_cascade`'s own documented behavior) isn't silently eating
//!       detections when the hint is wrong.
//!   (c) a real on-box before/after latency measurement across the three
//!       calls above.
//!
//! Per §8 item 5's harness-discipline requirement, this saves the LAST
//! frame evaluated to disk for the operator to visually confirm the
//! reported position is the ACTUAL cursor, not just trust the numeric
//! output.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 ORT_DYLIB_PATH=... \
//!   [PIKVM_ML_VERIFIER_MODEL=/path/to/crop-heatmap.onnx] \
//!   cargo run -p pikvm-mcp-detection-vision --example cascade_hint_narrowing_smoke

use std::time::Instant;

use pikvm_mcp_detection_vision::cursor_detect::Point;
use pikvm_mcp_detection_vision::cursor_ml_detect::{
    find_cursor_by_v8_full_frame, resolve_verifier_model, V8Detection, V8FullFrameOptions,
};
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};

/// Take a fresh (wake-nudged) screenshot and run the real cascade
/// detector with the given hint; exits the process on any failure so a
/// gate failure is unambiguous in CI-style output, matching the
/// established `curve_mover_smoke.rs`/`slam_and_cascade_smoke.rs`
/// convention.
async fn detect(
    client: &PiKVMClient,
    hint: Option<Point>,
    label: &str,
) -> (V8Detection, Vec<u8>, u128) {
    let shot = match client.screenshot_keeping_cursor_alive(None).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("FAILED ({label}): screenshot_keeping_cursor_alive errored: {e}");
            std::process::exit(1);
        }
    };
    let start = Instant::now();
    let result = find_cursor_by_v8_full_frame(
        &shot.buffer,
        shot.screenshot_width,
        shot.screenshot_height,
        V8FullFrameOptions {
            min_presence: None,
            hint,
        },
    );
    let elapsed_ms = start.elapsed().as_millis();
    match result {
        Ok(Some(d)) => {
            eprintln!(
                "{label}: cursor at ({:.1}, {:.1}), presence={:.3}, {elapsed_ms}ms",
                d.x, d.y, d.presence
            );
            (d, shot.buffer, elapsed_ms)
        }
        Ok(None) => {
            eprintln!("FAILED ({label}): find_cursor_by_v8_full_frame found no confident cursor");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("FAILED ({label}): find_cursor_by_v8_full_frame errored: {e}");
            std::process::exit(1);
        }
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = PiKVMClient::new(config, None);
    eprintln!("model: {}", resolve_verifier_model().display());

    eprintln!("=== 1/3: baseline — full-frame scan, no hint ===");
    let (baseline, _baseline_frame, baseline_ms) = detect(&client, None, "no-hint baseline").await;
    let good_hint = Point {
        x: baseline.x,
        y: baseline.y,
    };

    eprintln!("=== 2/3 (a): good hint — narrowed search around the just-detected position ===");
    let (with_good_hint, _good_hint_frame, good_hint_ms) =
        detect(&client, Some(good_hint), "good-hint narrowed").await;
    let good_hint_drift = (with_good_hint.x - baseline.x).hypot(with_good_hint.y - baseline.y);
    eprintln!(
        "good-hint drift from baseline: {good_hint_drift:.1}px (expect small — same real cursor)"
    );
    if good_hint_ms > baseline_ms {
        eprintln!(
            "NOTE: good-hint call ({good_hint_ms}ms) was NOT faster than the full-frame baseline \
             ({baseline_ms}ms) this run — single-sample timing on real hardware is noisy; re-run \
             a few times before treating this as a regression."
        );
    } else {
        eprintln!("good-hint call was faster than the full-frame baseline, as expected: {good_hint_ms}ms vs {baseline_ms}ms");
    }

    eprintln!(
        "=== 3/3 (b): negative control — deliberately bad/stale hint (opposite frame corner) ==="
    );
    // A hint at the far opposite corner from the just-detected position —
    // guaranteed to miss the narrow HINT_WINDOW_RADIUS_PX window around
    // the real cursor, forcing run_cascade's documented fallback path.
    let bad_hint = Point {
        x: if baseline.x < 500.0 { 1800.0 } else { 50.0 },
        y: if baseline.y < 300.0 { 1000.0 } else { 30.0 },
    };
    let (with_bad_hint, final_frame, bad_hint_ms) =
        detect(&client, Some(bad_hint), "bad-hint negative control").await;
    let bad_hint_drift = (with_bad_hint.x - baseline.x).hypot(with_bad_hint.y - baseline.y);
    eprintln!(
        "bad-hint drift from baseline: {bad_hint_drift:.1}px (expect small — the fallback scan \
         must still find the REAL cursor despite the wrong hint, not the hint location itself)"
    );

    eprintln!();
    eprintln!("=== latency summary (c) ===");
    eprintln!("no-hint baseline:  {baseline_ms}ms");
    eprintln!("good-hint narrow:  {good_hint_ms}ms");
    eprintln!(
        "bad-hint fallback: {bad_hint_ms}ms (expected ~= baseline; it's doing the same full scan)"
    );

    let path = "/tmp/cascade_hint_narrowing_smoke_final.jpg";
    match std::fs::write(path, &final_frame) {
        Ok(()) => eprintln!(
            "final frame saved to {path} — INSPECT IT: does the reported cursor position \
             ({:.1}, {:.1}) actually match where the cursor is in the image?",
            with_bad_hint.x, with_bad_hint.y
        ),
        Err(e) => eprintln!("WARNING: could not save final frame: {e}"),
    }

    // Structural pass/fail: both hint variants must agree with the
    // baseline within a generous tolerance (the real gate's numeric
    // judgment; the operator's screenshot inspection above is the final
    // word on whether that position is the ACTUAL cursor per §8 item 5).
    const MAX_ACCEPTABLE_DRIFT_PX: f64 = 30.0;
    if good_hint_drift > MAX_ACCEPTABLE_DRIFT_PX || bad_hint_drift > MAX_ACCEPTABLE_DRIFT_PX {
        eprintln!(
            "FAILED: drift exceeded {MAX_ACCEPTABLE_DRIFT_PX}px (good={good_hint_drift:.1}px, \
             bad={bad_hint_drift:.1}px) — either the hint-narrowing logic or the fallback isn't \
             converging on the same real cursor the baseline found."
        );
        std::process::exit(1);
    }
    eprintln!("=== cascade_hint_narrowing_smoke: PASSED (mechanically) — inspect the saved screenshot before trusting this line ===");
}
