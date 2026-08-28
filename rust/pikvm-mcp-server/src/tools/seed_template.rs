//! Faithful port of `index.ts`'s `handle_pikvm_seed_cursor_template`.

use std::sync::Arc;

use pikvm_mcp_detection_vision::seed_template::{
    seed_cursor_template, ScreenshotResult as SeedScreenshotResult, SeedTemplateClient,
    SeedTemplateOptions,
};
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::server::SharedState;
use crate::tool_helpers::validate_number;
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![ToolEntry {
        name: "pikvm_seed_cursor_template",
        description: "Bootstrap cursor detection: emit a small move, diff before/after screenshots, and save a \
                       24×24 cursor template."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "emitDx": {"type": "number", "description": "X-axis mickeys for the wake motion. Default 100."},
                "emitDy": {"type": "number", "description": "Y-axis mickeys for the wake motion. Default 0."},
                "settleMs": {"type": "number", "description": "Delay between motion and post-screenshot. Default 500ms."}
            }
        }),
        handler: Arc::new(|shared, args| Box::pin(seed_cursor_template_tool(shared, args))),
    }]
}

/// Adapt the real `PiKVMClient` into `SeedTemplateClient`'s injected-
/// closure shape (the crate-boundary DI adaptation this port has used
/// repeatedly — see `cursor_anchor.rs`'s own header comment for the
/// precedent).
fn seed_template_client(client: Arc<PiKVMClient>) -> SeedTemplateClient {
    let screenshot_client = client.clone();
    let alive_client = client.clone();
    let move_client = client.clone();
    SeedTemplateClient {
        screenshot: Arc::new(move || {
            let client = screenshot_client.clone();
            Box::pin(async move {
                let r = client.screenshot(None).await?;
                Ok(SeedScreenshotResult {
                    buffer: r.buffer,
                    screenshot_width: r.screenshot_width,
                    screenshot_height: r.screenshot_height,
                })
            })
        }),
        screenshot_keeping_cursor_alive: Some(Arc::new(move || {
            let client = alive_client.clone();
            Box::pin(async move {
                let r = client.screenshot_keeping_cursor_alive(None).await?;
                Ok(SeedScreenshotResult {
                    buffer: r.buffer,
                    screenshot_width: r.screenshot_width,
                    screenshot_height: r.screenshot_height,
                })
            })
        })),
        mouse_move_relative: Arc::new(move |dx, dy| {
            let client = move_client.clone();
            Box::pin(async move {
                client
                    .mouse_move_relative(dx, dy)
                    .await
                    .map_err(anyhow::Error::from)
            })
        }),
    }
}

fn seed_cursor_template_tool(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let options = SeedTemplateOptions {
            emit_dx: validate_number(&args, "emitDx", None, None),
            emit_dy: validate_number(&args, "emitDy", None, None),
            settle_ms: validate_number(&args, "settleMs", None, None).map(|v| v as u64),
            ..Default::default()
        };
        let client = seed_template_client(shared.client.clone());
        let result = seed_cursor_template(&client, options).await?;
        let json = serde_json::json!({
            "ok": result.ok,
            "cursorPosition": result.cursor_position.map(|p| serde_json::json!({"x": p.x, "y": p.y})),
            "templatePersisted": result.template_persisted,
            "decision": result.decision.map(|d| format!("{d:?}")),
            "templateCount": result.template_count,
            "reason": result.reason,
        });
        Ok(ToolOutcome {
            content: vec![crate::tools::ToolContent::Text(json.to_string())],
            is_error: !result.ok,
        })
    })
}
