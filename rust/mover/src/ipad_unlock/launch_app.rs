//! Composed iPad keyboard helper: bundle the verified keyboard-first
//! unlock → Spotlight → type → launch pattern into a single-call tool so
//! agents don't have to chain primitives.
//!
//! Faithful port of `src/pikvm/ipad-unlock.ts`'s `launchIpadApp`.

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_kvmd_client::client::{PiKVMClient, ScreenResolution};

use super::unlock::{unlock_ipad, IpadUnlockOptions};

#[derive(Debug, Clone, Copy, Default)]
pub struct IpadLaunchAppOptions {
    /// Whether to attempt unlock first if the screen state is unknown.
    /// Default true. Setting this to false skips the swipe (cheaper if
    /// the caller knows the iPad is already unlocked).
    pub unlock_first: Option<bool>,
    /// Settle delay between Spotlight open and typing (ms). Default 700.
    pub spotlight_settle_ms: Option<u64>,
    /// Settle delay after typing the app name, before Enter (ms).
    /// Default 600.
    pub post_type_settle_ms: Option<u64>,
    /// Settle delay after Enter, before returning the screenshot (ms).
    /// Default 1500 — apps usually launch within 1 s, this gives a margin.
    pub launch_settle_ms: Option<u64>,
    pub verbose: bool,
}

#[derive(Debug, Clone)]
pub struct IpadLaunchAppResult {
    pub screenshot: Vec<u8>,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    pub app_name: String,
    pub unlocked: bool,
    pub resolution: ScreenResolution,
    pub message: String,
}

/// Launch an iPad app via the verified keyboard pipeline: unlock →
/// Cmd+Space (Spotlight) → type app name → Enter → settle → screenshot.
///
/// This is far more reliable than `pikvm_mouse_click_at` on an icon
/// because it bypasses cursor positioning entirely. Verified live for
/// Files, Settings, App Store on iPadOS 26.1.
pub async fn launch_ipad_app(
    client: &Arc<PiKVMClient>,
    app_name: &str,
    options: IpadLaunchAppOptions,
) -> anyhow::Result<IpadLaunchAppResult> {
    if app_name.trim().is_empty() {
        anyhow::bail!("appName is required");
    }
    let unlock_first = options.unlock_first.unwrap_or(true);
    let spotlight_settle_ms = options.spotlight_settle_ms.unwrap_or(700);
    let post_type_settle_ms = options.post_type_settle_ms.unwrap_or(600);
    let launch_settle_ms = options.launch_settle_ms.unwrap_or(1500);

    let mut unlocked = false;
    if unlock_first {
        if options.verbose {
            eprintln!("[launch-app] unlocking iPad");
        }
        unlock_ipad(
            client,
            IpadUnlockOptions {
                verbose: options.verbose,
                ..Default::default()
            },
        )
        .await?;
        unlocked = true;
    }

    if options.verbose {
        eprintln!("[launch-app] Cmd+Space");
    }
    client.send_shortcut(&["MetaLeft", "Space"]).await?;
    tokio::time::sleep(Duration::from_millis(spotlight_settle_ms)).await;

    if options.verbose {
        eprintln!("[launch-app] type \"{app_name}\"");
    }
    client.r#type(app_name, None).await?;
    tokio::time::sleep(Duration::from_millis(post_type_settle_ms)).await;

    if options.verbose {
        eprintln!("[launch-app] Enter");
    }
    client.send_key("Enter", None).await?;
    tokio::time::sleep(Duration::from_millis(launch_settle_ms)).await;

    let shot = client.screenshot(None).await?;
    let resolution = client.get_resolution(false).await?;

    Ok(IpadLaunchAppResult {
        screenshot: shot.buffer,
        screenshot_width: shot.screenshot_width,
        screenshot_height: shot.screenshot_height,
        app_name: app_name.to_string(),
        unlocked,
        resolution,
        message: format!(
            "Launched '{app_name}' via Spotlight (unlocked={unlocked}). \
             Inspect the returned screenshot to confirm the app opened. \
             If Spotlight returned to home screen instead, the app name didn't match — try a partial name or check spelling."
        ),
    })
}
