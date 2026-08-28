//! Simple keyboard/status tools with no image content and no shared
//! mutable state beyond the client. Faithful port of `index.ts`'s
//! `handle_pikvm_version`/`handle_pikvm_get_resolution`/`handle_pikvm_type`/
//! `handle_pikvm_key`/`handle_pikvm_shortcut`/`handle_pikvm_screen_state`.

use std::sync::Arc;

use pikvm_mcp_kvmd_client::client::{KeyOptions, TypeOptions};

use crate::server::SharedState;
use crate::tool_helpers::{
    require_string, require_string_array, validate_boolean, validate_enum, validate_number,
    validate_string, validate_string_array, VALID_KEY_STATES,
};
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "pikvm_version",
            description: format!(
                "Return the running pikvm-mcp-server version. Useful for detecting whether a deployed server is \
                 current with main — if the version doesn't match the latest commit's version, the server needs a \
                 redeploy. Currently embedded version: {}.",
                pikvm_mcp_foundation::version::VERSION
            ),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|_shared, _args| Box::pin(async move { version() })),
        },
        ToolEntry {
            name: "pikvm_get_resolution",
            description: "Get the current screen resolution of the remote machine. Useful for knowing valid \
                           coordinate ranges for mouse operations."
                .to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(get_resolution(shared))),
        },
        ToolEntry {
            name: "pikvm_type",
            description: "Type text via keymap conversion".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The text to type."},
                    "keymap": {"type": "string", "description": "Optional keymap override."},
                    "slow": {"type": "boolean", "description": "Optional slow-typing mode."},
                    "delay": {"type": "number", "description": "Optional per-key delay in ms (0-200)."}
                },
                "required": ["text"]
            }),
            handler: Arc::new(|shared, args| Box::pin(type_text(shared, args))),
        },
        ToolEntry {
            name: "pikvm_key",
            description: "Send single key/combo with press/release/click state".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "The key to send."},
                    "modifiers": {"type": "array", "items": {"type": "string"}, "description": "Optional modifier keys."},
                    "state": {"type": "string", "enum": ["press", "release", "click"], "description": "Optional key state (default click)."}
                },
                "required": ["key"]
            }),
            handler: Arc::new(|shared, args| Box::pin(key(shared, args))),
        },
        ToolEntry {
            name: "pikvm_shortcut",
            description: "Send simultaneous keys (max 10)".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "keys": {"type": "array", "items": {"type": "string"}, "description": "Keys to send together."}
                },
                "required": ["keys"]
            }),
            handler: Arc::new(|shared, args| Box::pin(shortcut(shared, args))),
        },
        ToolEntry {
            name: "pikvm_screen_state",
            description: "Fast HDMI on/off + resolution check".to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(screen_state(shared))),
        },
    ]
}

fn version() -> anyhow::Result<ToolOutcome> {
    Ok(ToolOutcome::text(format!(
        "pikvm-mcp-server v{}",
        pikvm_mcp_foundation::version::VERSION
    )))
}

fn get_resolution(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let resolution = shared.client.get_resolution(true).await?;
        Ok(ToolOutcome::text(format!(
            "Screen resolution: {}x{} pixels. Valid mouse coordinates: x=0-{}, y=0-{}",
            resolution.width,
            resolution.height,
            resolution.width.saturating_sub(1),
            resolution.height.saturating_sub(1)
        )))
    })
}

fn type_text(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let text = require_string(&args, "text").map_err(anyhow::Error::msg)?;
        shared
            .client
            .r#type(
                &text,
                Some(TypeOptions {
                    keymap: validate_string(&args, "keymap"),
                    slow: validate_boolean(&args, "slow").unwrap_or(false),
                    delay: validate_number(&args, "delay", Some(0.0), Some(200.0))
                        .map(|v| v as u32),
                }),
            )
            .await?;
        // Don't echo full text in response to avoid leaking sensitive input.
        let display_text = if text.chars().count() > 50 {
            format!("{}...", text.chars().take(50).collect::<String>())
        } else {
            text.clone()
        };
        Ok(ToolOutcome::text(format!(
            "Typed {} character(s): \"{display_text}\"",
            text.chars().count()
        )))
    })
}

fn key(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let key = require_string(&args, "key").map_err(anyhow::Error::msg)?;
        let modifiers = validate_string_array(&args, "modifiers");
        let state = validate_enum(&args, "state", VALID_KEY_STATES, "click").to_string();

        for m in &modifiers {
            shared
                .client
                .send_key(m, Some(KeyOptions { state: Some(true) }))
                .await?;
        }

        match state.as_str() {
            "press" => {
                shared
                    .client
                    .send_key(&key, Some(KeyOptions { state: Some(true) }))
                    .await?
            }
            "release" => {
                shared
                    .client
                    .send_key(&key, Some(KeyOptions { state: Some(false) }))
                    .await?
            }
            _ => shared.client.send_key(&key, None).await?,
        }

        for m in modifiers.iter().rev() {
            shared
                .client
                .send_key(m, Some(KeyOptions { state: Some(false) }))
                .await?;
        }

        Ok(ToolOutcome::text(if modifiers.is_empty() {
            format!("Sent key: {key}")
        } else {
            format!("Sent key: {}+{key}", modifiers.join("+"))
        }))
    })
}

fn shortcut(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let keys = require_string_array(&args, "keys", "keys", 1).map_err(anyhow::Error::msg)?;
        if keys.len() > 10 {
            anyhow::bail!("keys array must have at most 10 elements");
        }
        let key_refs: Vec<&str> = keys.iter().map(String::as_str).collect();
        shared.client.send_shortcut(&key_refs).await?;
        Ok(ToolOutcome::text(format!(
            "Sent shortcut: {}",
            keys.join("+")
        )))
    })
}

fn screen_state(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    // Faithful port: this handler catches its OWN errors (a FAILED-to-read
    // result, not an `isError` one) rather than letting the central
    // sanitize-and-catch in server.rs handle it — matching index.ts's own
    // inner try/catch here.
    Box::pin(async move {
        match shared.client.get_streamer_status().await {
            Ok((source_online, resolution)) => {
                let msg = if source_online {
                    format!(
                        "Screen ON. Resolution {}×{}.",
                        resolution.width, resolution.height
                    )
                } else {
                    "Screen OFF (no HDMI signal). Most common cause: iPad is locked / asleep / showing Touch ID \
                     gate. Wake with sendKey Enter (Phase 217: also dismisses lock screen on iPadOS 26 with no \
                     passcode), or pikvm_ipad_unlock for the swipe-based path. pikvm_screenshot will 503 until the \
                     screen wakes."
                        .to_string()
                };
                Ok(ToolOutcome::text(msg))
            }
            Err(err) => Ok(ToolOutcome::text(format!(
                "Screen state: FAILED to read ({err}). PiKVM itself may be unreachable."
            ))),
        }
    })
}
