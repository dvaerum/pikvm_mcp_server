//! Combined E2E category-2/category-5 live-hardware gate
//! (docs/troubleshooting/2026-08-29-category2-category5-combined-plan-
//! draft.md). Live positive/negative control pair for `corner_target_
//! from_bounds`'s verification math — E2E validation risk category 2,
//! docs/rust-port-plan.md §8 item 2 — run on a GENUINE lock screen, with
//! real recovery via `unlock_ipad()` at the end satisfying category 5's
//! own flagged requirement (a genuine `CallerAsserted`-on-lock-screen
//! positive path through `ipad_unlock.rs`'s real production code).
//!
//! **v4, single-continuous-process (2026-08-29).** v1 called
//! `slam_to_corner` DIRECTLY, bypassing `AnchorGuard` entirely — locked
//! the iPad. v2, through the `AnchorRequest.slam_calls` fix (guard:
//! `CallerAsserted`) — locked the iPad AGAIN: `CallerAsserted` never
//! refuses on the safety question by design, and v2 asserted it on the
//! WRONG precondition (an active screen, not a genuine lock screen —
//! inverting the guard's real contract, *"safe BECAUSE lock screen"*).
//! v3 split lock+wake (Phase A) and the guarded slam (Phase B) into two
//! SEPARATE process invocations with a manual read in between — but the
//! iPad's screen auto-dims back to OFF within a few seconds of waking
//! (this project's own documented short window), and Phase B's own first
//! screenshot 503'd (`streamer.source.online:false`) by the time it ran
//! as a second process. Not a safety incident (no HID went near a corner,
//! clean fail-fast) — a timing-model bug: the lock-vs-dim distinction
//! matters here. Locking (confirmed via the hard-abort streamer check
//! below) does NOT decay over time; only the DISPLAY's wake state does.
//! So this version merges lock+wake+confirm+guarded-slam into ONE
//! continuous process (no inter-process human-reaction-time gap for the
//! display to re-dim across), while keeping a REAL human veto: after
//! saving the confirmation screenshot, the process polls a confirmation
//! file rather than firing the slam unconditionally — the operator reads
//! the (already-saved, non-decaying) screenshot and writes "yes" to
//! unblock it, same real veto power as the v3 two-process design, just
//! without the process-boundary gap that broke on real hardware.
//!
//! Reviewed by pikvm-mcp-server@nixos-developer-system (confirmed the
//! `CallerAsserted` contract read, `TopLeft` corner safety against iOS's
//! bottom-corner quick actions, Space-once-not-Enter for the wake step,
//! the hard-abort-on-streamer-still-online requirement, and the
//! fresh-screenshot-before-guard requirement) and signed off by the
//! manager at each step, including this timing-model revision.
//!
//! Run (writes /tmp/corner_control_confirm.flag — delete any stale copy
//! from a previous run before starting; the process waits up to 30s for
//! it to contain exactly "yes"):
//!   rm -f /tmp/corner_control_confirm.flag
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example cursor_anchor_corner_control_smoke -- [--fallback-mouse-move]

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::cursor_anchor::{
    anchor_cursor, AnchorGuard, AnchorNudge, AnchorRecoveryPosture, AnchorRequest, Corner,
};
use pikvm_mcp_mover::ipad_unlock::{unlock_ipad, IpadUnlockOptions};
use pikvm_mcp_mover::slam::ScreenshotMode;

const CONFIRM_FLAG_PATH: &str = "/tmp/corner_control_confirm.flag";
const CONFIRM_TIMEOUT_S: u64 = 30;

/// Both controls assert safety BECAUSE THIS process's OWN screenshot
/// (saved just before the confirmation wait below, re-confirmed by the
/// operator via that file) showed a genuine lock screen — matches
/// `CallerAsserted`'s real contract, not the inverted precondition v2
/// asserted.
fn caller_asserted_reason() -> AnchorGuard {
    AnchorGuard::CallerAsserted {
        reason: "cursor_anchor_corner_control_smoke v4: operator confirmed via this run's own \
                 saved confirmation screenshot, and by writing \"yes\" to the confirmation flag \
                 file, that the iPad is on a genuine lock screen (matches CallerAsserted's real \
                 contract — safe BECAUSE it's locked, not despite an active screen)."
            .to_string(),
    }
}

/// Poll `CONFIRM_FLAG_PATH` for up to `CONFIRM_TIMEOUT_S` seconds. Returns
/// `true` only if the file's trimmed contents are exactly "yes" — anything
/// else (missing, timeout, different content) is treated as "do not
/// proceed," matching the fail-closed discipline every other safety gate
/// in this codebase uses.
async fn wait_for_confirmation() -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(CONFIRM_TIMEOUT_S);
    loop {
        if let Ok(contents) = std::fs::read_to_string(CONFIRM_FLAG_PATH) {
            return contents.trim() == "yes";
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();
    let fallback_mouse_move = std::env::args().any(|a| a == "--fallback-mouse-move");

    if std::path::Path::new(CONFIRM_FLAG_PATH).exists() {
        eprintln!(
            "=== ABORT: {CONFIRM_FLAG_PATH} already exists from a previous run — delete it first \
             (rm -f {CONFIRM_FLAG_PATH}) so this run can't be silently pre-confirmed by stale \
             state. ==="
        );
        std::process::exit(1);
    }

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    // Step 1: baseline screenshot — documents the starting state honestly,
    // NOT a safety-relevant check (locking is unconditional below and
    // doesn't care whether the pre-lock state was awake or already
    // dimmed). Best-effort: two live attempts hit this exact display
    // already being dimmed from a moment earlier (the display's wake
    // window is short enough that even the gap between an external wake
    // probe and this process's own startup can close it) — a real
    // 503 here is informational-step noise, not grounds to abort before
    // the actual safety-relevant step (the lock command) has even run.
    match client.screenshot(None).await {
        Ok(baseline) => {
            std::fs::write("/tmp/corner_control_smoke_baseline.jpg", &baseline.buffer)
                .expect("write baseline screenshot");
            eprintln!(
                "=== BASELINE: /tmp/corner_control_smoke_baseline.jpg saved (reference only). ==="
            );
        }
        Err(e) => {
            eprintln!(
                "=== BASELINE screenshot failed ({e}) — non-fatal, informational only. Proceeding \
                 to the lock command regardless. ==="
            );
        }
    }

    // Step 2: lock — same shortcut pikvm_ipad_lock sends.
    eprintln!("=== Sending Ctrl+Cmd+Q — screen should turn off within 2s ===");
    client
        .send_shortcut(&["ControlLeft", "MetaLeft", "KeyQ"])
        .await
        .expect("send Ctrl+Cmd+Q failed");
    tokio::time::sleep(Duration::from_millis(2500)).await;

    // Step 3: HARD ABORT if the lock didn't actually take. This is the
    // load-bearing, non-decaying safety fact everything below relies on —
    // unlike display wake state, lock state doesn't revert on its own.
    //
    // Retry-with-grace, mirroring the SAME pattern PiKVMClient's own
    // screenshot path already uses for this exact race (its 503 error
    // text: "Streamer unavailable even after a held /api/ws stream
    // client and one retry"): a single `get_streamer_status` read can
    // catch ustreamer's own on-demand idle-stop/restart noise, unrelated
    // to the iPad's real lock state (live-confirmed 2026-08-29 — a
    // single-shot check reported ONLINE while a direct screenshot taken
    // moments later showed the iPad genuinely, stably locked). Only
    // abort if EVERY attempt reports online — one genuinely-offline read
    // is accepted immediately as confirmation (offline doesn't spuriously
    // flip true the way ustreamer's on-demand online flag can flip on
    // noise).
    let mut confirmed_offline = false;
    for attempt in 1..=3 {
        match client.get_streamer_status().await {
            Ok((false, _resolution)) => {
                confirmed_offline = true;
                break;
            }
            Ok((true, _resolution)) => {
                eprintln!(
                    "streamer status attempt {attempt}/3: reports ONLINE — could be a genuine \
                     failed lock, or ustreamer's own on-demand noise. Retrying before deciding."
                );
            }
            Err(e) => {
                eprintln!("streamer status attempt {attempt}/3: read failed ({e}). Retrying.");
            }
        }
        if attempt < 3 {
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
    }
    if !confirmed_offline {
        eprintln!(
            "=== ABORT: streamer reported ONLINE (or unreadable) on all 3 attempts after \
             Ctrl+Cmd+Q — the lock did NOT take. Not proceeding. ==="
        );
        std::process::exit(1);
    }
    eprintln!(
        "=== Confirmed: streamer source OFFLINE — the lock took (this fact does not decay). ==="
    );

    // Step 4: wake, with ONE retry if the display re-dims before the
    // confirmation screenshot lands (the exact race v3 hit as a separate
    // process — now handled inline, in the same continuous process, with
    // no human-reaction-time gap).
    let mut confirm_shot = None;
    for attempt in 1..=2 {
        if fallback_mouse_move {
            eprintln!("=== Wake attempt {attempt}/2: small relative mouse move (--fallback-mouse-move) ===");
            client
                .mouse_move_relative(5.0, 5.0)
                .await
                .expect("wake mouse move failed");
        } else {
            eprintln!("=== Wake attempt {attempt}/2: single Space press (not Enter) ===");
            client
                .send_key("Space", None)
                .await
                .expect("wake Space press failed");
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
        match client.screenshot(None).await {
            Ok(shot) => {
                confirm_shot = Some(shot);
                break;
            }
            Err(e) => {
                eprintln!("wake attempt {attempt}/2: screenshot failed ({e}) — display may have re-dimmed already.");
            }
        }
    }
    let confirm_shot = confirm_shot.unwrap_or_else(|| {
        eprintln!("=== ABORT: display never produced a screenshot after 2 wake attempts. ===");
        std::process::exit(1);
    });
    std::fs::write(
        "/tmp/corner_control_smoke_confirm.jpg",
        &confirm_shot.buffer,
    )
    .expect("write confirmation screenshot");

    // Step 5: real human veto. The screenshot is already saved (a static
    // file — it does not decay), so the operator's reading time doesn't
    // race against the display. Fail closed: anything but an exact "yes"
    // in the flag file aborts, including a timeout.
    eprintln!(
        "=== CONFIRMATION SCREENSHOT saved to /tmp/corner_control_smoke_confirm.jpg — waiting up \
         to {CONFIRM_TIMEOUT_S}s for {CONFIRM_FLAG_PATH} to contain exactly \"yes\".\n\
         INSPECT THE SCREENSHOT NOW. It must be an unambiguous lock screen (clock/wallpaper/\
         home-indicator, no app content). If genuine: echo -n yes > {CONFIRM_FLAG_PATH}\n\
         If NOT genuine, or ambiguous, or fully unlocked (over-shoot — a safe non-event, no HID \
         near a corner yet): do nothing, let this time out, and re-run with \
         --fallback-mouse-move if the wake over-shot to unlocked. ==="
    );
    if !wait_for_confirmation().await {
        eprintln!(
            "=== ABORT: no \"yes\" confirmation received within {CONFIRM_TIMEOUT_S}s — NOT firing \
             the guarded slam pair. Fail-closed. ==="
        );
        std::process::exit(1);
    }
    eprintln!("=== Confirmed by operator. Proceeding to the guarded slam pair. ===");

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
    // lock screen has no active hot corner"). Category 5's own required
    // coverage, exercised for real rather than in a synthetic test.
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
