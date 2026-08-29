//! Live-hardware smoke test for `move_to::move_to_pixel`'s
//! `strategy=slam-then-move` branch, on a real desktop/absolute-mouse
//! target — the piece `legacy_move_smoke.rs` deliberately could NOT
//! cover (that gate uses `forbidSlamFallback=true` specifically so it
//! can run safely on the iPad rig, which structurally never reaches
//! this code path). Built for `pikvm-nixos@it-03400`'s KDE desktop
//! target per the 2026-08-29 coordination — see
//! `docs/rust-port-plan.md` v18/the it-03400 follow-up task for the
//! full context on why this needed a second rig.
//!
//! Safe here specifically because the target is a real desktop
//! (absolute-mouse, no iPadOS hot-corner gesture) — `slam_to_corner` on
//! an iPad target is what the iPad rig's own safety guards exist to
//! prevent; none of that risk exists on a plain desktop OS.
//!
//! MOVES ONLY, never clicks.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=... (if needed) ORT_DYLIB_PATH=... \
//!   PIKVM_ML_VERIFIER_MODEL=$(pwd)/../ml/crop-heatmap.onnx \
//!   cargo run -p pikvm-mcp-mover --example legacy_move_slam_desktop_smoke -- <target_x> <target_y>

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::move_to::{move_to_pixel, MoveStrategy, MoveToOptions, Point};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();

    let args: Vec<String> = std::env::args().collect();
    let (target_x, target_y) = if args.len() >= 3 {
        (
            args[1].parse::<f64>().expect("target_x must be a number"),
            args[2].parse::<f64>().expect("target_y must be a number"),
        )
    } else {
        eprintln!("no target given, defaulting to (960, 540) — screen-center-ish; pass target_x target_y for a specific spot confirmed via a health-check screenshot first");
        (960.0, 540.0)
    };

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    eprintln!(
        "=== legacy_move_slam_desktop_smoke: move_to_pixel(slam-then-move) -> ({target_x}, {target_y}) ==="
    );
    eprintln!(
        "PRE-FLIGHT: confirm via a fresh pikvm_health_check / screenshot that the target screen is ON \
         and showing real desktop content BEFORE running this — the gate needs a real final-state screenshot \
         to verify against, not just the mechanically-reported residual (screenshots are source of truth)."
    );
    let result = move_to_pixel(
        &client,
        Point {
            x: target_x,
            y: target_y,
        },
        MoveToOptions {
            strategy: Some(MoveStrategy::SlamThenMove),
            verbose: true,
            // Desktop/absolute target: no iPad hot-corner risk, so the
            // Layer-3 guard doesn't need to be armed the way it would
            // for an iPad target — matches the real production default
            // for absolute-mouse policies (forbid_slam_on_ipad: false).
            forbid_slam_on_ipad: Some(false),
            ..Default::default()
        },
    )
    .await;

    let result = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("FAILED: move_to_pixel errored: {e}");
            std::process::exit(1);
        }
    };

    eprintln!("message: {}", result.message);
    eprintln!(
        "strategy={:?} chunk_count={} corrections={} diagnostics={}",
        result.strategy,
        result.chunk_count,
        result.corrections.len(),
        result.diagnostics.len()
    );
    eprintln!(
        "final_detected_position={:?} final_residual_px={:?} passes_since_last_verification={}",
        result.final_detected_position,
        result.final_residual_px,
        result.passes_since_last_verification
    );

    let path = "/tmp/legacy_move_slam_desktop_smoke_final.jpg";
    match std::fs::write(path, &result.screenshot) {
        Ok(()) => eprintln!(
            "final screenshot saved to {path} — INSPECT IT before trusting the line below \
             (the algorithm's own self-reported position can be wrong even when the run \
             completes without error — see docs/rust-port-plan.md v18)"
        ),
        Err(e) => eprintln!("WARNING: could not save final screenshot: {e}"),
    }

    match result.final_detected_position {
        Some(pos) => {
            let residual = result.final_residual_px.unwrap_or(f64::INFINITY);
            eprintln!(
                "=== legacy_move_slam_desktop_smoke: landed at ({:.1},{:.1}), {residual:.1}px from target (mechanically) — inspect the screenshot ===",
                pos.x, pos.y
            );
        }
        None => {
            eprintln!(
                "landed but final position was never verified (predicted-mode) — inspect the screenshot to confirm the cursor is near target anyway"
            );
        }
    }
}
