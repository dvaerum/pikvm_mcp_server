//! Live-hardware smoke test for `move_to::move_to_pixel`'s LEGACY
//! (non-`curve-one-shot`) path — the MANDATORY iPad-hardware gate for
//! mover-adjacent code (manager's standing rule), for
//! `legacy_move.rs`/`resolved_options.rs`/`origin.rs`'s combined
//! correction-loop machinery.
//!
//! **Scope, and why it's PARTIAL — read before trusting a green run**:
//! `docs/rust-port-plan.md` v13 flags this path's own live gate as
//! belonging on a desktop/absolute-mouse target (`it-03400`), not the
//! iPad rig — the legacy path's real production default is
//! desktop/absolute, and the iPad-critical strategy is `curve-one-shot`
//! (already gated separately, `curve_mover_smoke.rs`, PASSED). `it-03400`
//! is a different physical appliance this node has no access to (its
//! OTG link doesn't currently enumerate per `docs/adr/0002-...md`) — so
//! this example validates what it safely CAN on the one rig actually
//! reachable: `strategy=detect-then-move` with `forbidSlamFallback=true`,
//! which exercises real origin discovery (`locate_cursor`, itself already
//! gated via `cursor_anchor_smoke.rs`), the real calibration probe, the
//! real open-loop emission, and the real open-loop/correction-pass
//! detection cascade (motion-diff -> template-match -> shape/ML) against
//! the live iPad — but CANNOT ever reach `slam_to_corner` (forbidSlamFallback
//! throws instead of falling back), so it does NOT validate the
//! slam-then-move branch specifically, nor any real absolute-mouse/
//! desktop behavior. That gap stays open pending it-03400 access — see
//! the manager report accompanying this run.
//!
//! MOVES ONLY, never clicks. Never invokes strategy=slam-then-move.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 ORT_DYLIB_PATH=... \
//!   PIKVM_ML_VERIFIER_MODEL=$(pwd)/../ml/crop-heatmap.onnx \
//!   cargo run -p pikvm-mcp-mover --example legacy_move_smoke -- <target_x> <target_y>

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
        eprintln!("no target given, defaulting to (1050, 850) — open wallpaper on the current home screen, confirmed via the pre-flight health-check screenshot");
        (1050.0, 850.0)
    };

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    eprintln!("=== legacy_move_smoke: move_to_pixel(detect-then-move, forbidSlamFallback=true) -> ({target_x}, {target_y}) ===");
    let result = move_to_pixel(
        &client,
        Point {
            x: target_x,
            y: target_y,
        },
        MoveToOptions {
            strategy: Some(MoveStrategy::DetectThenMove),
            forbid_slam_fallback: true,
            verbose: true,
            ..Default::default()
        },
    )
    .await;

    let result = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("FAILED: move_to_pixel errored: {e}");
            eprintln!(
                "(this is a real failure only if the error is NOT 'slam fallback forbidden' \
                 for an ambiguous/undetected origin — see this file's own scope note)"
            );
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

    let path = "/tmp/legacy_move_smoke_final.jpg";
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
                "=== legacy_move_smoke: landed at ({:.1},{:.1}), {residual:.1}px from target (mechanically) — inspect the screenshot ===",
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
