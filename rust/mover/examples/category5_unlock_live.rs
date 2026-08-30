//! Live category-5 positive-path test: a genuine `CallerAsserted`-on-
//! lock-screen run through `unlock_ipad()`'s own real production call
//! site (docs/final-e2e-validation-sign-off-plan.md item 4/category 5),
//! now exercising the `try_key_press_first: false` extension approved in
//! docs/unlock-ipad-allow-keyboard-wake-decision.md (commit bd4c448).
//!
//! Safety: this binary performs ONLY the unlock step. The operator must
//! already have confirmed a genuine lock screen via a SEPARATE, prior
//! health-check screenshot (visually inspected) before running this --
//! exactly as `unlock_ipad`'s own `CallerAsserted` contract requires
//! ("safe BECAUSE it's locked"). `try_key_press_first: Some(false)`
//! skips the key-press-first branch entirely and forces the real,
//! reachable slam_first -> swipe path.

use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::ipad_unlock::{unlock_ipad, IpadUnlockOptions};

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();
    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        // Required for the allow_keyboard_wake_{before,after} escalation
        // (approved for unlock_ipad's internal slam, commit bd4c448) to
        // actually fire -- forgetting this top-level flag is the exact
        // "built but not wired" gap caught earlier for the corner-
        // control-smoke harness. Don't repeat it here.
        source_online_wake_nudge: true,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = std::sync::Arc::new(PiKVMClient::new(config, None));

    println!("=== calling unlock_ipad(try_key_press_first: Some(false)) -- lock screen already visually confirmed ===");
    let result = unlock_ipad(
        &client,
        IpadUnlockOptions {
            try_key_press_first: Some(false),
            verbose: true,
            ..Default::default()
        },
    )
    .await;

    match result {
        Ok(r) => {
            std::fs::write("/tmp/category5_result.jpg", &r.screenshot).unwrap();
            println!(
                "=== unlock_ipad OK: slam_verified={:?}, drag_px={}, chunk_count={}, swipe_duration_ms={} ===",
                r.slam_verified, r.drag_px, r.chunk_count, r.swipe_duration_ms
            );
            println!("=== message: {} ===", r.message);
            println!(
                "=== saved /tmp/category5_result.jpg ({} bytes) ===",
                r.screenshot.len()
            );
        }
        Err(e) => {
            println!("=== unlock_ipad ERROR: {e:?} ===");
        }
    }
}
