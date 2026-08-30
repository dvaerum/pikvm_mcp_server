//! Isolates "a genuinely new `/api/ws` connection handshake" from "a
//! whole new `PiKVMClient` object" (nixos-dev's follow-up to §25's
//! observation, docs/rust-port-plan.md, 2026-08-30): a fresh client
//! revived a zombied `source.online`, but that fresh client also came
//! with a fresh belief/calibration state — this isolates the connection
//! event specifically, with zero production code changes.
//!
//! Holds the ORIGINAL client's connection idle until `source.online`
//! flips false (confirmed via its own `get_streamer_status()`), then
//! constructs a completely SEPARATE, independent `StreamerKeepalive`
//! (same config, no shared state, `StreamerKeepalive::new` and
//! `StreamerKeepaliveConfig` are both already `pub`) and calls
//! `ensure_started()` on THAT object only — then checks whether the
//! ORIGINAL client's `source.online` revives. If it does, that's clean
//! confirmation the trigger is any new connection handshake to the
//! target, not something specific to constructing a new `PiKVMClient`.
//!
//! Run: PIKVM_PROXY=http://127.0.0.1:8888 cargo run -p pikvm-mcp-kvmd-client
//!      --example streamer_source_new_connection_revival_test

use std::sync::Arc;
use std::time::{Duration, Instant};

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_kvmd_client::streamer_keepalive::{StreamerKeepalive, StreamerKeepaliveConfig};

/// Give up waiting for a natural flip-to-false after this long and just
/// report whatever state was reached — never loop forever on live
/// hardware.
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
        proxy_url: proxy_url.clone(),
        ..PiKVMConfig::new(host.clone(), username.clone(), password.clone())
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
        "=== holding IDLE (no screenshot/HID traffic from the original client) until \
         source.online flips false, up to {MAX_WAIT_FOR_FLIP_S}s ==="
    );
    let mut flipped = false;
    let mut waited = 0u64;
    while waited < MAX_WAIT_FOR_FLIP_S {
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_S)).await;
        waited += POLL_INTERVAL_S;
        match source_online(&client).await {
            Some(true) => eprintln!(
                "[{:>6.1}s] original client: source.online=true (still alive, waiting)",
                t0.elapsed().as_secs_f64()
            ),
            Some(false) => {
                eprintln!(
                    "[{:>6.1}s] original client: source.online=false — flipped, proceeding to \
                     the revival test",
                    t0.elapsed().as_secs_f64()
                );
                flipped = true;
                break;
            }
            None => eprintln!(
                "[{:>6.1}s] original client: get_streamer_status() itself errored — treating as \
                 not-yet-flipped, retrying",
                t0.elapsed().as_secs_f64()
            ),
        }
    }
    if !flipped {
        eprintln!(
            "=== source.online never flipped false within {MAX_WAIT_FOR_FLIP_S}s this run — \
             nothing to test THIS time (the flip is a real but not perfectly deterministic \
             timing, per tonight's own data). Not a failure of this diagnostic. ==="
        );
        std::process::exit(3);
    }

    eprintln!(
        "=== constructing a SEPARATE, independent StreamerKeepalive (same config, no shared \
         state with the original client) and calling ensure_started() on it only ==="
    );
    let revival_keepalive = StreamerKeepalive::new(StreamerKeepaliveConfig {
        host,
        username,
        password,
        verify_ssl: false,
        proxy_url,
    });
    let t_revival = Instant::now();
    revival_keepalive.ensure_started().await;
    eprintln!(
        "revival keepalive: ensure_started() returned in {:?}, connected={}",
        t_revival.elapsed(),
        revival_keepalive.connected()
    );

    eprintln!(
        "=== checking whether the ORIGINAL client's source.online revived after the SEPARATE \
         connection's handshake ==="
    );
    tokio::time::sleep(Duration::from_secs(1)).await;
    match source_online(&client).await {
        Some(true) => eprintln!(
            "=== REVIVED: original client's source.online=true after the separate keepalive's \
             connection event — confirms 'any new connection handshake to this target' as the \
             trigger, independent of constructing a new PiKVMClient. ==="
        ),
        Some(false) => eprintln!(
            "=== NOT REVIVED: original client's source.online still false — the separate \
             keepalive's connection event alone was NOT sufficient; something else about a \
             fresh PiKVMClient (or timing) was doing the work in the earlier observation. ==="
        ),
        None => eprintln!(
            "=== INCONCLUSIVE: get_streamer_status() itself errored on this final check. ==="
        ),
    }

    eprintln!(
        "=== also trying the original client's real screenshot for a direct confirmation ==="
    );
    match client.screenshot(None).await {
        Ok(shot) => eprintln!(
            "=== original client's screenshot SUCCEEDED ({} bytes) — direct confirmation. ===",
            shot.buffer.len()
        ),
        Err(e) => eprintln!("=== original client's screenshot still FAILED ({e}) ==="),
    }

    revival_keepalive.stop();
}
