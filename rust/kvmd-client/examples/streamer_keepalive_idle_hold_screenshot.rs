//! Low-risk live verification for the liveness ping/pong fix
//! (docs/streamer-keepalive-liveness-ping-plan.md): holds the
//! `PiKVMClient`'s held `/api/ws` connection IDLE for the same ~30s
//! window the real categories-2/5 human-confirmation wait imposes, with
//! NO screenshot/HID traffic at all during the hold — then attempts a
//! real screenshot and reports whether it succeeded, plus the keepalive
//! -connected state before/after.
//!
//! Deliberately does NOT drive any HID or attempt a slam — this only
//! exercises the transport-liveness question the ping/pong fix targets,
//! with far less blast radius than a full categories-2/5 attempt.
//! `streamer_keepalive_smoke.rs`'s existing hold is only 3s (too short
//! to say anything about the zombie-connection window); this extends
//! that idea to the real ~30s window and adds the actual screenshot
//! check the fix needs to prove itself against.
//!
//! Run: PIKVM_PROXY=http://127.0.0.1:8888 cargo run -p pikvm-mcp-kvmd-client
//!      --example streamer_keepalive_idle_hold_screenshot

use std::sync::Arc;
use std::time::{Duration, Instant};

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};

const IDLE_HOLD_S: u64 = 32;

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("PIKVM_HOST not set (source .env first)");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("PIKVM_PASSWORD not set");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    // Retried (unlike the post-idle screenshot below, which is the ACTUAL
    // thing under test): a brand-new client's first-ever snapshot races a
    // SEPARATE, already-documented, pre-existing condition (this crate's
    // own streamer_keepalive.rs header: kvmd's stream-client count going
    // 0->1 has to propagate through its own poll loop and fork+exec+bind
    // ustreamer before the first snapshot can succeed) — not the
    // zombie-connection bug this diagnostic is trying to isolate. Live-
    // confirmed 2026-08-30: 2/2 consecutive cold runs hit exactly this
    // race. Retrying here just gets a connection established at all;
    // it does not touch what's actually being tested below.
    eprintln!("=== warm-up: taking an initial screenshot to establish the held connection ===");
    let mut warm_up_ok = false;
    for attempt in 1..=5 {
        let t0 = Instant::now();
        match client.screenshot(None).await {
            Ok(shot) => {
                eprintln!(
                    "warm-up screenshot OK on attempt {attempt}/5 in {:?} ({} bytes), \
                     streamer_keepalive_connected={}",
                    t0.elapsed(),
                    shot.buffer.len(),
                    client.streamer_keepalive_connected()
                );
                warm_up_ok = true;
                break;
            }
            Err(e) => {
                eprintln!(
                    "warm-up screenshot attempt {attempt}/5 failed ({e}) — likely the \
                     documented cold-start race, not the bug under test. Retrying."
                );
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    if !warm_up_ok {
        eprintln!(
            "=== ABORT: warm-up never succeeded after 5 attempts — nothing to verify. This is \
             itself worth reporting (the cold-start race is worse than 5 attempts can clear), \
             but it isn't evidence about the zombie-connection fix either way. ==="
        );
        std::process::exit(2);
    }

    eprintln!(
        "=== holding IDLE for {IDLE_HOLD_S}s (no screenshot/HID traffic at all) — matches the \
         real categories-2/5 human-confirmation wait window ==="
    );
    tokio::time::sleep(Duration::from_secs(IDLE_HOLD_S)).await;
    eprintln!(
        "after {IDLE_HOLD_S}s idle: streamer_keepalive_connected={}",
        client.streamer_keepalive_connected()
    );

    eprintln!(
        "=== taking the real post-idle screenshot — this is what the fix is tested against ==="
    );
    let t1 = Instant::now();
    match client.screenshot(None).await {
        Ok(shot) => {
            eprintln!(
                "=== SUCCESS: post-idle screenshot OK in {:?} ({} bytes), \
                 streamer_keepalive_connected={} ===",
                t1.elapsed(),
                shot.buffer.len(),
                client.streamer_keepalive_connected()
            );
        }
        Err(e) => {
            eprintln!(
                "=== FAILED: post-idle screenshot still errored ({e}), \
                 streamer_keepalive_connected={} — the fix did not prevent this occurrence \
                 (see the plan doc's own 'bounds, doesn't eliminate' framing: a rare miss here \
                 isn't necessarily the fix failing, but this specific run should be reported \
                 honestly either way). ===",
                client.streamer_keepalive_connected()
            );
            std::process::exit(1);
        }
    }
}
