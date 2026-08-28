//! Live-hardware smoke test for `cursor_anchor::anchor_cursor` — the
//! MANDATORY iPad-hardware gate for mover/anchor-adjacent code (manager's
//! standing rule).
//!
//! This is the follow-up `slam_and_cascade_smoke.rs`'s own header
//! predicted: that example deliberately skipped `slam::slam_to_corner`
//! ("no safety guard, no recovery policy... cursor-anchor.ts's Rust port
//! doesn't exist yet... calling it directly bypasses the one thing that
//! protects against the documented hot-corner lock risk"). Now that
//! `cursor_anchor.rs` exists, THIS is the gate that finally exercises a
//! real corner slam — through the guard that makes it safe, not around it.
//!
//! Scope: exercises the ONE thing 23 mocked unit tests structurally can't
//! — real HDMI-capture bounds detection + a real corner slam + a real
//! post-slam verification diff, all through `AnchorGuard::BoundsGuard`
//! (the production path `move-to.ts`'s `discoverOrigin` uses). Does NOT
//! exercise the key-sequence-retry/defensive-keys recovery paths: those
//! only run on a FAILED verification, which can't be forced deterministically
//! on live hardware without contriving a failure, and the recovery logic
//! itself is already covered by cursor_anchor.rs's own mocked-client tests
//! (`caller_asserted_recovery_key_sequence_retry`,
//! `caller_asserted_recovery_defensive_keys`) — this gate's job is the real
//! detection/slam/verify mechanics those mocks can't stand in for.
//! `recovery: InspectOnly` is passed so a verification failure here is
//! reported, not silently retried with unplanned key presses.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example cursor_anchor_smoke

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::cursor_anchor::{
    anchor_cursor, AnchorGuard, AnchorNudge, AnchorRecoveryPosture, AnchorRequest,
};
use pikvm_mcp_mover::slam::{Corner, ScreenshotMode};
use std::sync::Arc;

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
    let client = Arc::new(PiKVMClient::new(config, None));

    eprintln!("=== 1/2: anchor_cursor(BoundsGuard) — real bounds detection + guarded corner slam + verify ===");
    let result = anchor_cursor(AnchorRequest {
        client: client.clone(),
        corner: Some(Corner::TopLeft),
        guard: AnchorGuard::BoundsGuard {
            allow_on_undetermined: false,
        },
        // Nudging variant: keeps the auto-fading iPad cursor visible for the
        // verification screenshot pair (ADR-0001).
        screenshot: ScreenshotMode::Nudging,
        capture_verification: true,
        recovery: AnchorRecoveryPosture::InspectOnly,
        nudge: None,
        pace_ms: None,
        slam_origin_px: None,
        verbose: true,
    })
    .await;

    let result = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("FAILED: anchor_cursor errored: {e}");
            eprintln!(
                "(if this is the bounds-guard refusal, the target's bounds were undetectable \
                 or unrecognised — check the iPad is on and showing lock/home screen, not asleep)"
            );
            std::process::exit(1);
        }
    };

    eprintln!(
        "origin: ({}, {}), bounds: {:?}, verified: {:?}",
        result.origin.0, result.origin.1, result.bounds, result.verified
    );

    let Some(bounds) = result.bounds else {
        eprintln!("FAILED: bounds-guard did not report detected bounds (expected Some on a real iPad target)");
        std::process::exit(1);
    };
    eprintln!(
        "detected {:?} bounds {}x{} at ({}, {})",
        bounds.orientation, bounds.width, bounds.height, bounds.x, bounds.y
    );

    match result.verified {
        Some(true) => {
            eprintln!("SUCCESS: slam-then-verify confirmed the cursor landed at the corner")
        }
        Some(false) => {
            eprintln!(
                "FAILED: slam-then-verify did NOT confirm landing — cursor may not have moved, \
                 or moved somewhere unexpected. Check the target manually before retrying."
            );
            std::process::exit(1);
        }
        None => {
            eprintln!(
                "FAILED: verified is None — capture_verification:true should always populate this"
            );
            std::process::exit(1);
        }
    }

    eprintln!("=== 2/2: post-anchor nudge — move the cursor off the corner into open space ===");
    // Re-run through anchor_cursor's own nudge path (none-calibration guard:
    // already anchored, no re-detection needed, no verification — just the
    // nudge mechanism, matching measureCell's own use of it).
    if let Err(e) = anchor_cursor(AnchorRequest {
        client: client.clone(),
        corner: Some(Corner::TopLeft),
        guard: AnchorGuard::NoneCalibration,
        screenshot: ScreenshotMode::Nudging,
        capture_verification: false,
        recovery: AnchorRecoveryPosture::InspectOnly,
        nudge: Some(AnchorNudge {
            away: Some(Corner::TopLeft),
            only_axis: None,
        }),
        pace_ms: None,
        slam_origin_px: Some(result.origin),
        verbose: true,
    })
    .await
    {
        eprintln!("FAILED: post-anchor nudge errored: {e}");
        std::process::exit(1);
    }
    eprintln!("SUCCESS: cursor nudged off the corner");

    eprintln!("=== ALL GATES PASSED ===");
}
