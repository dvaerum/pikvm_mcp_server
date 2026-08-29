//! One-shot: unlock (standard path, escalate to passcode if needed) then
//! go home. Prep step for a live-hardware gate, not itself an experiment.
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::ipad_unlock::{
    ipad_go_home, unlock_ipad, unlock_ipad_with_code, IpadHomeOptions, IpadUnlockOptions,
    UnlockWithCodeOptions,
};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();
    let passcode = std::env::var("PIKVM_IPAD_PASSCODE").ok();

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    eprintln!("unlock_ipad()...");
    let _ = unlock_ipad(&client, IpadUnlockOptions::default()).await;
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let shot = client.screenshot(None).await;
    if let Ok(s) = &shot {
        std::fs::write("/tmp/get-home-1-after-unlock.jpg", &s.buffer).unwrap();
    }

    if let Some(code) = passcode {
        eprintln!("escalating with unlock_ipad_with_code() (harmless if already unlocked)...");
        let _ = unlock_ipad_with_code(&client, &code, UnlockWithCodeOptions::default()).await;
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    }

    eprintln!("ipad_go_home(force_home_via_swipe=true)...");
    let _ = ipad_go_home(
        &client,
        IpadHomeOptions {
            force_home_via_swipe: true,
            verbose: true,
            ..Default::default()
        },
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

    match client.screenshot(None).await {
        Ok(shot) => {
            std::fs::write("/tmp/get-home-2-final.jpg", &shot.buffer).unwrap();
            eprintln!("saved -> /tmp/get-home-2-final.jpg");
        }
        Err(e) => eprintln!("final screenshot failed: {e}"),
    }
}
