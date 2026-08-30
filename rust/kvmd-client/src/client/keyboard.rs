//! Keyboard emission: text-as-keys typing, single key events, and
//! multi-key shortcuts (explicit press/settle/tap/settle/release —
//! see `send_shortcut`'s doc for why, not the REST `send_shortcut`
//! endpoint's near-simultaneous events).

use std::time::Duration;

use super::core::PiKVMClient;
use super::error::ClientError;
use super::request::{HttpMethod, RequestArgs, RequestBody};
use super::types::{KeyOptions, TypeOptions};

impl PiKVMClient {
    /// Type text using paste-as-keys (handles special characters correctly).
    pub async fn r#type(
        &self,
        text: &str,
        options: Option<TypeOptions>,
    ) -> Result<(), ClientError> {
        let options = options.unwrap_or_default();
        let keymap = options
            .keymap
            .unwrap_or_else(|| self.config.default_keymap.clone());
        let mut params = vec![format!("keymap={keymap}")];
        if options.slow {
            params.push("slow=1".to_string());
        }
        if let Some(delay) = options.delay {
            params.push(format!("delay={delay}"));
        }
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!("/hid/print?{}", params.join("&")),
            body: Some(RequestBody::Text(text.to_string())),
        })
        .await?;
        Ok(())
    }

    pub async fn send_key(
        &self,
        key: &str,
        options: Option<KeyOptions>,
    ) -> Result<(), ClientError> {
        let options = options.unwrap_or_default();
        let mut params = vec![format!("key={key}")];
        if let Some(state) = options.state {
            params.push(format!("state={state}"));
        }
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!("/hid/events/send_key?{}", params.join("&")),
            body: None,
        })
        .await?;
        // v2 wake-nudge escalation (docs/streamer-source-online-wake-nudge-
        // plan.md): stamps this client's OWN "last keyboard key sent" clock
        // — per-instance, not `emit_clock` (mouse-only, process-global).
        // `send_shortcut` is built entirely on this method, so it's covered
        // for free.
        *self.last_keyboard_emit.lock().unwrap() = Some(std::time::Instant::now());
        Ok(())
    }

    /// Send a keyboard shortcut (multiple keys pressed together). Emits
    /// an explicit press → settle → tap last key → settle → release
    /// sequence via `send_key` (reliable on iPadOS, unlike
    /// `send_shortcut`'s near-simultaneous events — see the TS doc
    /// comment for the on-device finding). The last key is the "action"
    /// key; all preceding keys are held as modifiers.
    pub async fn send_shortcut(&self, keys: &[&str]) -> Result<(), ClientError> {
        if keys.is_empty() {
            return Ok(());
        }
        if keys.len() == 1 {
            return self.send_key(keys[0], None).await;
        }
        let modifiers = &keys[..keys.len() - 1];
        let action_key = keys[keys.len() - 1];

        for m in modifiers {
            self.send_key(m, Some(KeyOptions { state: Some(true) }))
                .await?;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        self.send_key(action_key, None).await?;
        tokio::time::sleep(Duration::from_millis(40)).await;
        for m in modifiers.iter().rev() {
            self.send_key(m, Some(KeyOptions { state: Some(false) }))
                .await?;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        Ok(())
    }
}
