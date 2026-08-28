//! Manual hardware smoke test for `real_connect`/`connect_via_proxy` —
//! NOT unit-testable (real sockets, real TLS, real kvmd auth), so this
//! exercises the actual networking code against the real PiKVM through the
//! real tinyproxy tunnel, mirroring this project's "gate through the real
//! entry point, don't trust the mock" discipline for anything touching the
//! physical rig.
//!
//! Run: PIKVM_PROXY=http://127.0.0.1:8888 cargo run -p pikvm-mcp-kvmd-client
//!      --example streamer_keepalive_smoke

use pikvm_mcp_kvmd_client::streamer_keepalive::{StreamerKeepalive, StreamerKeepaliveConfig};

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("PIKVM_HOST not set (source .env first)");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("PIKVM_PASSWORD not set");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();

    eprintln!("connecting to {host} via proxy={proxy_url:?} ...");

    let ka = StreamerKeepalive::new(StreamerKeepaliveConfig {
        host,
        username,
        password,
        verify_ssl: false,
        proxy_url,
    });

    let t0 = std::time::Instant::now();
    ka.ensure_started().await;
    eprintln!(
        "ensure_started() returned in {:?}, connected={}",
        t0.elapsed(),
        ka.connected()
    );

    if !ka.connected() {
        eprintln!("FAILED: not connected after ensure_started()");
        std::process::exit(1);
    }

    eprintln!("holding the connection for 3s to confirm it stays open...");
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    eprintln!("still connected={}", ka.connected());

    if !ka.connected() {
        eprintln!("FAILED: connection dropped within 3s");
        std::process::exit(1);
    }

    eprintln!("SUCCESS: real CONNECT-tunnel + TLS + WS handshake against the real PiKVM worked");
    ka.stop();
}
