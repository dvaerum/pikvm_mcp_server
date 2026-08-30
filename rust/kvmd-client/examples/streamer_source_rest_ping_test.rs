//! Follow-up to `streamer_source_online_correlation`'s clean result
//! (2026-08-30, docs/rust-port-plan.md §24): `source.online` flipped
//! false at ~10.7s into the idle hold — suspiciously close to kvmd's own
//! documented ~10s ustreamer idle-stop-after-disconnect window
//! (`kvmd-client/src/client/core.rs`'s header comment) — while the held
//! WS connection (which DOES request `stream=1`, confirmed in
//! `connection.rs`'s `real_connect`) stayed healthy throughout.
//!
//! nixos-dev's hypothesis: kvmd's idle-stop bookkeeping for the SOURCE/
//! capture layer may be driven by REST `/streamer/snapshot` request
//! recency, NOT by whether a WS stream subscriber is connected — a
//! separate counter our keepalive was never built to satisfy. This test
//! adds a periodic THROWAWAY `/streamer/snapshot` REST call every ~5s
//! during the SAME ~32s idle window (on top of the existing WS
//! keepalive, unchanged) and checks whether `source.online` now stays
//! `true` for the full window instead of flipping at ~10.7s. If it
//! does, that's direct evidence for the REST-recency hypothesis and
//! points at a different real fix; if it flips at the same point
//! regardless, this specific hypothesis is ruled out.
//!
//! Run: PIKVM_PROXY=http://127.0.0.1:8888 cargo run -p pikvm-mcp-kvmd-client
//!      --example streamer_source_rest_ping_test

use std::sync::Arc;
use std::time::{Duration, Instant};

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};

const IDLE_HOLD_S: u64 = 32;
const POLL_INTERVAL_S: u64 = 4;
/// Throwaway REST snapshot ping cadence — deliberately shorter than
/// kvmd's ~10s idle-stop window, same reasoning as the ping/pong fix's
/// own PING_INTERVAL_MS anchor.
const REST_PING_INTERVAL_S: u64 = 5;

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
        eprintln!("=== ABORT: warm-up never succeeded after 5 attempts — nothing to test. ===");
        std::process::exit(2);
    }
    log_both_signals(&client, "warm-up", t0).await;

    eprintln!(
        "=== holding IDLE for {IDLE_HOLD_S}s, but with a THROWAWAY /streamer/snapshot REST call \
         every {REST_PING_INTERVAL_S}s (in addition to the WS keepalive, unchanged) — this is \
         the actual thing under test: does REST-request recency keep source.online alive? ==="
    );
    let mut elapsed = 0u64;
    let mut next_rest_ping = REST_PING_INTERVAL_S;
    let mut next_signal_poll = POLL_INTERVAL_S;
    while elapsed < IDLE_HOLD_S {
        tokio::time::sleep(Duration::from_secs(1)).await;
        elapsed += 1;
        if elapsed >= next_rest_ping {
            next_rest_ping += REST_PING_INTERVAL_S;
            match client.screenshot(None).await {
                Ok(shot) => eprintln!(
                    "[{:>6.1}s] throwaway REST ping OK ({} bytes)",
                    t0.elapsed().as_secs_f64(),
                    shot.buffer.len()
                ),
                Err(e) => eprintln!(
                    "[{:>6.1}s] throwaway REST ping FAILED ({e})",
                    t0.elapsed().as_secs_f64()
                ),
            }
        }
        if elapsed >= next_signal_poll {
            next_signal_poll += POLL_INTERVAL_S;
            log_both_signals(&client, "idle-hold poll", t0).await;
        }
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
