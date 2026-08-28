//! Open the iPad App Switcher (Cmd+Tab) and capture a screenshot showing
//! the available apps, while keeping Cmd held briefly so the switcher
//! stays open long enough to capture. Then releases Cmd, which dismisses
//! the switcher (or selects the focused app, depending on iPadOS
//! behaviour).
//!
//! For programmatic switching: call this to see what's available, then
//! chain `pikvm_shortcut(["MetaLeft","Tab"])` repeatedly to focus the
//! desired app and finally release Cmd via a manual
//! `pikvm_key('MetaLeft', state:false)`.
//!
//! Faithful port of `src/pikvm/ipad-unlock.ts`'s `ipadOpenAppSwitcher`.

use std::time::Duration;

use pikvm_mcp_kvmd_client::client::{KeyOptions, PiKVMClient};

#[derive(Debug, Clone, Copy, Default)]
pub struct IpadAppSwitcherOptions {
    /// How long to hold the modifier (Cmd) so the App Switcher stays
    /// visible. Default 800 ms. The caller can use the returned
    /// screenshot to identify apps and follow up with arrow keys + Enter
    /// to switch, or `ipad_go_home` to dismiss.
    pub hold_ms: Option<u64>,
    pub verbose: bool,
}

#[derive(Debug, Clone)]
pub struct IpadAppSwitcherResult {
    pub screenshot: Vec<u8>,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    pub message: String,
}

pub async fn ipad_open_app_switcher(
    client: &PiKVMClient,
    options: IpadAppSwitcherOptions,
) -> anyhow::Result<IpadAppSwitcherResult> {
    let hold_ms = options.hold_ms.unwrap_or(800);
    if options.verbose {
        eprintln!("[app-switcher] Cmd+Tab, hold {hold_ms}ms");
    }

    // Press Cmd, tap Tab, hold, screenshot, then release Cmd.
    client
        .send_key("MetaLeft", Some(KeyOptions { state: Some(true) }))
        .await?;
    tokio::time::sleep(Duration::from_millis(40)).await;
    client.send_key("Tab", None).await?;
    tokio::time::sleep(Duration::from_millis(hold_ms)).await;
    let shot = client.screenshot(None).await?;
    client
        .send_key("MetaLeft", Some(KeyOptions { state: Some(false) }))
        .await?;

    Ok(IpadAppSwitcherResult {
        screenshot: shot.buffer,
        screenshot_width: shot.screenshot_width,
        screenshot_height: shot.screenshot_height,
        message: "Opened App Switcher with Cmd+Tab. The screenshot was captured while Cmd \
                  was held; Cmd has now been released which selects the highlighted app. \
                  For multi-step switching, use pikvm_key with state=true/false manually."
            .to_string(),
    })
}
