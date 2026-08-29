//! Faithful port of `index.ts`'s
//! `handle_pikvm_hidmode_status`/`handle_pikvm_hidmode_set`.

use std::sync::Arc;

use pikvm_mcp_ipad_hid::hid_mode::{HidMode, ModeSource};

use crate::server::SharedState;
use crate::tool_helpers::require_string;
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "pikvm_hidmode_status",
            description: "Report the HID-mode source and current mode (#51): source (\"declared\" fixed --target, \
                           or \"endpoint\" derived from the appliance /hidmode), mode (\"ipad\"=relative / \
                           \"desktop\"=absolute, or null=UNKNOWN), reachable, settling, moverAllowed."
                .to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(hidmode_status(shared))),
        },
        ToolEntry {
            name: "pikvm_hidmode_set",
            description: "Switch the appliance HID mode (#51): POSTs to the appliance /hidmode endpoint. Only \
                           works when the mode is endpoint-derived; a declared --target is fixed. The session \
                           WILL DROP — reconnect and re-read pikvm_hidmode_status before driving input."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["ipad", "desktop"], "description": "The HID mode to switch the appliance to."}
                },
                "required": ["mode"]
            }),
            handler: Arc::new(|shared, args| Box::pin(hidmode_set(shared, args))),
        },
    ]
}

fn mode_source_str(s: ModeSource) -> &'static str {
    match s {
        ModeSource::Declared => "declared",
        ModeSource::Endpoint => "endpoint",
    }
}

fn mode_str(m: HidMode) -> &'static str {
    match m {
        HidMode::Ipad => "ipad",
        HidMode::Desktop => "desktop",
    }
}

fn hidmode_status(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let mut resolver = shared.hid_mode_resolver.lock().await;
        resolver.resolve().await; // a fresh read so the status isn't stale
        let status = resolver.status();
        let json = serde_json::json!({
            "mode": status.mode.map(mode_str),
            "source": mode_source_str(status.source),
            "reachable": status.reachable,
            "settling": status.settling,
            "lastReadAt": status.last_read_at,
            "requestedMode": status.requested_mode.map(mode_str),
            "driftDetected": status.drift_detected,
            "moverAllowed": status.mover_allowed,
            "moverBlockReason": status.mover_block_reason,
            "warnings": status.warnings,
        });
        Ok(ToolOutcome::text(serde_json::to_string_pretty(&json)?))
    })
}

fn hidmode_set(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let mode_str_arg = require_string(&args, "mode").map_err(anyhow::Error::msg)?;
        let mode = match mode_str_arg.as_str() {
            "ipad" => HidMode::Ipad,
            "desktop" => HidMode::Desktop,
            _ => {
                return Ok(ToolOutcome::error_text(
                    "Error: mode is required and must be \"ipad\" or \"desktop\".",
                ))
            }
        };
        let mut resolver = shared.hid_mode_resolver.lock().await;
        let result = resolver.set(mode).await;
        Ok(ToolOutcome {
            content: vec![crate::tools::ToolContent::Text(result.message)],
            is_error: !result.ok,
        })
    })
}
