//! Faithful port of `index.ts`'s `handle_pikvm_hid_reset`.

use std::sync::Arc;

use pikvm_mcp_kvmd_client::client::ResetHidOptions;

use crate::server::SharedState;
use crate::tool_helpers::{validate_boolean, validate_number};
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![ToolEntry {
        name: "pikvm_hid_reset",
        description: "Soft HID reinit, optionally with an OTG reconnect (set_connected 0→1)."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "reconnectUsb": {"type": "boolean", "description": "Also cycle set_connected 0→1 (OTG reconnect)."},
                "settleMs": {"type": "number", "description": "Settle delay after the reset before re-reading the HID profile (0-30000)."}
            }
        }),
        handler: Arc::new(|shared, args| Box::pin(hid_reset(shared, args))),
    }]
}

fn hid_reset(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let reconnect_usb = validate_boolean(&args, "reconnectUsb").unwrap_or(false);
        let settle_ms =
            validate_number(&args, "settleMs", Some(0.0), Some(30000.0)).map(|v| v as u64);
        let after = shared
            .client
            .reset_hid(Some(ResetHidOptions {
                reconnect_usb,
                settle_ms,
            }))
            .await?
            .expect("reset_hid(Some(_)) always returns Some");
        let recovered = after.mouse_online && after.keyboard_online;

        let mut lines = vec![
            format!(
                "HID reset sent{}.",
                if reconnect_usb {
                    " (+ OTG set_connected 0→1)"
                } else {
                    ""
                }
            ),
            format!(
                "Post-reset HID: mouse={}/{}, keyboard={}.",
                if after.mouse_online {
                    "online"
                } else {
                    "offline"
                },
                if after.mouse_absolute {
                    "absolute"
                } else {
                    "relative"
                },
                if after.keyboard_online {
                    "online"
                } else {
                    "offline"
                }
            ),
        ];
        if !recovered {
            lines.push(
                "Still offline — a soft reset cannot force the host to re-enumerate. The target device (e.g. \
                 iPad) is not bringing the USB HID link up. Physically re-plug the USB-C data cable (not \
                 charge-only) or restart the target."
                    .to_string(),
            );
        }
        // ADR-0002 Phase 1: force the resolver to re-derive on its next
        // read instead of trusting its TTL cache — a HID reset is exactly
        // the kind of event that invalidates it, same invalidation
        // hidModeResolver.set() uses after a mode switch.
        shared.hid_mode_resolver.lock().await.mark_reconnect();
        Ok(ToolOutcome::text(lines.join("\n")))
    })
}
