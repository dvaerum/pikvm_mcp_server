//! One-shot diagnostic: confirm HID mouse is genuinely back in relative
//! (iPad) mode after a mode-switch restore, by BEHAVIOR (a real visible
//! cursor displacement), not by trusting the /api/hid flags alone --
//! this project's own "flags lie, verify behaviorally" rule.
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    let before = client.screenshot(None).await.expect("before screenshot");
    std::fs::write("/tmp/relmode-before.jpg", &before.buffer).unwrap();

    // A real, visible relative displacement -- if this is genuinely
    // relative (iPad) mode, the cursor moves BY this delta from wherever
    // it was; if it's still absolute (desktop) mode, this would either
    // be ignored/misinterpreted or move the cursor to a fixed absolute
    // spot instead, depending on how the target OS reads it.
    client
        .mouse_move_relative(60.0, 60.0)
        .await
        .expect("mouse_move_relative");
    tokio::time::sleep(Duration::from_millis(500)).await;

    let after = client.screenshot(None).await.expect("after screenshot");
    std::fs::write("/tmp/relmode-after.jpg", &after.buffer).unwrap();
    eprintln!("saved /tmp/relmode-before.jpg and /tmp/relmode-after.jpg -- diff by eye");
}
