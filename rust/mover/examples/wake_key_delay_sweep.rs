//! Wake-key delay sweep — task_69cd3362e1da follow-up, per
//! `docs/wake-key-delay-sweep-plan.md` (reviewed by nixos-dev, all 4
//! review points incorporated). One INVOCATION = one trial at one
//! `DELAY_S` value; run it round-robin across delay values
//! (8,4,2,8,4,2,...) rather than blocked by value — that interleaving
//! is an OPERATOR discipline this binary can't enforce by itself (each
//! invocation is independent), so the run order lives in how it's
//! invoked, not in this code.
//!
//! Sequence (ONE continuous process per trial, same "don't split a
//! wake-then-observe sequence across a process boundary" discipline as
//! `wake_key_experiment.rs`): baseline (best-effort) -> Ctrl+Cmd+Q ->
//! 2.5s -> screenshot #2 (confirm lock, capture-only 3x/1s retry,
//! records its own timestamp) -> sleep DELAY_S -> exactly ONE Space
//! press (records its own timestamp) -> 1.5s -> screenshot #3 (the
//! result) -> STOP -> recovery. No slam, no `anchor_cursor`, no corner
//! anywhere near this.
//!
//! Per the reviewed plan: logs the ACTUAL measured wall-clock gap
//! between screenshot #2's capture and the Space press, not just the
//! nominal DELAY_S label (capture jitter could be the same order of
//! magnitude as the 2s spacing between swept values). Ground truth for
//! outcome (A/B/C) AND screenshot #2's own relative brightness (a free
//! signal for whether the backlight-dim timer had already started) is
//! the saved images themselves, classified by eye — not automated here.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-mover --example wake_key_delay_sweep -- <delay_s> <round_n>

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::ipad_unlock::{unlock_ipad, IpadUnlockOptions};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    let delay_s: u64 = args
        .get(1)
        .expect("usage: wake_key_delay_sweep <delay_s> <round_n>")
        .parse()
        .expect("delay_s must be an integer number of seconds");
    let round_n = args.get(2).map(|s| s.as_str()).unwrap_or("1");
    let tag = format!("d{delay_s}-r{round_n}");

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    eprintln!("=== wake_key_delay_sweep: delay={delay_s}s round={round_n} ===");

    eprintln!("[1] baseline screenshot (best-effort, informational only)");
    let _ = capture_with_retry(
        &client,
        &format!("/tmp/wake-sweep-{tag}-1-baseline.jpg"),
        "baseline",
    )
    .await;

    eprintln!("[2] Ctrl+Cmd+Q (lock)");
    client
        .send_shortcut(&["ControlLeft", "MetaLeft", "KeyQ"])
        .await
        .expect("send lock shortcut");
    tokio::time::sleep(Duration::from_millis(2500)).await;

    eprintln!("[3] screenshot #2 — confirm the lock actually took (also: note this image's OWN relative brightness by eye — the free dim-timer signal the plan calls for)");
    let locked_captured = capture_with_retry(
        &client,
        &format!("/tmp/wake-sweep-{tag}-2-locked.jpg"),
        "post-lock",
    )
    .await;
    if !locked_captured {
        eprintln!(
            "ABORTING: no capture channel to confirm the lock — will not send the wake key blind."
        );
        return;
    }
    let lock_confirmed_at = Instant::now();
    eprintln!(
        "  -> STOP AND LOOK at the saved image before trusting this is a genuine lock screen."
    );

    eprintln!("[4] sleeping the swept DELAY_S={delay_s}s (screen confirmed lit and locked, now idle for a controlled duration)");
    tokio::time::sleep(Duration::from_secs(delay_s)).await;

    eprintln!("[5] exactly ONE Space press (the wake key under test)");
    client
        .send_key("Space", None)
        .await
        .expect("send single Space press");
    let space_sent_at = Instant::now();
    let measured_gap = space_sent_at.duration_since(lock_confirmed_at);
    eprintln!(
        "  MEASURED gap (screenshot-#2-capture-succeeded -> Space sent) = {:.3}s (nominal DELAY_S={delay_s}s + real capture/scheduling overhead — log this, not just the label, per the reviewed plan)",
        measured_gap.as_secs_f64()
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;

    eprintln!("[6] screenshot #3 — the result (classify by eye: A plain-lock / B Touch ID prompt / C unlocked)");
    let result_captured = capture_with_retry(
        &client,
        &format!("/tmp/wake-sweep-{tag}-3-result.jpg"),
        "result",
    )
    .await;

    eprintln!("[7] STOP. No further HID sent by this harness beyond the single Space press above.");

    if !result_captured {
        eprintln!("Result capture failed after retries — inconclusive, not classified. Recovering via unlock_ipad() as cleanup.");
    }

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
        &format!("/tmp/wake-sweep-{tag}-4-cleanup.jpg"),
        "cleanup",
    )
    .await;

    if !recovered {
        eprintln!("cleanup screenshot failed to capture at all.");
    } else if passcode.is_none() {
        eprintln!("(no PIKVM_IPAD_PASSCODE set — if cleanup screenshot still shows Touch ID/passcode prompt, escalate manually)");
    }

    eprintln!(
        "=== delay={delay_s}s round={round_n} done — measured gap {:.3}s — inspect the 4 saved \
         /tmp/wake-sweep-{tag}-*.jpg files by eye (screenshot #2's own brightness too), classify, \
         do not infer from this log ===",
        measured_gap.as_secs_f64()
    );
}
