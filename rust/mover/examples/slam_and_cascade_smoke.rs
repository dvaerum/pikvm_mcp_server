//! Live-hardware smoke test for the ONNX cascade tracker
//! (cursor_ml_detect.rs's `run_cascade`) — flagged as a SEPARATE mandatory
//! gate by nixos-dev/manager: only ever offline-verified (real onnxruntime
//! linking + synthetic-input sanity checks) before this, never against a
//! real HDMI capture. Confirms it actually finds the cursor at a sane
//! position on a real frame.
//!
//! Deliberately does NOT exercise slam.rs's `slam_to_corner` here: that
//! function has NO safety guard by design (slam.rs's own header: "no
//! safety guard, no recovery policy — those live one layer up, in
//! cursor-anchor.ts"), and cursor-anchor.ts's Rust port doesn't exist yet.
//! Calling it directly against a portrait-letterboxed iPad (confirmed via
//! the pre-flight health-check screenshot) bypasses the one thing that
//! protects against the documented hot-corner lock risk (slam.ts's own
//! header: "a controlled retest found the lock risk present at a
//! non-trivial rate regardless of pace"). See the note routed to the
//! manager for how to sequence that gate safely.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example slam_and_cascade_smoke

use pikvm_mcp_detection_vision::cursor_ml_detect::run_cascade;
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};

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

    eprintln!("=== ONNX cascade tracker (run_cascade) against a real screenshot ===");
    // Wake the cursor immediately before capture (screenshot_keeping_cursor_alive's
    // ±1px round-trip nudge) — net-zero displacement, no corner-slam, no
    // lock risk — the cascade needs the cursor actually rendered in-frame.
    let shot = match client.screenshot_keeping_cursor_alive(None).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("FAILED: screenshot_keeping_cursor_alive errored: {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "captured {}x{} screenshot, {} bytes",
        shot.screenshot_width,
        shot.screenshot_height,
        shot.buffer.len()
    );
    let frame_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scratch/cascade-frame.jpg"
    );
    std::fs::write(frame_path, &shot.buffer).expect("write cascade-frame.jpg");
    eprintln!("wrote the exact evaluated frame to {frame_path} for visual verification");

    let model_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../ml/crop-heatmap.onnx");
    eprintln!("model: {model_path}");
    let cascade_result = run_cascade(
        model_path,
        &shot.buffer,
        shot.screenshot_width,
        shot.screenshot_height,
        None,
        48.0,
        0.5,
    );
    match cascade_result {
        Ok(Some(r)) => {
            eprintln!(
                "run_cascade: found cursor at ({}, {}), presence={:.3}",
                r.x, r.y, r.presence
            );
            let sane = r.x >= 0
                && r.y >= 0
                && (r.x as u32) < shot.screenshot_width
                && (r.y as u32) < shot.screenshot_height;
            if !sane {
                eprintln!(
                    "FAILED: cascade result ({}, {}) is outside the {}x{} frame — not sane",
                    r.x, r.y, shot.screenshot_width, shot.screenshot_height
                );
                std::process::exit(1);
            }
            eprintln!("SUCCESS: cascade found a sane in-frame position");
        }
        Ok(None) => {
            eprintln!("FAILED: run_cascade found no confident cursor (None) — cursor may be off-frame or faded");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("FAILED: run_cascade errored: {e}");
            std::process::exit(1);
        }
    }
}
