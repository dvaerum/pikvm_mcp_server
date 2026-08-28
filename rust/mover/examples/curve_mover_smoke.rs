//! Live-hardware smoke test for `curve_mover::move_by_curve_one_shot` —
//! the MANDATORY iPad-hardware gate for mover/anchor-adjacent code
//! (manager's standing rule), for THE validated, N=80, "do NOT touch it"
//! iPad-critical mover itself.
//!
//! Scope: exercises the ONE thing the 33 mocked unit tests structurally
//! can't — real V8/cascade detection (via the real bundled ONNX model),
//! a real deterministic curve-based emit, and a real post-move
//! verification detect, all against the real iPad. Targets an
//! operator-chosen point on the current home screen. MOVES ONLY, never
//! clicks — landing on an icon is harmless since nothing is tapped.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 ORT_DYLIB_PATH=... \
//!   cargo run -p pikvm-mcp-mover --example curve_mover_smoke -- <target_x> <target_y>

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::curve_mover::{move_by_curve_one_shot, CurveOneShotDeps, CurveOneShotOptions};
use pikvm_mcp_mover::move_to::Point;
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
        // A generic mid-frame point, safe on a typical iPad home screen
        // (open space between icon rows on a 1920x1080 HDMI frame).
        eprintln!(
            "no target given, defaulting to (950, 400) — pass target_x target_y to aim elsewhere"
        );
        (950.0, 400.0)
    };

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    eprintln!("=== curve_mover_smoke: move_by_curve_one_shot -> ({target_x}, {target_y}) ===");
    let result = move_by_curve_one_shot(
        &client,
        Point {
            x: target_x,
            y: target_y,
        },
        CurveOneShotOptions::default(),
        CurveOneShotDeps::default(),
    )
    .await;

    let result = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("FAILED: move_by_curve_one_shot errored: {e}");
            std::process::exit(1);
        }
    };

    eprintln!("message: {}", result.message);
    eprintln!(
        "chunk_count={} emitted_mickeys={:?}",
        result.chunk_count, result.emitted_mickeys
    );
    eprintln!(
        "final_detected_position={:?} final_residual_px={:?}",
        result.final_detected_position, result.final_residual_px
    );
    if let Some(sample) = &result.learn_sample {
        eprintln!(
            "learn_sample: planned=({:.1},{:.1}) achieved=({:.1},{:.1}) woken={}",
            sample.planned_x, sample.planned_y, sample.achieved_x, sample.achieved_y, sample.woken
        );
    }

    let path = "/tmp/curve_mover_smoke_final.jpg";
    match std::fs::write(path, &result.screenshot) {
        Ok(()) => eprintln!(
            "final screenshot saved to {path} — INSPECT IT before trusting the line below"
        ),
        Err(e) => eprintln!("WARNING: could not save final screenshot: {e}"),
    }

    match result.final_detected_position {
        Some(pos) => {
            let residual = result.final_residual_px.unwrap_or(f64::INFINITY);
            eprintln!(
                "=== curve_mover_smoke: landed at ({:.1},{:.1}), {residual:.1}px from target (mechanically) — inspect the screenshot ===",
                pos.x, pos.y
            );
        }
        None => {
            eprintln!("FAILED: no final detected position — the move ran but verification never confirmed a landing");
            std::process::exit(1);
        }
    }
}
