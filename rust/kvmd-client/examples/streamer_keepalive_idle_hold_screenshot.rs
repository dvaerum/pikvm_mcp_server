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

    eprintln!("=== warm-up: taking an initial screenshot to establish the held connection ===");
    let t0 = Instant::now();
    match client.screenshot(None).await {
        Ok(shot) => eprintln!(
            "warm-up screenshot OK in {:?} ({} bytes), streamer_keepalive_connected={}",
            t0.elapsed(),
            shot.buffer.len(),
            client.streamer_keepalive_connected()
        ),
        Err(e) => {
            eprintln!("=== ABORT: warm-up screenshot itself failed ({e}) — nothing to verify. ===");
            std::process::exit(2);
        }
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
