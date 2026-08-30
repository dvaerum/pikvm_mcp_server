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
//! real corner slam — through a guard that makes it safe, not around it.
//!
//! **v2 (2026-08-28), after the first live run**: v1 used
//! `AnchorGuard::BoundsGuard{allow_on_undetermined:false}` for phase 1.
//! Against georgs-mac-mini's real iPad rig it correctly REFUSED — real
//! bounds detection found a genuine 685×982 portrait letterbox, and the
//! guard made exactly the refusal call `move-to.ts`'s `discoverOrigin`
//! would make in production against that target (confirmed via before/
//! after screenshots: the iPad was never touched). That refusal IS
//! `BoundsGuard`'s pass condition on real iPad hardware and is treated as
//! already gated — but it meant the actual slam+verify mechanics never
//! ran. Phase 1 now uses `AnchorGuard::CallerAsserted` instead: Layer 5
//! ("caller has already established slamming is safe"), the SAME guard
//! kind `unlockIpad`/`ipadGoHome` use in production — a real production
//! configuration, not a safety bypass invented for this test.
//!
//! Scope: exercises the ONE thing 23 mocked unit tests structurally can't
//! — real HDMI-capture bounds detection (best-effort under this guard) + a
//! real corner slam + a real post-slam verification diff. Does NOT exercise
//! the key-sequence-retry/defensive-keys recovery paths: those only run on
//! a FAILED verification, which can't be forced deterministically on live
//! hardware without contriving a failure, and the recovery logic itself is
//! already covered by cursor_anchor.rs's own mocked-client tests
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

    eprintln!(
        "=== 1/2: anchor_cursor(CallerAsserted) — real bounds detection + guarded corner slam + verify ==="
    );
    // v3 (2026-08-28), post-incident: v2's CallerAsserted reason asserted
    // safety BECAUSE the target was "awake/unlocked" — exactly backwards.
    // CallerAsserted's own contract (this file's doc, unlockIpad's real
    // call site) is "a lock screen has no active hot corner" — the real
    // callers (unlockIpad, ipadGoHome) assert safety BECAUSE the target IS
    // a lock screen, not despite it. This run requires the operator to
    // have locked the iPad (Ctrl+Cmd+Q) and confirmed via screenshot
    // BEFORE running this example — the same real production precondition
    // unlockIpad/ipadGoHome actually hold, not a bare "looked fine" claim.
    let result = anchor_cursor(AnchorRequest {
        client: client.clone(),
        allow_keyboard_wake_after: false, // see docs/corner-control-allow-keyboard-wake-decision.md
        allow_keyboard_wake_before: false, // see docs/corner-control-allow-keyboard-wake-decision.md
        allow_keyboard_wake_bounds_detection: false, // out of scope for this simpler smoke test, per the bounds-detection decision doc
        corner: Some(Corner::TopLeft),
        guard: AnchorGuard::CallerAsserted {
            reason: "cursor_anchor_smoke v3: operator locked the iPad (Ctrl+Cmd+Q) and confirmed via screenshot BEFORE this run — matches unlockIpad's real precondition, not an active/interactive target".to_string(),
        },
        // Nudging variant: keeps the auto-fading iPad cursor visible for the
        // verification screenshot pair (ADR-0001).
        screenshot: ScreenshotMode::Nudging,
        capture_verification: true,
        recovery: AnchorRecoveryPosture::InspectOnly,
        nudge: None,
        pace_ms: None,
        slam_origin_px: None,
        slam_calls: None,
        verbose: true,
    })
    .await;

    let result = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("FAILED: anchor_cursor errored: {e}");
            eprintln!(
                "(CallerAsserted never refuses on the safety question — an error here means \
                 the slam or the underlying HID/screenshot calls themselves failed)"
            );
            std::process::exit(1);
        }
    };

    eprintln!(
        "origin: ({}, {}), bounds: {:?}, verified: {:?}",
        result.origin.0, result.origin.1, result.bounds, result.verified
    );

    // CallerAsserted's bounds detection is best-effort (never fails the
    // caller) — unlike BoundsGuard, a None here is expected-possible, not
    // itself a failure. Report it either way for visual confirmation.
    match &result.bounds {
        Some(bounds) => eprintln!(
            "detected {:?} bounds {}x{} at ({}, {})",
            bounds.orientation, bounds.width, bounds.height, bounds.x, bounds.y
        ),
        None => eprintln!(
            "bounds detection did not resolve (fell back to LEGACY_PORTRAIT_SLAM_ORIGIN) — \
             verification below still checks whether the slam actually landed"
        ),
    }

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
        allow_keyboard_wake_after: false, // see docs/corner-control-allow-keyboard-wake-decision.md
        allow_keyboard_wake_before: false, // see docs/corner-control-allow-keyboard-wake-decision.md
        allow_keyboard_wake_bounds_detection: false, // out of scope for this simpler smoke test, per the bounds-detection decision doc
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
        slam_calls: None,
        verbose: true,
    })
    .await
    {
        eprintln!("FAILED: post-anchor nudge errored: {e}");
        std::process::exit(1);
    }
    eprintln!("SUCCESS: cursor nudged off the corner");

    // Manager's finding on the v2/CallerAsserted incident: phase 1's
    // verified:true only confirms the FIRST slam landed — nothing checked
    // device state after the LAST action (phase 2's slam+nudge), which is
    // exactly how "ALL GATES PASSED" printed while the iPad ended up
    // locked. This project deliberately has no automated lock-screen
    // classifier (the Phase 318 isLikelyLockScreen heuristic was removed
    // for false positives — lock-state determination is the operator's
    // job via visual inspection, not a pixel heuristic's). So: capture and
    // save the FINAL state as a concrete artifact every run, pass or fail,
    // for the operator to actually look at before trusting this line.
    let final_shot = client.screenshot(None).await;
    match final_shot {
        Ok(shot) => {
            let path = "/tmp/cursor_anchor_smoke_final.jpg";
            if let Err(e) = std::fs::write(path, &shot.buffer) {
                eprintln!("WARNING: could not save final-state screenshot: {e}");
            } else {
                eprintln!("final-state screenshot saved to {path} — INSPECT IT before trusting the line below");
            }
        }
        Err(e) => eprintln!("WARNING: final-state screenshot capture failed: {e}"),
    }

    eprintln!("=== ALL GATES PASSED (mechanically) — final state NOT auto-verified, inspect the screenshot ===");
}
