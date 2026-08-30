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
//! **v5/v6 (2026-08-29), same live session.** Two more non-safety findings
//! before a clean run landed, both manager-approved as they were found:
//! (a) the baseline screenshot (step 1, purely informational) is now
//! best-effort — it 503'd twice at the very first line, before the lock
//! command even ran, because the display can already be dimmed from a
//! prior run's residual state; failing it was never a reason to abort.
//! (b) the `streamer.source.online` hard-abort (originally step 3) is
//! DOWNGRADED to informational-only: live-confirmed it reflects
//! ustreamer's own on-demand run state (idles/stops without a held
//! `/api/ws` session — documented project behavior), not the iPad's
//! actual lock state — a single read AND a 3x-retried read both produced
//! false aborts while a direct screenshot moments later showed the iPad
//! genuinely, stably locked. This codebase already has the right
//! principle for this ("no automated lock-screen classifier... lock-
//! state determination is the operator's job via visual inspection") —
//! so the real gate was always meant to be the human reviewing the
//! confirmation screenshot, not a flag. The wake step now retries the
//! SCREENSHOT itself (up to 5x) until one lands, rather than gating on a
//! flag first.
//!
//! Reviewed by pikvm-mcp-server@nixos-developer-system (confirmed the
//! `CallerAsserted` contract read, `TopLeft` corner safety against iOS's
//! bottom-corner quick actions, and Space-once-not-Enter for the wake
//! step) and signed off by the manager at every revision above, including
//! both non-safety fixes — the actual safety boundary (human reviews a
//! real screenshot, fail-closed on anything but explicit "yes", before
//! the slam) has been untouched since the original review.
//!
//! **v7 (2026-08-29), wake-delay fix from the isolated sweep.** This
//! harness's own repeated Touch-ID escalations today are now explained,
//! not just observed: v1-v6 all sent the wake `Space` press IMMEDIATELY
//! after the lock+2.5s settle — exactly the SHORT-elapsed-delay condition
//! `docs/wake-key-delay-sweep-plan.md`'s controlled sweep found leans
//! Touch ID (2/2 clean B at a 2s delay). That same sweep found an 8s
//! delay leans the other way (2/2 clean A after escalation). Fixed:
//! `WAKE_DELAY_S` sleep inserted before the first wake attempt. Not a
//! guaranteed fix (the sweep's own d4 data point came back inconclusive,
//! so the exact threshold isn't pinned down) — an evidence-based default,
//! not a proven guarantee. The retry loop's own per-attempt re-press
//! behavior (unchanged) is a separate, pre-existing design choice not
//! touched by this fix.
//!
//! **v8 (2026-08-29/30), graceful degrade on an `anchor_cursor` error.**
//! Two live runs both PANICKED right after the slam fired (uncleanly —
//! no cleanup ran), when `anchor_cursor`'s own post-slam verification
//! screenshot hit a transient 503. Both times the actual safety
//! question was already answered BEFORE the crash: the device stayed
//! genuinely locked throughout (confirmed via a fresh screenshot
//! immediately after recovery), so the slam itself was safe both times
//! — the panic was purely a harness robustness gap, not a safety
//! incident. Likely cause: the human-confirmation step (real wall-clock
//! time for an operator to review the screenshot and write the flag)
//! lets the display re-dim again in that gap (this project's own
//! documented short wake window) before the slam's own verification
//! screenshot fires, and the harness's `.expect()` calls turned that
//! transient failure into an uncaught panic. Fixed: both control calls
//! now match on the `anchor_cursor` result — on `Err`, log it, run the
//! SAME recovery (`unlock_ipad()` + final screenshot, factored into
//! `recover_and_report_final_state`) the normal completion path already
//! runs, and exit informatively (code 2, distinct from the "logically
//! failed" exit code 1) instead of crashing. Does not fix the ROOT cause
//! (the display re-dimming during a human-paced confirmation) — that's
//! a real, harder design question left open; this just makes the
//! harness itself robust to it.
//!
//! **v9 (2026-08-30), automatic torn-frame detection + retry.** Two live
//! runs this morning produced a torn/corrupted confirmation screenshot
//! (flood-fill placeholder colour + black bars replacing part or all of
//! the real content) — correctly caught by the human veto both times
//! (never confirmed), zero incidents, but wasting the whole confirm
//! window on an unjudgeable frame. See docs/torn-frame-detection-plan.md
//! (reviewed by nixos-dev) for the real, measured evidence behind this
//! fix. The wake+screenshot loop now runs
//! `pikvm_mcp_detection_vision::torn_frame::analyze_torn_frame` on every
//! captured shot (cropped to the freshly-detected iPad bounds, not a
//! hardcoded rectangle) and retries the CAPTURE — never the wake key — if
//! it's flagged torn: a second wake key is a documented hazard on this
//! rig (dismisses an already-woken lock screen into Touch ID), not just
//! unnecessary. Never blocks or loops forever: a bounds/analysis failure
//! skips the check for that attempt, and a still-torn frame after all 5
//! attempts is presented to the human veto anyway with a warning. The
//! human veto remains the real backstop either way — this closes a
//! reliability gap in front of it, not a replacement for it.
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

use pikvm_mcp_detection_vision::brightness::Region;
use pikvm_mcp_detection_vision::orientation::{detect_ipad_bounds_from_buffer, DetectOptions};
use pikvm_mcp_detection_vision::torn_frame::{analyze_torn_frame, AnalyzeTornFrameOptions};
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::cursor_anchor::{
    anchor_cursor, AnchorGuard, AnchorNudge, AnchorRecoveryPosture, AnchorRequest, Corner,
};
use pikvm_mcp_mover::ipad_unlock::{unlock_ipad, IpadUnlockOptions};
use pikvm_mcp_mover::slam::ScreenshotMode;

const CONFIRM_FLAG_PATH: &str = "/tmp/corner_control_confirm.flag";
const CONFIRM_TIMEOUT_S: u64 = 30;
const ALREADY_LOCKED_FLAG_PATH: &str = "/tmp/corner_control_already_locked.flag";
const ALREADY_LOCKED_TIMEOUT_S: u64 = 15;
/// Elapsed idle time on the confirmed-lit lock screen before the wake
/// `Space` press — see this file's own v7 header note and
/// `docs/wake-key-delay-sweep-plan.md`'s RESULTS: 2s leaned Touch ID
/// (2/2 clean B), 8s leaned plain-lock (2/2 clean A after escalation).
/// An evidence-based default, not a proven guarantee — the sweep's own
/// middle data point (4s) never resolved.
const WAKE_DELAY_S: u64 = 8;

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

/// Poll `path` for up to `timeout_s` seconds. Returns `true` only if the
/// file's trimmed contents are exactly "yes" — anything else (missing,
/// timeout, different content) is treated as "do not proceed," matching
/// the fail-closed discipline every other safety gate in this codebase
/// uses. Shared by both flag gates in this file (the pre-lock "already
/// locked?" check and the pre-slam confirmation) — same semantics, only
/// the path/timeout differ.
async fn wait_for_flag(path: &str, timeout_s: u64) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_s);
    loop {
        if let Ok(contents) = std::fs::read_to_string(path) {
            return contents.trim() == "yes";
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Shared recovery step (v8, 2026-08-29): the real production
/// `unlock_ipad()` path, followed by a final-state screenshot — the
/// SAME recovery this file already runs on a normal completion, now
/// also reachable from an error branch (an `anchor_cursor` call
/// erroring instead of returning, e.g. on a transient capture failure)
/// so an error never skips cleanup and leaves the device state
/// unconfirmed. Best-effort throughout: logs failures rather than
/// panicking again inside an already-degraded path.
async fn recover_and_report_final_state(client: &Arc<PiKVMClient>) {
    eprintln!();
    eprintln!("=== RECOVERY: unlock_ipad() — the real production unlock path ===");
    match unlock_ipad(
        client,
        IpadUnlockOptions {
            verbose: true,
            ..Default::default()
        },
    )
    .await
    {
        Ok(recovery) => {
            eprintln!("recovery message: {}", recovery.message);
            eprintln!("recovery slam_verified: {:?}", recovery.slam_verified);
        }
        Err(e) => eprintln!("recovery unlock_ipad() call itself failed: {e}"),
    }

    match client.screenshot(None).await {
        Ok(shot) => {
            if let Err(e) = std::fs::write("/tmp/corner_control_smoke_final.jpg", &shot.buffer) {
                eprintln!("failed to write final-state screenshot: {e}");
            } else {
                eprintln!(
                    "final-state screenshot saved to /tmp/corner_control_smoke_final.jpg — \
                     INSPECT IT before trusting anything about the current device state."
                );
            }
        }
        Err(e) => eprintln!(
            "final-state screenshot ALSO failed ({e}) — real device state is currently unknown; \
             a human should check it directly before any further automated action."
        ),
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();
    let fallback_mouse_move = std::env::args().any(|a| a == "--fallback-mouse-move");

    for path in [CONFIRM_FLAG_PATH, ALREADY_LOCKED_FLAG_PATH] {
        if std::path::Path::new(path).exists() {
            eprintln!(
                "=== ABORT: {path} already exists from a previous run — delete it first \
                 (rm -f {path}) so this run can't be silently pre-confirmed by stale state. ==="
            );
            std::process::exit(1);
        }
    }

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        // The top-level wake-nudge escalation gate — the guarded slam's
        // own `allow_keyboard_wake_after: true` (below) has NO effect at
        // all unless this is also on. See docs/streamer-source-online-
        // wake-nudge-plan.md + docs/corner-control-allow-keyboard-wake-
        // decision.md for the full reasoning behind enabling this here
        // specifically.
        source_online_wake_nudge: true,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    // Step 1: baseline screenshot — documents the starting state honestly.
    // Best-effort: two live attempts hit this exact display already being
    // dimmed from a moment earlier (the display's wake window is short
    // enough that even the gap between an external wake probe and this
    // process's own startup can close it) — a real 503 here just means
    // "unknown starting state," not grounds to abort.
    let mut baseline_shot = None;
    match client.screenshot(None).await {
        Ok(baseline) => {
            std::fs::write("/tmp/corner_control_smoke_baseline.jpg", &baseline.buffer)
                .expect("write baseline screenshot");
            eprintln!(
                "=== BASELINE: /tmp/corner_control_smoke_baseline.jpg saved. If this is ALREADY \
                 an unambiguous genuine lock screen (clock/wallpaper/home-indicator, no app \
                 content), you can skip the lock+wake steps below entirely — write \"yes\" to \
                 {ALREADY_LOCKED_FLAG_PATH} within {ALREADY_LOCKED_TIMEOUT_S}s to do that. \
                 Otherwise do nothing and the normal lock+wake sequence runs next. ==="
            );
            baseline_shot = Some(baseline);
        }
        Err(e) => {
            eprintln!(
                "=== BASELINE screenshot failed ({e}) — non-fatal, unknown starting state. \
                 Proceeding to the lock command (can't skip it — no baseline image to judge). ==="
            );
        }
    }

    // Step 1.5 (NEW — moves "check the real state before acting" one step
    // earlier, per the manager's framing): if the baseline already looks
    // like a genuine lock screen, skip lock+wake entirely rather than
    // risk escalating an already-locked device toward the Touch ID/
    // passcode prompt. Live-confirmed 2026-08-29 (twice): sending
    // Ctrl+Cmd+Q + one Space to a device that was ALREADY on a plain lock
    // screen behaves like a "second press" relative to its actual state
    // and lands on the Touch ID prompt instead of the plain lock screen —
    // not a safety incident (fail-closed correctly both times, zero HID
    // near a corner), but pointless HID churn against a device already at
    // the target precondition.
    let should_skip_lock = if baseline_shot.is_some() {
        wait_for_flag(ALREADY_LOCKED_FLAG_PATH, ALREADY_LOCKED_TIMEOUT_S).await
    } else {
        false
    };
    let confirm_shot = if let Some(shot) = baseline_shot.filter(|_| should_skip_lock) {
        eprintln!("=== Operator confirmed the baseline is already a genuine lock screen — skipping lock+wake. ===");
        shot
    } else {
        // Step 2: lock — same shortcut pikvm_ipad_lock sends.
        eprintln!("=== Sending Ctrl+Cmd+Q — screen should turn off within 2s ===");
        client
            .send_shortcut(&["ControlLeft", "MetaLeft", "KeyQ"])
            .await
            .expect("send Ctrl+Cmd+Q failed");
        tokio::time::sleep(Duration::from_millis(2500)).await;

        // Step 3 (INFORMATIONAL ONLY, not a gate — see this file's own v5
        // header note): live-confirmed 2026-08-29 that `get_streamer_status`
        // reflects ustreamer's own on-demand run state (this project's
        // documented behavior — it idles/stops without a held `/api/ws`
        // session), not the iPad's actual lock state. A single read AND a
        // 3x-retried read both produced false aborts (reported ONLINE while
        // a direct screenshot moments later showed the iPad genuinely,
        // stably locked). This codebase's own stated design principle
        // already covers exactly this gap: "no automated lock-screen
        // classifier... lock-state determination is the operator's job via
        // visual inspection, not a pixel heuristic." So: log this reading
        // for diagnostics, but the REAL gate is the human reviewing the
        // confirmation screenshot below (step 4/5) — unchanged, still
        // fail-closed on anything but an explicit "yes".
        match client.get_streamer_status().await {
            Ok((online, _resolution)) => {
                eprintln!("(informational) streamer status after lock: online={online}");
            }
            Err(e) => {
                eprintln!("(informational) streamer status read failed: {e}");
            }
        }

        // v7: sleep WAKE_DELAY_S before the wake press — see the header
        // note and docs/wake-key-delay-sweep-plan.md. The screen is
        // confirmed lit and locked at this point (Ctrl+Cmd+Q + 2.5s
        // above); this holds it idle for a controlled duration before
        // the Space press, matching the sweep's own condition (b).
        eprintln!("=== sleeping WAKE_DELAY_S={WAKE_DELAY_S}s before the wake press (evidence-based default from the delay sweep) ===");
        tokio::time::sleep(Duration::from_secs(WAKE_DELAY_S)).await;

        // Step 4: wake + confirmation screenshot, retried as a pair until
        // one succeeds. Retrying the SCREENSHOT ITSELF (not a flag) is the
        // real fix — ustreamer needing a moment to serve a frame is
        // expected and harmless; the process just keeps trying until it
        // gets a real image for the human to judge.
        let mut confirm_shot = None;
        // v9 (docs/torn-frame-detection-plan.md, reviewed by nixos-dev):
        // when a captured frame is automatically flagged torn, this stays
        // true for the next loop iteration so it re-captures WITHOUT
        // re-sending the wake key. Sending a SECOND wake key here is a
        // documented hazard on this rig, not just unnecessary — a second
        // `Space` DISMISSES an already-woken lock screen and brings up the
        // Touch ID/passcode prompt (ipad-unlock.ts's own documented
        // mechanic, reinforced by the wake-key-delay-sweep and by
        // `unlock_ipad()`'s own recovery keys doing exactly this earlier
        // today). The device is presumably already awake by the time a
        // torn frame is detected; only the CAPTURE needs retrying.
        let mut skip_wake = false;
        for attempt in 1..=5 {
            if skip_wake {
                eprintln!(
                    "=== Attempt {attempt}/5: re-capturing after a torn-frame retry (no \
                     re-wake — a second wake key would dismiss the lock screen) ==="
                );
                tokio::time::sleep(Duration::from_millis(500)).await;
            } else {
                if fallback_mouse_move {
                    eprintln!("=== Wake attempt {attempt}/5: small relative mouse move (--fallback-mouse-move) ===");
                    client
                        .mouse_move_relative(5.0, 5.0)
                        .await
                        .expect("wake mouse move failed");
                } else {
                    eprintln!("=== Wake attempt {attempt}/5: single Space press (not Enter) ===");
                    client
                        .send_key("Space", None)
                        .await
                        .expect("wake Space press failed");
                }
                // 1.5s, not 800ms: this project's own documented finding is
                // that a screenshot taken immediately after a UI-dismissing
                // keypress can be a genuinely torn/glitched capture frame
                // (solid-colour fill with a small correct render in one
                // corner) — a streamer mid-transition artifact, not real
                // device state. Live-confirmed 2026-08-29: an 800ms wait
                // produced exactly that. Longer settle reduces how often
                // that happens; the automatic check below and the human
                // step after it are the real backstops either way.
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
            skip_wake = false;
            match client.screenshot(None).await {
                Ok(shot) => {
                    // Automatic torn-frame check (docs/torn-frame-detection-plan.md):
                    // crop to the FRESHLY-detected iPad content bounds, not a
                    // hardcoded rectangle — per-frame bounds drift (auto_crop.rs's
                    // calibration work measured up to ~4.6% edge-delta). Never
                    // blocks: a bounds- or analysis-failure just skips the
                    // automatic check for this attempt and falls through to the
                    // human veto, same as before this feature existed.
                    let region =
                        detect_ipad_bounds_from_buffer(&shot.buffer, DetectOptions::default())
                            .ok()
                            .map(|b| Region {
                                x: b.x,
                                y: b.y,
                                width: b.width,
                                height: b.height,
                            });
                    match analyze_torn_frame(&shot.buffer, AnalyzeTornFrameOptions { region }) {
                        Ok(report) => {
                            eprintln!(
                                "[torn-frame-check] attempt {attempt}/5: uniform_row_fraction={:.3} \
                                 is_torn={}",
                                report.uniform_row_fraction, report.is_torn
                            );
                            if report.is_torn {
                                if attempt < 5 {
                                    eprintln!(
                                        "[torn-frame-check] flagged torn — retrying the capture \
                                         (no re-wake)."
                                    );
                                    skip_wake = true;
                                    continue;
                                }
                                eprintln!(
                                    "[torn-frame-check] WARNING: still flagged torn after 5 \
                                     attempts — presenting to the human veto anyway rather than \
                                     looping forever."
                                );
                            }
                        }
                        Err(e) => {
                            eprintln!(
                                "[torn-frame-check] analysis failed ({e}) — skipping the \
                                 automatic check for this attempt; the human veto below remains \
                                 the backstop."
                            );
                        }
                    }
                    confirm_shot = Some(shot);
                    break;
                }
                Err(e) => {
                    eprintln!(
                    "wake attempt {attempt}/5: screenshot failed ({e}) — ustreamer likely still \
                     spinning up. Retrying."
                );
                }
            }
        }
        confirm_shot.unwrap_or_else(|| {
            eprintln!("=== ABORT: display never produced a screenshot after 5 wake attempts. ===");
            std::process::exit(1);
        })
    };
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
    if !wait_for_flag(CONFIRM_FLAG_PATH, CONFIRM_TIMEOUT_S).await {
        eprintln!(
            "=== ABORT: no \"yes\" confirmation received within {CONFIRM_TIMEOUT_S}s — NOT firing \
             the guarded slam pair. Fail-closed. ==="
        );
        std::process::exit(1);
    }
    eprintln!("=== Confirmed by operator. Proceeding to the guarded slam pair. ===");

    eprintln!("=== 1/2: POSITIVE control — full slam via anchor_cursor(CallerAsserted), expect verified:true ===");
    let positive = match anchor_cursor(AnchorRequest {
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
        // docs/corner-control-allow-keyboard-wake-decision.md (approved
        // by nixos-dev, 2026-08-30): THIS is the one call site currently
        // reasoned through and cleared for the v2 wake-nudge escalation's
        // keyboard path on the post-slam verification screenshot — a
        // human has just confirmed a genuine lock screen, the slam is
        // pure mouse movement (no keys, no clicks), so mouse movement
        // alone cannot have changed that state.
        allow_keyboard_wake_after: true,
        verbose: true,
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // v8 (2026-08-29): graceful degrade instead of a panic. Found
            // live: the slam itself already fired safely by this point
            // (confirmed twice — the device stayed locked throughout both
            // times) before the verification screenshot hit a transient
            // 503, most likely because the human-confirmation step above
            // took real wall-clock time and the display re-dimmed again
            // in that gap (this project's own documented short wake
            // window). An uncaught panic here skipped cleanup entirely.
            // Recover the same way every other error path in this file
            // does, then exit informatively rather than crash.
            eprintln!(
                "=== positive-control anchor_cursor call FAILED (likely transient — the slam may \
                 have already fired safely before this error): {e} ==="
            );
            recover_and_report_final_state(&client).await;
            eprintln!(
                "=== INCONCLUSIVE (infra failure, not a safety incident) — re-run once the \
                 display has settled; see the final-state screenshot to confirm current state. ==="
            );
            std::process::exit(2);
        }
    };

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

    let negative = match anchor_cursor(AnchorRequest {
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
        // Same reasoning as the positive control above, plus an even
        // fresher precondition check (the mid-check screenshot just
        // above this call) — see docs/corner-control-allow-keyboard-
        // wake-decision.md.
        allow_keyboard_wake_after: true,
        verbose: true,
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // v8: same graceful degrade as the positive control above —
            // see that call site's comment for the full rationale.
            eprintln!(
                "=== negative-control anchor_cursor call FAILED (likely transient — the short \
                 slam may have already fired safely before this error): {e} ==="
            );
            recover_and_report_final_state(&client).await;
            eprintln!(
                "=== INCONCLUSIVE (infra failure, not a safety incident) — positive control's \
                 own result (verified={:?}) still stands; re-run for a clean negative control. ===",
                positive.verified
            );
            std::process::exit(2);
        }
    };

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
    // v8: shared with the error branches above via
    // recover_and_report_final_state, so this is the same code path
    // whether the run reached here normally or is degrading from an
    // anchor_cursor error.
    recover_and_report_final_state(&client).await;

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
