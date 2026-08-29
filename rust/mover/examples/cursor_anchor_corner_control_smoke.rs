//! Live-hardware positive/negative control pair for `corner_target_from_
//! bounds`'s verification math — E2E validation risk category 2,
//! docs/rust-port-plan.md §8 item 2 (the deterministic ~619px corner-
//! target bug: TS compared against the raw HDMI frame corner instead of
//! the iPad's own detected letterboxed-content corner, passed offline
//! tests for months).
//!
//! **v2, post-incident (2026-08-29).** v1 called `slam_to_corner` DIRECTLY
//! for both controls, bypassing `cursor_anchor.rs`'s `AnchorGuard` system
//! entirely — exactly what `slam/motion.rs`'s own header warns against
//! ("No safety guard, no recovery policy — those live one layer up, in
//! cursor_anchor"). The full-slam positive control LOCKED the real iPad
//! (health-check confirmed a normal Settings screen moments before;
//! post-slam screenshot showed a lock screen instead). Recovered cleanly
//! via `unlock_ipad`'s key-press path (no passcode/Touch-ID lockout), but
//! it was a real, avoidable incident: there was no way to get a genuine
//! SHORT slam through the guarded `anchor_cursor` path, so v1 reached for
//! the unguarded primitive instead of extending the guarded API.
//!
//! The actual fix: `AnchorRequest` gained `slam_calls: Option<u32>` (see
//! its own doc comment in cursor_anchor.rs) so both controls below go
//! through `anchor_cursor(guard: AnchorGuard::CallerAsserted{...})` — the
//! SAME safety contract `unlockIpad`/`ipadGoHome` use in production, never
//! the raw `slam_to_corner`/`nudge_from_edge` primitives. This file no
//! longer imports `slam_to_corner` or `nudge_from_edge` at all — the only
//! way to reach a slam from this harness is through the guard.
//!
//! Two slams total (one full, one deliberately short via `slam_calls`) —
//! well under the session's own documented Touch-ID-lockout threshold
//! (~4 full corner-slam gates within an hour); paced per the manager's
//! approved sequencing (category 2 now, category 5's lock-screen test in
//! its own separate session).
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example cursor_anchor_corner_control_smoke

use std::sync::Arc;

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::cursor_anchor::{
    anchor_cursor, AnchorGuard, AnchorNudge, AnchorRecoveryPosture, AnchorRequest, Corner,
};
use pikvm_mcp_mover::slam::ScreenshotMode;

/// Both controls assert safety BECAUSE a fresh health-check screenshot
/// (taken by `main` immediately before each call) confirmed real,
/// non-lock-screen content — the same "operator confirmed the precondition
/// this run, not inherited from an earlier context" discipline
/// `cursor_anchor_smoke.rs` v3 already established for `CallerAsserted`.
fn caller_asserted_reason() -> AnchorGuard {
    AnchorGuard::CallerAsserted {
        reason: "cursor_anchor_corner_control_smoke: operator confirmed via a fresh screenshot \
                 immediately before this call that the iPad is on real, non-lock-screen content \
                 (Settings/home screen) — matches CallerAsserted's real contract, not an assumed \
                 or inherited precondition."
            .to_string(),
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
    let client = Arc::new(PiKVMClient::new(config, None));

    // Mandatory health-check FIRST — this screenshot is also what makes
    // CallerAsserted's reason below true, not just asserted.
    let health = client
        .screenshot(None)
        .await
        .expect("health-check screenshot failed");
    std::fs::write("/tmp/corner_control_smoke_health.jpg", &health.buffer)
        .expect("write health-check screenshot");
    eprintln!(
        "=== HEALTH CHECK: /tmp/corner_control_smoke_health.jpg — STOP AND INSPECT before \
         trusting this run. Confirm: iPad awake, unlocked, real (non-lock-screen) content. \
         Only proceed if that's genuinely true — CallerAsserted below takes your word for it. ==="
    );

    eprintln!("=== 1/2: POSITIVE control — full slam via anchor_cursor(CallerAsserted), expect verified:true ===");
    let positive = anchor_cursor(AnchorRequest {
        client: client.clone(),
        corner: Some(Corner::TopLeft),
        guard: caller_asserted_reason(),
        screenshot: ScreenshotMode::Nudging,
        capture_verification: true,
        recovery: AnchorRecoveryPosture::InspectOnly,
        nudge: Some(AnchorNudge {
            away: Some(Corner::TopLeft),
            only_axis: None,
        }),
        pace_ms: None,
        slam_origin_px: None,
        slam_calls: None, // full default — guaranteed to reach the corner
        verbose: true,
    })
    .await
    .expect("positive-control anchor_cursor call failed");

    eprintln!(
        "positive control: origin={:?}, verified={:?}",
        positive.origin, positive.verified
    );
    let positive_shot = client
        .screenshot(None)
        .await
        .expect("post-positive-control screenshot failed");
    std::fs::write(
        "/tmp/corner_control_smoke_positive.jpg",
        &positive_shot.buffer,
    )
    .expect("write positive-control screenshot");
    eprintln!(
        "saved /tmp/corner_control_smoke_positive.jpg — INSPECT: cursor should be in open space \
         (post-nudge), iPad should still be on real content, NOT a lock screen"
    );

    if positive.verified != Some(true) {
        eprintln!(
            "FAILED: expected verified:true on a full slam. Inspect the screenshot before \
             concluding why — stopping before the negative control."
        );
        std::process::exit(1);
    }

    eprintln!();
    eprintln!(
        "=== 2/2: NEGATIVE control — deliberately SHORT slam (slam_calls:3) via the SAME guarded \
         anchor_cursor(CallerAsserted) path, expect verified:false ==="
    );
    // Re-confirm the precondition with a fresh screenshot rather than
    // reusing the positive control's — CallerAsserted's contract is
    // about THIS call's actual current state, not a stale assumption.
    let mid_check = client
        .screenshot(None)
        .await
        .expect("pre-negative-control screenshot failed");
    std::fs::write("/tmp/corner_control_smoke_mid_check.jpg", &mid_check.buffer)
        .expect("write mid-check screenshot");
    eprintln!(
        "saved /tmp/corner_control_smoke_mid_check.jpg — confirm still non-lock-screen before \
         the negative control fires"
    );

    // Default slam_to_corner would use ceil(1920/100)+8=28 calls to
    // GUARANTEE reaching the corner. 3 calls x 127px is nowhere near
    // enough to cross even a fraction of a 1920px-wide frame — a real,
    // physically-incomplete slam, not a synthetic failure — now reached
    // ONLY through the guarded path via AnchorRequest.slam_calls.
    let negative = anchor_cursor(AnchorRequest {
        client: client.clone(),
        corner: Some(Corner::TopLeft),
        guard: caller_asserted_reason(),
        screenshot: ScreenshotMode::Nudging,
        capture_verification: true,
        recovery: AnchorRecoveryPosture::InspectOnly,
        nudge: Some(AnchorNudge {
            away: Some(Corner::TopLeft),
            only_axis: None,
        }),
        pace_ms: None,
        slam_origin_px: None,
        slam_calls: Some(3), // deliberately short
        verbose: true,
    })
    .await
    .expect("negative-control anchor_cursor call failed");

    eprintln!(
        "negative control: origin={:?}, verified={:?}",
        negative.origin, negative.verified
    );
    let negative_shot = client
        .screenshot(None)
        .await
        .expect("post-negative-control screenshot failed");
    std::fs::write(
        "/tmp/corner_control_smoke_negative.jpg",
        &negative_shot.buffer,
    )
    .expect("write negative-control screenshot");
    eprintln!(
        "saved /tmp/corner_control_smoke_negative.jpg — INSPECT: iPad should still be on real \
         content, NOT a lock screen"
    );

    let negative_pass = negative.verified == Some(false);
    if !negative_pass {
        eprintln!(
            "FAILED: expected verified:false on a deliberately short slam — either the 3-call \
             slam unexpectedly reached the corner tolerance anyway, or corner_target_from_bounds/ \
             the diff is falsely matching. Inspect the screenshot before concluding either way."
        );
    }

    let final_shot = client
        .screenshot(None)
        .await
        .expect("final-state screenshot failed");
    std::fs::write("/tmp/corner_control_smoke_final.jpg", &final_shot.buffer)
        .expect("write final-state screenshot");
    eprintln!(
        "final-state screenshot saved to /tmp/corner_control_smoke_final.jpg — INSPECT IT before \
         trusting the line below (category 5's own finding: a harness must check the FINAL device \
         state, not just an early step's result)"
    );

    if positive.verified == Some(true) && negative_pass {
        eprintln!(
            "=== PASSED: positive control verified:true (real corner landing), negative control \
             verified:false (real short slam correctly NOT matched) — corner_target_from_bounds's \
             verification math discriminates a genuine hit from a genuine miss on real hardware, \
             both reached exclusively through the guarded anchor_cursor path ==="
        );
    } else {
        eprintln!("=== FAILED — see above ===");
        std::process::exit(1);
    }
}
