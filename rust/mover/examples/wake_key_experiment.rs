//! Isolated wake-key experiment — task_69cd3362e1da.
//!
//! Tests ONE narrow question in isolation, per
//! `docs/wake-key-isolated-experiment-plan.md` (reviewed by nixos-dev):
//! does a single `Space` press wake this rig's genuinely-locked iPad to a
//! **visible, still-locked** screen (outcome A), or does it escalate
//! straight to the Touch ID/passcode prompt (outcome B) — regardless of
//! the guard/slam/recovery logic that was tangled with this question 3/3
//! times earlier today.
//!
//! CORRECTION (see the plan doc's own RESULTS section, 2026-08-29): this
//! rig is NOT "no-passcode" as originally assumed — it has Touch ID + a
//! real passcode configured, confirmed live via `unlock_ipad_with_code()`
//! recovering it twice. The live result was genuinely MIXED (not a clean
//! A or B), circumstantially tracking elapsed idle time before the press
//! rather than press count — see the plan doc, not this comment, for the
//! full evidence; don't re-derive from this header alone.
//!
//! Sequence (ONE continuous process, matching this session's own
//! established "don't split a wake-then-observe sequence across a
//! process boundary" finding): baseline screenshot (best-effort) ->
//! Ctrl+Cmd+Q -> 2.5s -> screenshot #2 (confirm lock, retry capture only
//! up to 3x/1s) -> exactly ONE Space press -> 1.5s -> screenshot #3
//! (the result, same capture-only retry) -> STOP. No slam, no
//! `anchor_cursor`, no `CallerAsserted`, no corner anywhere near this.
//!
//! Ground truth is the saved image itself (per this codebase's own
//! "no automated lock-screen classifier" principle) — screenshots are
//! saved for the operator to inspect by eye, not auto-classified here.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example wake_key_experiment -- <trial_n>

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::ipad_unlock::{unlock_ipad, IpadUnlockOptions};
use std::sync::Arc;
use std::time::Duration;

async fn capture_with_retry(client: &PiKVMClient, out_path: &str, label: &str) -> bool {
    for attempt in 1..=3 {
        match client.screenshot(None).await {
            Ok(shot) => {
                std::fs::write(out_path, &shot.buffer).expect("write screenshot");
                eprintln!(
                    "  {label}: saved -> {out_path} ({} bytes)",
                    shot.buffer.len()
                );
                return true;
            }
            Err(e) => {
                eprintln!("  {label}: capture attempt {attempt}/3 failed: {e}");
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }
    eprintln!("  {label}: FAILED after 3 capture attempts — no HID sent for this, per plan");
    false
}

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();
    let passcode = std::env::var("PIKVM_IPAD_PASSCODE").ok();

    let args: Vec<String> = std::env::args().collect();
    let trial_n = args.get(1).map(|s| s.as_str()).unwrap_or("1");

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    eprintln!("=== wake_key_experiment trial {trial_n} ===");

    eprintln!("[1] baseline screenshot (best-effort, informational only)");
    let _ = capture_with_retry(
        &client,
        &format!("/tmp/wake-exp-t{trial_n}-1-baseline.jpg"),
        "baseline",
    )
    .await;

    eprintln!("[2] Ctrl+Cmd+Q (lock)");
    client
        .send_shortcut(&["ControlLeft", "MetaLeft", "KeyQ"])
        .await
        .expect("send lock shortcut");
    tokio::time::sleep(Duration::from_millis(2500)).await;

    eprintln!("[3] screenshot #2 — confirm the lock actually took");
    let locked_captured = capture_with_retry(
        &client,
        &format!("/tmp/wake-exp-t{trial_n}-2-locked.jpg"),
        "post-lock",
    )
    .await;
    if !locked_captured {
        eprintln!("ABORTING trial {trial_n}: no capture channel to confirm the lock — will not send the wake key blind.");
        return;
    }
    eprintln!(
        "  -> STOP AND LOOK at the saved image before trusting this is a genuine lock screen."
    );

    eprintln!("[4] exactly ONE Space press (the wake key under test) — no second press, no Enter, no mouse move");
    client
        .send_key("Space", None)
        .await
        .expect("send single Space press");
    tokio::time::sleep(Duration::from_millis(1500)).await;

    eprintln!("[5] screenshot #3 — the result (classify by eye: A plain-lock / B Touch ID prompt / C unlocked)");
    let result_captured = capture_with_retry(
        &client,
        &format!("/tmp/wake-exp-t{trial_n}-3-result.jpg"),
        "result",
    )
    .await;

    eprintln!("[6] STOP. No further HID sent by this harness beyond the single Space press above.");

    if !result_captured {
        eprintln!("Result capture failed after retries — inconclusive, not classified. iPad may be left mid-transition; recovering via unlock_ipad() as cleanup.");
    }

    // Recovery/cleanup per the plan: run unlock_ipad() regardless of
    // outcome (safe no-op on A, the standard path on B, harmless on C),
    // then take one more confirming screenshot rather than trusting the
    // tool's own return value.
    eprintln!("[cleanup] running unlock_ipad() (Escape->Enter->Space) to return to a normal state");
    match unlock_ipad(&client, IpadUnlockOptions::default()).await {
        Ok(r) => eprintln!("  unlock_ipad() returned: {r:?}"),
        Err(e) => {
            eprintln!("  unlock_ipad() failed: {e} — may need PIKVM_IPAD_PASSCODE escalation")
        }
    }
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let recovered = capture_with_retry(
        &client,
        &format!("/tmp/wake-exp-t{trial_n}-4-cleanup.jpg"),
        "cleanup",
    )
    .await;

    if !recovered {
        eprintln!("cleanup screenshot failed to capture at all.");
    } else if passcode.is_none() {
        eprintln!("(no PIKVM_IPAD_PASSCODE set — if cleanup screenshot still shows Touch ID/passcode prompt, escalate manually)");
    }

    eprintln!("=== trial {trial_n} done — inspect the 4 saved /tmp/wake-exp-t{trial_n}-*.jpg files by eye, classify, do not infer from this log ===");
}
