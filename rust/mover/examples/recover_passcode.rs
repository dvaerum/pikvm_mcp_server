//! One-shot recovery: unlock_ipad_with_code() when the standard
//! Escape->Enter->Space unlock_ipad() path didn't clear a Touch ID/
//! passcode prompt. Not an experiment -- standard, pre-authorized
//! recovery (PIKVM_IPAD_PASSCODE).
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::ipad_unlock::{unlock_ipad_with_code, UnlockWithCodeOptions};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();
    let passcode = std::env::var("PIKVM_IPAD_PASSCODE").expect("set PIKVM_IPAD_PASSCODE");
    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));
    match unlock_ipad_with_code(&client, &passcode, UnlockWithCodeOptions::default()).await {
        Ok(r) => eprintln!("sent {} digits", r.digits_sent),
        Err(e) => eprintln!("failed: {e}"),
    }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    match client.screenshot(None).await {
        Ok(shot) => {
            std::fs::write("/tmp/recover-passcode-result.jpg", &shot.buffer).unwrap();
            eprintln!("saved");
        }
        Err(e) => eprintln!("post-recovery screenshot failed: {e}"),
    }
}
