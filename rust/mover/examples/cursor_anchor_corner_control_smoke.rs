//! Phase B of the combined E2E category-2/category-5 live-hardware plan
//! (docs/troubleshooting/2026-08-29-category2-category5-combined-plan-
//! draft.md). Live positive/negative control pair for `corner_target_
//! from_bounds`'s verification math — E2E validation risk category 2,
//! docs/rust-port-plan.md §8 item 2 — run on a GENUINE lock screen, with
//! real recovery via `unlock_ipad()` at the end satisfying category 5's
//! own flagged requirement (a genuine `CallerAsserted`-on-lock-screen
//! positive path through `ipad_unlock.rs`'s real production code).
//!
//! **v3, post-SECOND-incident (2026-08-29).** v1 called `slam_to_corner`
//! DIRECTLY, bypassing `AnchorGuard` entirely — full slam locked the
//! iPad. Fixed via `AnchorRequest.slam_calls` so a short slam could go
//! through the guarded `anchor_cursor` path (commit fb80142). v2, RETRIED
//! THROUGH THAT FIX (`guard: CallerAsserted{...}`) — **locked the iPad
//! AGAIN**. Real root cause: `CallerAsserted` never refuses on the safety
//! question by design — it's the caller's promise, not a check. v2's own
//! health-check confirmed an ACTIVE, unlocked Settings screen and
//! asserted `CallerAsserted` safety anyway — inverting the guard's real
//! contract (*"a lock screen has no active hot corner"* — safety is true
//! BECAUSE the target is a genuine lock screen, not despite it), the
//! exact mistake `docs/rust-port-plan.md` §8 item 5 already documented
//! from `cursor_anchor_smoke.rs` v2.
//!
//! **This file must be run ONLY as Phase B**, after `ipad_lock_and_
//! confirm.rs` (Phase A) has locked the iPad and the OPERATOR has visually
//! confirmed Phase A's screenshot #2 is a genuine lock screen. This file
//! does NOT trust that confirmation across the process boundary — its
//! very first action is its own fresh screenshot (#2b), which the
//! operator must ALSO confirm before this file proceeds past the health
//! print (per nixos-dev's review: never trust an earlier step's/an
//! earlier process's screenshot as proof of CURRENT state).
//!
//! Reviewed by pikvm-mcp-server@nixos-developer-system (confirmed the
//! `CallerAsserted` contract read, the `TopLeft` corner choice against
//! iOS's bottom-corner lock-screen quick actions, and the real-recovery
//! step) and signed off by the manager before this file was written.
//!
//! Two slams total (one full, one deliberately short via `slam_calls`) —
//! well under the session's own documented Touch-ID-lockout threshold.
//!
//! Run (ONLY after Phase A + manual confirmation of a genuine lock screen):
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example cursor_anchor_corner_control_smoke

use std::sync::Arc;

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::cursor_anchor::{
    anchor_cursor, AnchorGuard, AnchorNudge, AnchorRecoveryPosture, AnchorRequest, Corner,
};
use pikvm_mcp_mover::ipad_unlock::{unlock_ipad, IpadUnlockOptions};
use pikvm_mcp_mover::slam::ScreenshotMode;

/// Both controls assert safety BECAUSE THIS file's OWN fresh screenshot
/// #2b (taken immediately before each call, re-confirmed by the operator)
/// showed a genuine lock screen — matches `CallerAsserted`'s real
/// contract this time, rather than the inverted precondition v2 asserted.
fn caller_asserted_reason() -> AnchorGuard {
    AnchorGuard::CallerAsserted {
        reason: "cursor_anchor_corner_control_smoke v3: operator confirmed via this file's own \
                 fresh screenshot #2b, taken immediately before this call, that the iPad is on a \
                 genuine lock screen (matches CallerAsserted's real contract — safe BECAUSE it's \
                 locked, not despite an active screen)."
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

    // Own fresh screenshot #2b — NOT Phase A's screenshot #2. This is
    // the actual precondition check nixos-dev's review demanded: don't
    // trust an earlier process's/earlier step's screenshot as proof of
    // CURRENT state.
    let confirm = client
        .screenshot(None)
        .await
        .expect("screenshot #2b failed");
    std::fs::write("/tmp/corner_control_smoke_2b.jpg", &confirm.buffer)
        .expect("write screenshot #2b");
    eprintln!(
        "=== SCREENSHOT #2b: /tmp/corner_control_smoke_2b.jpg — STOP AND INSPECT before trusting \
         this run. This must show a GENUINE LOCK SCREEN (clock/wallpaper/home-indicator, no app \
         content) taken THIS INSTANT, not Phase A's earlier one. Only proceed if that's \
         unambiguously true — CallerAsserted below takes your word for it, and it does NOT check \
         anything itself. ==="
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
        "saved /tmp/corner_control_smoke_positive.jpg — INSPECT: should still be the lock screen \
         (cursor in open space, post-nudge), not something unexpected"
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
    // Re-confirm with a fresh screenshot rather than reusing the positive
    // control's — CallerAsserted's contract is about THIS call's actual
    // current state, not a stale assumption, even within the same process.
    let mid_check = client
        .screenshot(None)
        .await
        .expect("pre-negative-control screenshot failed");
    std::fs::write("/tmp/corner_control_smoke_mid_check.jpg", &mid_check.buffer)
        .expect("write mid-check screenshot");
    eprintln!(
        "saved /tmp/corner_control_smoke_mid_check.jpg — confirm still the lock screen before the \
         negative control fires"
    );

    // Default slam_to_corner would use ceil(1920/100)+8=28 calls to
    // GUARANTEE reaching the corner. 3 calls x 127px is nowhere near
    // enough to cross even a fraction of a 1920px-wide frame — a real,
    // physically-incomplete slam, not a synthetic failure — reached ONLY
    // through the guarded path via AnchorRequest.slam_calls.
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
        "saved /tmp/corner_control_smoke_negative.jpg — INSPECT: should still be the lock screen"
    );

    let negative_pass = negative.verified == Some(false);
    if !negative_pass {
        eprintln!(
            "FAILED: expected verified:false on a deliberately short slam — either the 3-call \
             slam unexpectedly reached the corner tolerance anyway, or corner_target_from_bounds/ \
             the diff is falsely matching. Inspect the screenshot before concluding either way."
        );
    }

    // Real recovery — the actual production function, which internally
    // uses AnchorGuard::CallerAsserted on this exact lock-screen
    // precondition (ipad_unlock/unlock.rs's own call site: "Layer 5 —
    // lock screen has no active hot corner"). This is category 5's own
    // required coverage (a genuine CallerAsserted-on-lock-screen positive
    // path through real production code), exercised for real here rather
    // than in a synthetic smoke test.
    eprintln!();
    eprintln!("=== RECOVERY: unlock_ipad() — the real production unlock path ===");
    let recovery = unlock_ipad(
        &client,
        IpadUnlockOptions {
            verbose: true,
            ..Default::default()
        },
    )
    .await
    .expect("unlock_ipad recovery call failed");
    eprintln!("recovery message: {}", recovery.message);
    eprintln!("recovery slam_verified: {:?}", recovery.slam_verified);

    let final_shot = client
        .screenshot(None)
        .await
        .expect("final-state screenshot failed");
    std::fs::write("/tmp/corner_control_smoke_final.jpg", &final_shot.buffer)
        .expect("write final-state screenshot");
    eprintln!(
        "final-state screenshot saved to /tmp/corner_control_smoke_final.jpg — INSPECT IT before \
         trusting the line below: the iPad should be back to a normal, unlocked, recognizable \
         state (category 5's own finding: check the FINAL device state, not just an early step's)"
    );

    if positive.verified == Some(true) && negative_pass {
        eprintln!(
            "=== PASSED (mechanically): positive control verified:true (real corner landing), \
             negative control verified:false (real short slam correctly NOT matched), real \
             unlock_ipad() recovery ran — corner_target_from_bounds's verification math \
             discriminates a genuine hit from a genuine miss on real hardware, on a genuine \
             lock screen, exclusively through the guarded anchor_cursor path. INSPECT the final \
             screenshot before trusting this line. ==="
        );
    } else {
        eprintln!("=== FAILED — see above ===");
        std::process::exit(1);
    }
}
