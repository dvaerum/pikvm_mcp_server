//! Isolates a real confound in tonight's own evidence
//! (docs/rust-port-plan.md §22-§26, 2026-08-30): EVERY "a fresh client
//! recovered it" observation tonight also happened to send a real wake
//! key (`Space`) to the iPad as part of that same verification step —
//! never tested separately from "a fresh connection." The separate-
//! keepalive revival test (§26) just showed a bare new WS connection
//! event, with NO wake key, does NOT revive `source.online`. This tests
//! the other half: does sending a wake key through the SAME already-
//! stuck client (no new connection at all) revive it?
//!
//! If sending a wake key alone (through the SAME connection that's
//! already reporting `source.online=false`) revives it, that's real
//! evidence the mechanism was never about kvmd/ustreamer's connection
//! bookkeeping at all — it's that the iPad's own display needs a real
//! redraw/refresh event, which nothing purely server-side (a new WS
//! connection, a REST ping, a ping/pong keepalive) can ever substitute
//! for.
//!
//! Run: PIKVM_PROXY=http://127.0.0.1:8888 cargo run -p pikvm-mcp-kvmd-client
//!      --example streamer_source_wake_key_revival_test

use std::sync::Arc;
use std::time::{Duration, Instant};

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};

const MAX_WAIT_FOR_FLIP_S: u64 = 90;
const POLL_INTERVAL_S: u64 = 4;

async fn source_online(client: &PiKVMClient) -> Option<bool> {
    client
        .get_streamer_status()
        .await
        .ok()
        .map(|(online, _)| online)
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
                eprintln!("warm-up screenshot attempt {attempt}/5 failed ({e}). Retrying.");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    if !warm_up_ok {
        eprintln!("=== ABORT: warm-up never succeeded after 5 attempts — nothing to test. ===");
        std::process::exit(2);
    }

    eprintln!(
        "=== holding IDLE (no screenshot/HID traffic at all) until source.online flips false, \
         up to {MAX_WAIT_FOR_FLIP_S}s ==="
    );
    let mut flipped = false;
    let mut waited = 0u64;
    while waited < MAX_WAIT_FOR_FLIP_S {
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_S)).await;
        waited += POLL_INTERVAL_S;
        match source_online(&client).await {
            Some(true) => eprintln!(
                "[{:>6.1}s] source.online=true (still alive, waiting)",
                t0.elapsed().as_secs_f64()
            ),
            Some(false) => {
                eprintln!(
                    "[{:>6.1}s] source.online=false — flipped, proceeding to the wake-key \
                     revival test (SAME client, SAME connection, no new WS handshake at all)",
                    t0.elapsed().as_secs_f64()
                );
                flipped = true;
                break;
            }
            None => eprintln!(
                "[{:>6.1}s] get_streamer_status() itself errored — treating as not-yet-flipped, \
                 retrying",
                t0.elapsed().as_secs_f64()
            ),
        }
    }
    if !flipped {
        eprintln!(
            "=== source.online never flipped false within {MAX_WAIT_FOR_FLIP_S}s this run — \
             nothing to test THIS time. Not a failure of this diagnostic. ==="
        );
        std::process::exit(3);
    }

    eprintln!(
        "=== sending ONE wake key (Space) through the SAME already-stuck client — no new \
         connection, no new client object, nothing else changes ==="
    );
    match client.send_key("Space", None).await {
        Ok(()) => eprintln!("wake key send OK"),
        Err(e) => eprintln!("wake key send itself FAILED ({e}) — proceeding to check anyway"),
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;

    eprintln!("=== checking whether source.online revived after the wake key alone ===");
    match source_online(&client).await {
        Some(true) => eprintln!(
            "=== REVIVED: source.online=true after a bare wake key through the SAME stuck \
             client/connection — this was never about connection bookkeeping at all; it's the \
             iPad's own display needing a real redraw event. ==="
        ),
        Some(false) => eprintln!(
            "=== NOT REVIVED: source.online still false after the wake key alone — rules out \
             the pure display-redraw hypothesis too; whatever combination actually revives it \
             hasn't been isolated yet. ==="
        ),
        None => {
            eprintln!("=== INCONCLUSIVE: get_streamer_status() itself errored on this check. ===")
        }
    }

    eprintln!("=== also trying the same client's real screenshot for a direct confirmation ===");
    match client.screenshot(None).await {
        Ok(shot) => eprintln!(
            "=== screenshot SUCCEEDED ({} bytes) — direct confirmation. ===",
            shot.buffer.len()
        ),
        Err(e) => eprintln!("=== screenshot still FAILED ({e}) ==="),
    }
}
