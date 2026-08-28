//! 2026-06-03 user-provided recipe — keyboard-only unlock for a
//! passcode-protected iPad. Used when `unlock_ipad`'s swipe gesture isn't
//! appropriate (e.g. the iPad sleeps mid-session and we want to come back
//! via keyboard with the known passcode).
//!
//! Sequence:
//!   - Space → wait wake_wait_ms (default 1000 ms): wakes the screen
//!   - Space → wait wake_wait_ms: dismisses the lock screen, brings up
//!     the passcode prompt
//!   - For each digit: send the corresponding `Digit{n}` keycode, wait
//!     per_digit_ms (default 100 ms)
//!   - Enter: submit
//!
//! The `code` is sent verbatim to PiKVM HID. It is NOT logged, stored
//! anywhere, or returned in the result. The caller is the passcode's
//! authority.
//!
//! Validates: 4-10 digits. Errors on bad input BEFORE any HID activity
//! (so a malformed code doesn't half-type a partial passcode and trigger
//! iPadOS's wrong-passcode counter).
//!
//! Faithful port of `src/pikvm/ipad-unlock.ts`'s `unlockIpadWithCode`.

use std::time::Duration;

use pikvm_mcp_kvmd_client::client::PiKVMClient;

#[derive(Debug, Clone, Copy, Default)]
pub struct UnlockWithCodeOptions {
    pub wake_wait_ms: Option<u64>,
    pub per_digit_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnlockWithCodeResult {
    pub digits_sent: usize,
}

pub async fn unlock_ipad_with_code(
    client: &PiKVMClient,
    code: &str,
    options: UnlockWithCodeOptions,
) -> anyhow::Result<UnlockWithCodeResult> {
    if code.len() < 4 || code.len() > 10 || !code.chars().all(|c| c.is_ascii_digit()) {
        anyhow::bail!("code must be a string of 4–10 decimal digits");
    }
    let wake_wait_ms = options.wake_wait_ms.unwrap_or(1000);
    let per_digit_ms = options.per_digit_ms.unwrap_or(100);

    client.send_key("Space", None).await?;
    tokio::time::sleep(Duration::from_millis(wake_wait_ms)).await;
    client.send_key("Space", None).await?;
    tokio::time::sleep(Duration::from_millis(wake_wait_ms)).await;

    for digit in code.chars() {
        client.send_key(&format!("Digit{digit}"), None).await?;
        tokio::time::sleep(Duration::from_millis(per_digit_ms)).await;
    }

    client.send_key("Enter", None).await?;
    Ok(UnlockWithCodeResult {
        digits_sent: code.len(),
    })
}
