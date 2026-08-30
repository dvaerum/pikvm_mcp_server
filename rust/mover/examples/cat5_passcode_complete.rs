//! Throwaway: complete category 5's positive path by finishing the
//! unlock with the stored passcode (manager-approved, same already-
//! established credential path as the TS `unlock_with_code({useStoredCode:true})`).
//! Device confirmed (fresh screenshot, just inspected) to be back on the
//! plain lock screen -- exactly the starting state `unlock_ipad_with_code`
//! is designed for (Space->Space->digits->Enter).
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::ipad_unlock::{unlock_ipad_with_code, UnlockWithCodeOptions};

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
        source_online_wake_nudge: true,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = PiKVMClient::new(config, None);

    println!("=== calling unlock_ipad_with_code ===");
    match unlock_ipad_with_code(&client, &passcode, UnlockWithCodeOptions::default()).await {
        Ok(r) => println!("OK: digits_sent={}", r.digits_sent),
        Err(e) => {
            println!("ERROR: {e}");
            return;
        }
    }

    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    match client.screenshot(None).await {
        Ok(r) => {
            std::fs::write("/tmp/cat5_passcode_result.jpg", &r.buffer).unwrap();
            println!("saved result screenshot: {} bytes", r.buffer.len());
        }
        Err(e) => println!("post-unlock screenshot FAIL: {e:?}"),
    }
}
