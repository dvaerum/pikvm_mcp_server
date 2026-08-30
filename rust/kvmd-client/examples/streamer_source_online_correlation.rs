//! Correlated live diagnostic for the follow-up nixos-dev proposed after
//! `streamer_keepalive_idle_hold_screenshot`'s first live result (2026-08-30,
//! docs/rust-port-plan.md §22-§23): the ping/pong fix kept
//! `streamer_keepalive_connected()` reporting `true` throughout a 32s idle
//! hold, yet the post-idle screenshot still 503'd. That result is
//! consistent with `streamer.source.online` (ustreamer's OWN view of
//! whether it currently sees a live capture signal — a different signal
//! entirely from our held WS session's health) flipping independently of
//! the WS keepalive.
//!
//! This polls BOTH signals — `client.streamer_keepalive_connected()` and
//! `client.get_streamer_status()`'s `online` field — at regular intervals
//! throughout the same ~30s idle window, then attempts the real
//! post-idle screenshot and logs both signals immediately around that
//! attempt too. If `source.online` flips false independent of
//! `streamer_keepalive_connected` staying `true`, and that flip lines up
//! with the screenshot failure, that's real, direct, correlated evidence
//! pointing at ustreamer's own process/capture-source layer.
//!
//! Caveat carried forward from nixos-dev's own review: `source.online`
//! already produced a false read once earlier this session unrelated to
//! real device state — treat any single correlated reading as a data
//! point, not a verdict, same as everything else tonight.
//!
//! Run: PIKVM_PROXY=http://127.0.0.1:8888 cargo run -p pikvm-mcp-kvmd-client
//!      --example streamer_source_online_correlation

use std::sync::Arc;
use std::time::{Duration, Instant};

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};

const IDLE_HOLD_S: u64 = 32;
const POLL_INTERVAL_S: u64 = 4;

async fn log_both_signals(client: &PiKVMClient, label: &str, t0: Instant) {
    let keepalive_connected = client.streamer_keepalive_connected();
    let source_online = match client.get_streamer_status().await {
        Ok((online, _res)) => format!("{online}"),
        Err(e) => format!("ERROR({e})"),
    };
    eprintln!(
        "[{:>6.1}s] {label}: streamer_keepalive_connected={keepalive_connected} \
         source.online={source_online}",
        t0.elapsed().as_secs_f64()
    );
}

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
    let t0 = Instant::now();

    eprintln!("=== sending one wake key (Space) before establishing the connection ===");
    if let Err(e) = client.send_key("Space", None).await {
        eprintln!(
            "wake key send failed ({e}) — proceeding anyway, the warm-up retry below covers it."
        );
    }
    tokio::time::sleep(Duration::from_secs(2)).await;

    eprintln!("=== warm-up: taking an initial screenshot to establish the held connection ===");
    let mut warm_up_ok = false;
    for attempt in 1..=5 {
        match client.screenshot(None).await {
            Ok(shot) => {
                eprintln!(
                    "warm-up screenshot OK on attempt {attempt}/5 ({} bytes)",
                    shot.buffer.len()
                );
                warm_up_ok = true;
                break;
            }
            Err(e) => {
                eprintln!(
                    "warm-up screenshot attempt {attempt}/5 failed ({e}) — likely the \
                     documented cold-start race, not what this diagnostic is measuring. Retrying."
                );
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    if !warm_up_ok {
        eprintln!(
            "=== ABORT: warm-up never succeeded after 5 attempts — nothing to correlate. ==="
        );
        std::process::exit(2);
    }
    log_both_signals(&client, "warm-up", t0).await;

    eprintln!(
        "=== holding IDLE for {IDLE_HOLD_S}s, polling both signals every {POLL_INTERVAL_S}s (no \
         screenshot traffic at all — the polls below use get_streamer_status(), a separate \
         lightweight REST call, not /streamer/snapshot) ==="
    );
    let mut elapsed = 0u64;
    while elapsed < IDLE_HOLD_S {
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_S)).await;
        elapsed += POLL_INTERVAL_S;
        log_both_signals(&client, "idle-hold poll", t0).await;
    }

    eprintln!("=== taking the real post-idle screenshot — correlating against both signals ===");
    log_both_signals(&client, "immediately before screenshot", t0).await;
    match client.screenshot(None).await {
        Ok(shot) => {
            eprintln!(
                "=== SUCCESS: post-idle screenshot OK ({} bytes) ===",
                shot.buffer.len()
            );
        }
        Err(e) => {
            eprintln!("=== FAILED: post-idle screenshot errored ({e}) ===");
        }
    }
    log_both_signals(&client, "immediately after screenshot", t0).await;
}
