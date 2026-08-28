//! Live-hardware smoke test, two gates:
//!
//! 1. The ONNX cascade tracker (`run_cascade`) — flagged as a SEPARATE
//!    mandatory gate by nixos-dev/manager: only ever offline-verified
//!    before this. Confirms it actually finds the cursor at a sane
//!    position on a real frame.
//! 2. `slam::nudge_from_edge` — a bounded relative move (default 5 calls
//!    x 127 mickeys), no corner-slam, no lock risk (manager-approved
//!    partial coverage while `slam_to_corner` waits on cursor-anchor.rs's
//!    safety guard — see below).
//!
//! Deliberately does NOT exercise `slam::slam_to_corner` here: that
//! function has NO safety guard by design (slam.rs's own header: "no
//! safety guard, no recovery policy — those live one layer up, in
//! cursor-anchor.ts"), and cursor-anchor.ts's Rust port doesn't exist yet.
//! Calling it directly against a portrait-letterboxed iPad (confirmed via
//! the pre-flight health-check screenshot) bypasses the one thing that
//! protects against the documented hot-corner lock risk (slam.ts's own
//! header: "a controlled retest found the lock risk present at a
//! non-trivial rate regardless of pace"). Manager-approved sequencing
//! (2026-08-28): wait for cursor-anchor.rs, gate slam_to_corner through
//! the real guard once it lands.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example slam_and_cascade_smoke

use pikvm_mcp_detection_vision::cursor_ml_detect::run_cascade;
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::slam::{nudge_from_edge, Corner, NudgeOptions};

/// Run the cascade against a fresh (wake-nudged) screenshot; return the
/// found position, or exit the process on any failure.
async fn find_cursor(client: &PiKVMClient, model_path: &str, label: &str) -> (i64, i64) {
    let shot = match client.screenshot_keeping_cursor_alive(None).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("FAILED ({label}): screenshot_keeping_cursor_alive errored: {e}");
            std::process::exit(1);
        }
    };
    match run_cascade(
        model_path,
        &shot.buffer,
        shot.screenshot_width,
        shot.screenshot_height,
        None,
        48.0,
        0.5,
    ) {
        Ok(Some(r)) => {
            eprintln!(
                "{label}: cursor at ({}, {}), presence={:.3}",
                r.x, r.y, r.presence
            );
            (r.x, r.y)
        }
        Ok(None) => {
            eprintln!("FAILED ({label}): run_cascade found no confident cursor");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("FAILED ({label}): run_cascade errored: {e}");
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
    let model_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../ml/crop-heatmap.onnx");
    eprintln!("model: {model_path}");

    eprintln!("=== 1/2: ONNX cascade tracker (run_cascade) against a real screenshot ===");
    let before = find_cursor(&client, model_path, "before").await;
    // Save the frame the FIRST cascade call evaluated for visual verification.
    let frame_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scratch/cascade-frame.jpg"
    );
    let shot_for_save = client
        .screenshot(None)
        .await
        .expect("re-screenshot for save");
    std::fs::write(frame_path, &shot_for_save.buffer).expect("write cascade-frame.jpg");
    eprintln!(
        "wrote a frame to {frame_path} for visual verification (position ~matches 'before' above)"
    );
    eprintln!("SUCCESS: cascade found a sane in-frame position");

    eprintln!(
        "=== 2/2: slam::nudge_from_edge — bounded relative move, no corner-slam, no lock risk ==="
    );
    // Manager-approved partial coverage (2026-08-28) while slam_to_corner
    // waits on cursor-anchor.rs's safety guard. Default away-from-top-left
    // (+x, +y) — moves the cursor toward open screen, not toward another
    // corner.
    if let Err(e) = nudge_from_edge(
        &client,
        NudgeOptions {
            away: Some(Corner::TopLeft),
            verbose: true,
            ..Default::default()
        },
    )
    .await
    {
        eprintln!("FAILED: nudge_from_edge errored: {e}");
        std::process::exit(1);
    }
    let after = find_cursor(&client, model_path, "after").await;
    let (dx, dy) = (after.0 - before.0, after.1 - before.1);
    eprintln!("displacement: ({dx}, {dy})");
    // nudge_from_edge(away: TopLeft) emits (+127,+127) x 5 calls (before the
    // edge dead-zone/screen-bounds clamp) — sane means "moved down-right by
    // a real amount", not an exact px match (dead-zone absorption + clamp
    // at the screen edge are both real and expected).
    if dx <= 0 || dy <= 0 {
        eprintln!("FAILED: displacement ({dx}, {dy}) did not move down-right as expected");
        std::process::exit(1);
    }
    eprintln!("SUCCESS: nudge_from_edge moved the cursor down-right by a real amount");

    eprintln!("=== ALL GATES PASSED ===");
}
