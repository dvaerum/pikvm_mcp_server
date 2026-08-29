//! Image-capture tools. Faithful port of `index.ts`'s
//! `handle_pikvm_screenshot`/`handle_pikvm_snapshot`.

use std::sync::Arc;

use pikvm_mcp_detection_vision::auto_crop::{detect_cross_validated_crop, AutoCropOutcome};
use pikvm_mcp_detection_vision::snapshot::{crop_jpeg, save_snapshot, SnapshotRegion};
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
                    "savePath": {"type": "string", "description": "Optional: ALSO write the JPEG to this file path (in addition to returning it inline)."},
                    "autoCrop": {"type": "boolean", "description": "Auto-detect and crop away black iPad letterboxing (cross-validated against two independent detectors plus a known-iPad-screen-shape check; falls back to the full frame if any of the three disagree). Default true. When cropped, the response reports a region offset — add it to reported coordinates before calling pikvm_mouse_move_to/pikvm_mouse_click_at, which always take real full-HDMI-frame pixels."}
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

        // Auto-crop (task_f04c3909db11): cross-validate two independent
        // detectors before trusting a crop; fall back to the full frame
        // on disagreement or any detection failure rather than risk a
        // wrong crop silently cutting off real content. Stateless
        // contract: pikvm_mouse_move_to/click_at ALWAYS take real HDMI
        // pixels — this response reports the offset in text, the same
        // idiom already used for the scale factor above, rather than a
        // server-side coordinate translation that could go stale.
        let mut image_bytes = result.buffer.clone();
        if validate_boolean(&args, "autoCrop").unwrap_or(true) {
            match detect_cross_validated_crop(&result.buffer) {
                Ok(AutoCropOutcome::Cropped(bounds)) => {
                    let region = SnapshotRegion {
                        x: bounds.x as f64,
                        y: bounds.y as f64,
                        width: bounds.width,
                        height: bounds.height,
                    };
                    match crop_jpeg(&result.buffer, region) {
                        Ok(cropped) => {
                            image_bytes = cropped;
                            info_text.push_str(&format!(
                                " Auto-cropped to iPad content region {{x:{}, y:{}, width:{}, height:{}}} — \
                                 ADD region.x/region.y to any coordinate from THIS image before calling \
                                 pikvm_mouse_move_to/pikvm_mouse_click_at.",
                                region.x, region.y, region.width, region.height
                            ));
                        }
                        Err(e) => {
                            info_text.push_str(&format!(
                                " Auto-crop detection succeeded but re-encoding failed ({e}) — returning the full frame."
                            ));
                        }
                    }
                }
                Ok(AutoCropOutcome::DetectorDisagreement) => {
                    info_text.push_str(
                        " Auto-crop skipped: the two bounds detectors disagreed on where the iPad content is — returning the full frame rather than risk a wrong crop.",
                    );
                }
                Ok(AutoCropOutcome::UnknownAspectRatio(bounds)) => {
                    info_text.push_str(&format!(
                        " Auto-crop skipped: detected region ({}x{}) doesn't match any known iPad screen shape — returning the full frame rather than risk a wrong crop.",
                        bounds.width, bounds.height
                    ));
                }
                Err(e) => {
                    info_text.push_str(&format!(
                        " Auto-crop skipped: bounds detection failed ({e}) — returning the full frame."
                    ));
                }
            }
        }

        if let Some(save_path) = validate_string(&args, "savePath") {
            // Save whatever is being returned inline (post-auto-crop, if
            // it happened) so the saved file matches what the caller sees.
            let saved = save_snapshot(&image_bytes, &save_path, None).await?;
            info_text.push_str(&format!(
                "\nSaved to {} ({} bytes).",
                saved.path.display(),
                saved.bytes
            ));
        }

        let data = b64(&image_bytes);
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
