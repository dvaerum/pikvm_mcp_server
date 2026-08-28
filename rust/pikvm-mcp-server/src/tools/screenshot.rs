//! Image-capture tools. Faithful port of `index.ts`'s
//! `handle_pikvm_screenshot`/`handle_pikvm_snapshot`.

use std::sync::Arc;

use pikvm_mcp_detection_vision::snapshot::{save_snapshot, SnapshotRegion};
use pikvm_mcp_kvmd_client::client::ScreenshotOptions;

use crate::server::SharedState;
use crate::tool_helpers::{
    require_number, require_string, validate_boolean, validate_number, validate_string,
};
use crate::tools::{b64, BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "pikvm_screenshot",
            description: "Capture a JPEG from the PiKVM video stream. On iPad pass keepCursorAlive:true to emit a \
                           net-zero ±1px nudge just before the snapshot so the auto-fading cursor stays visible for \
                           verification."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "maxWidth": {"type": "number", "description": "Maximum width of the screenshot in pixels (optional, for preview)"},
                    "maxHeight": {"type": "number", "description": "Maximum height of the screenshot in pixels (optional, for preview)"},
                    "quality": {"type": "number", "description": "JPEG quality 1-100 (optional, default 80)"},
                    "keepCursorAlive": {"type": "boolean", "description": "Emit a ±1px mouse nudge immediately before the snapshot so the iPad cursor stays visible. Net displacement is zero. Default false."},
                    "savePath": {"type": "string", "description": "Optional: ALSO write the JPEG to this file path (in addition to returning it inline)."}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(screenshot(shared, args))),
        },
        ToolEntry {
            name: "pikvm_snapshot",
            description: "Save a JPEG video frame to a FILE (no inline image) — the file-only counterpart to \
                           pikvm_screenshot. Captures /streamer/snapshot, optionally crops to a region, writes it \
                           to savePath (parent dirs created), and returns the path + byte size."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "savePath": {"type": "string", "description": "File path to write the JPEG to (required). Parent directories are created if missing."},
                    "region": {
                        "type": "object",
                        "description": "Optional crop rectangle in screenshot pixels: { x, y, width, height }.",
                        "properties": {
                            "x": {"type": "number"}, "y": {"type": "number"},
                            "width": {"type": "number"}, "height": {"type": "number"}
                        },
                        "required": ["x", "y", "width", "height"]
                    },
                    "maxWidth": {"type": "number", "description": "Optional preview cap (px) applied before writing."},
                    "maxHeight": {"type": "number", "description": "Optional preview cap (px) applied before writing."},
                    "quality": {"type": "number", "description": "JPEG quality 1-100 (optional)."}
                },
                "required": ["savePath"]
            }),
            handler: Arc::new(|shared, args| Box::pin(snapshot(shared, args))),
        },
    ]
}

fn screenshot_options(args: &serde_json::Map<String, serde_json::Value>) -> ScreenshotOptions {
    ScreenshotOptions {
        max_width: validate_number(args, "maxWidth", Some(1.0), Some(10000.0)).map(|v| v as u32),
        max_height: validate_number(args, "maxHeight", Some(1.0), Some(10000.0)).map(|v| v as u32),
        quality: validate_number(args, "quality", Some(1.0), Some(100.0)).map(|v| v as u32),
    }
}

fn screenshot(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let opts = screenshot_options(&args);
        let result = if validate_boolean(&args, "keepCursorAlive").unwrap_or(false) {
            shared
                .client
                .screenshot_keeping_cursor_alive(Some(opts))
                .await?
        } else {
            shared.client.screenshot(Some(opts)).await?
        };

        let mut info_text = format!(
            "Screenshot captured ({}x{}",
            result.screenshot_width, result.screenshot_height
        );
        if result.scale_x != 1.0 || result.scale_y != 1.0 {
            info_text.push_str(&format!(
                ", scaled from {}x{}",
                result.actual_width, result.actual_height
            ));
            info_text.push_str(&format!(
                ", scale factor: {:.2}x{:.2}",
                result.scale_x, result.scale_y
            ));
        }
        info_text.push_str("). Mouse coordinates from this image will be auto-scaled.");

        if let Some(save_path) = validate_string(&args, "savePath") {
            let saved = save_snapshot(&result.buffer, &save_path, None).await?;
            info_text.push_str(&format!(
                "\nSaved to {} ({} bytes).",
                saved.path.display(),
                saved.bytes
            ));
        }

        let data = b64(&result.buffer);
        Ok(ToolOutcome::text_and_image(info_text, data, "image/jpeg"))
    })
}

fn snapshot(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let save_path = require_string(&args, "savePath").map_err(anyhow::Error::msg)?;
        let region = match args.get("region") {
            Some(serde_json::Value::Object(r)) => Some(SnapshotRegion {
                x: require_number(r, "x", "region.x", None, None).map_err(anyhow::Error::msg)?,
                y: require_number(r, "y", "region.y", None, None).map_err(anyhow::Error::msg)?,
                width: require_number(r, "width", "region.width", None, None)
                    .map_err(anyhow::Error::msg)? as u32,
                height: require_number(r, "height", "region.height", None, None)
                    .map_err(anyhow::Error::msg)? as u32,
            }),
            _ => None,
        };
        let opts = screenshot_options(&args);
        let result = shared.client.screenshot(Some(opts)).await?;
        let saved = save_snapshot(&result.buffer, &save_path, region).await?;

        let detail = match region {
            Some(r) => format!(", cropped to {}x{} at {},{}", r.width, r.height, r.x, r.y),
            None => format!(", {}x{}", result.screenshot_width, result.screenshot_height),
        };
        Ok(ToolOutcome::text(format!(
            "Saved snapshot to {} ({} bytes{}).",
            saved.path.display(),
            saved.bytes,
            detail
        )))
    })
}
