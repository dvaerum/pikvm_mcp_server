//! Phase A of the combined E2E category-2/category-5 live-hardware plan
//! (docs/troubleshooting/2026-08-29-category2-category5-combined-plan-
//! draft.md, reviewed by pikvm-mcp-server@nixos-developer-system and
//! signed off by the manager after two real lock incidents this session).
//!
//! Deliberately locks the iPad (`Ctrl+Cmd+Q`, the same shortcut
//! `pikvm_ipad_lock` sends) and wakes it to a still-locked, visible lock
//! screen — NO slam, NO guard use, NO corner anywhere near this file.
//! Exits after saving screenshot #2 so the operator can inspect it before
//! deciding whether Phase B (`cursor_anchor_corner_control_smoke.rs`) is
//! safe to run — two SEPARATE process invocations by design, per the
//! plan's own "a saved screenshot is inspectable after the fact even
//! though the lock action itself is time-sensitive" reasoning.
//!
//! Wake mechanism: send `Space` ONCE, not `Enter` and not the full
//! Escape→Enter→Space unlock sequence. Per `ipad-unlock.ts`'s own
//! `unlockIpadWithCode` doc (lines 560-614, confirmed by nixos-dev's
//! review): a single Space wakes the screen still-locked; a second press
//! (or Enter, which `ipad-unlock.ts:62` documents as "the actual unlock
//! key on iPadOS 26 lock screens") dismisses it. Real caveat (nixos-dev,
//! unresolved): unclear whether this holds identically on a NO-PASSCODE
//! config (this rig's documented default) — so screenshot #2 stays the
//! actual arbiter regardless of what this file assumes.
//!
//! `--fallback-mouse-move`: per the plan's defined over-shoot handling —
//! if a previous run showed Space woke the screen ALL THE WAY to unlocked
//! (a safe non-event, no HID went near a corner), re-run this file with
//! this flag to use a small relative mouse move instead of a keypress for
//! the wake step (a move is less likely to be OS-interpreted as
//! "proceed/unlock" the way a key can be). Still re-locks first either way
//! — this flag only changes the WAKE step, not whether locking happens.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example ipad_lock_and_confirm -- [--fallback-mouse-move]

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();
    let fallback_mouse_move = std::env::args().any(|a| a == "--fallback-mouse-move");

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    // Step 1: baseline screenshot — documents the starting state honestly,
    // not a safety-relevant check (locking is unconditional below).
    let baseline = client
        .screenshot(None)
        .await
        .expect("baseline screenshot failed");
    std::fs::write("/tmp/ipad_lock_confirm_baseline.jpg", &baseline.buffer)
        .expect("write baseline screenshot");
    eprintln!(
        "=== BASELINE: /tmp/ipad_lock_confirm_baseline.jpg saved — this is the state before \
         locking, for reference only. ==="
    );

    // Step 2: send Ctrl+Cmd+Q — same shortcut pikvm_ipad_lock sends.
    eprintln!(
        "=== Sending Ctrl+Cmd+Q (iPadOS Lock Screen shortcut) — screen should turn off within 2s ==="
    );
    client
        .send_shortcut(&["ControlLeft", "MetaLeft", "KeyQ"])
        .await
        .expect("send Ctrl+Cmd+Q failed");

    // Step 3: sleep past the documented 2s window with a small margin.
    tokio::time::sleep(Duration::from_millis(2500)).await;

    // Step 4: HARD ABORT if the lock didn't actually take. This is the
    // objective, non-visual ground-truth signal (streamer.source.online)
    // this project already uses elsewhere — not a pixel heuristic.
    let (source_online, _resolution) = client
        .get_streamer_status()
        .await
        .expect("get_streamer_status failed");
    if source_online {
        eprintln!(
            "=== ABORT: streamer still reports source ONLINE 2.5s after Ctrl+Cmd+Q — the lock \
             action did NOT take. NOT proceeding to the wake step against a screen that was never \
             off. Check the rig manually before retrying. ==="
        );
        std::process::exit(1);
    }
    eprintln!("=== Confirmed: streamer source OFFLINE — the lock took. ===");

    // Step 5: wake — Space once (default) or a small relative mouse move
    // (--fallback-mouse-move, for the documented over-shoot case).
    if fallback_mouse_move {
        eprintln!("=== Waking via a small relative mouse move (--fallback-mouse-move) ===");
        client
            .mouse_move_relative(5.0, 5.0)
            .await
            .expect("wake mouse move failed");
    } else {
        eprintln!(
            "=== Waking via a single Space press (NOT Enter, NOT the full unlock sequence) ==="
        );
        client
            .send_key("Space", None)
            .await
            .expect("wake Space press failed");
    }
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Step 6: screenshot #2, save, EXIT. No slam in this phase regardless
    // of what this screenshot shows — that judgment belongs to the
    // operator inspecting it next, per the plan's manual checkpoint.
    let confirm_shot = client
        .screenshot(None)
        .await
        .expect("confirm screenshot failed");
    std::fs::write(
        "/tmp/ipad_lock_confirm_screenshot2.jpg",
        &confirm_shot.buffer,
    )
    .expect("write confirm screenshot");
    eprintln!(
        "=== Screenshot #2 saved to /tmp/ipad_lock_confirm_screenshot2.jpg — STOP HERE. Inspect \
         it before running Phase B (cursor_anchor_corner_control_smoke.rs):\n\
         - Genuine lock screen (clock/wallpaper/home-indicator, no app content) -> Phase B is \
           safe to run.\n\
         - Fully unlocked (wake over-shot) -> safe non-event, no HID went near a corner. Re-run \
           this example with --fallback-mouse-move instead.\n\
         - Anything else (blank/off frame, error, ambiguous) -> stop and reassess manually. ==="
    );
}
