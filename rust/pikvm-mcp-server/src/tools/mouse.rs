//! Faithful port of `index.ts`'s `handle_pikvm_mouse_move`/
//! `handle_pikvm_mouse_click`/`handle_pikvm_mouse_scroll`.

use std::sync::Arc;

use pikvm_mcp_detection_vision::capture::{begin_capture, parse_capture_config, CaptureClient};
use pikvm_mcp_kvmd_client::client::MouseButton;

use crate::server::SharedState;
use crate::tool_helpers::{
    require_number, validate_boolean, validate_enum, validate_number, VALID_BUTTONS,
    VALID_KEY_STATES,
};
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

/// M8: shared before/during/after capture schema, spread into `pikvm_mouse_move`'s
/// input schema (also used by `pikvm_mouse_move_to`/`pikvm_mouse_click_at`,
/// both still blocked on move-to.ts — see docs/rust-port-plan.md §7 item 6).
fn capture_schema_props() -> serde_json::Value {
    serde_json::json!({
        "capture": {
            "type": "array",
            "items": {"type": "string", "enum": ["before", "during", "after"]},
            "description": "M8: advisory frame capture around this operation. Any subset of [\"before\",\"during\",\"after\"]. Omit or pass [] to disable."
        },
        "capturePrefix": {"type": "string", "description": "Path prefix for capture frames (REQUIRED when capture is non-empty)."},
        "captureRegion": {
            "type": "object",
            "description": "Optional crop { x, y, width, height } applied to every capture frame. Default = full frame.",
            "properties": {
                "x": {"type": "number"}, "y": {"type": "number"},
                "width": {"type": "number"}, "height": {"type": "number"}
            },
            "required": ["x", "y", "width", "height"]
        }
    })
}

fn merge_properties(base: serde_json::Value, extra: serde_json::Value) -> serde_json::Value {
    let mut base = base;
    if let (Some(base_props), Some(extra_props)) =
        (base["properties"].as_object_mut(), extra.as_object())
    {
        for (k, v) in extra_props {
            base_props.insert(k.clone(), v.clone());
        }
    }
    base
}

pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "pikvm_mouse_move",
            description: "Move the mouse absolute or relative, with optional M8 capture."
                .to_string(),
            input_schema: merge_properties(
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "x": {"type": "number", "description": "Target X (absolute px) or delta X (relative)."},
                        "y": {"type": "number", "description": "Target Y (absolute px) or delta Y (relative)."},
                        "relative": {"type": "boolean", "description": "When true, x/y are mickeys clamped to [-127, 127]."}
                    },
                    "required": ["x", "y"]
                }),
                capture_schema_props(),
            ),
            handler: Arc::new(|shared, args| Box::pin(mouse_move(shared, args))),
        },
        ToolEntry {
            name: "pikvm_mouse_click",
            description: "Click a mouse button, optionally moving to a position first.".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "button": {"type": "string", "enum": VALID_BUTTONS, "description": "Default left."},
                    "x": {"type": "number", "description": "Optional: move here (absolute px) before clicking."},
                    "y": {"type": "number", "description": "Optional: move here (absolute px) before clicking."},
                    "state": {"type": "string", "enum": ["press", "release", "click"], "description": "Default click."}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(mouse_click(shared, args))),
        },
        ToolEntry {
            name: "pikvm_mouse_scroll",
            description: "Scroll the mouse wheel, with optional pane-targeting pre-move."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "deltaX": {"type": "number", "description": "Horizontal scroll delta. Default 0."},
                    "deltaY": {"type": "number", "description": "Vertical scroll delta (required)."},
                    "x": {"type": "number", "description": "Optional pane-targeting X — must be given with y."},
                    "y": {"type": "number", "description": "Optional pane-targeting Y — must be given with x."}
                },
                "required": ["deltaY"]
            }),
            handler: Arc::new(|shared, args| Box::pin(mouse_scroll(shared, args))),
        },
    ]
}

fn capture_client(shared: &Arc<SharedState>) -> CaptureClient {
    let screenshot_client = shared.client.clone();
    let alive_client = shared.client.clone();
    CaptureClient {
        screenshot: Arc::new(move || {
            let client = screenshot_client.clone();
            Box::pin(async move { Ok(client.screenshot(None).await?.buffer) })
        }),
        screenshot_keeping_cursor_alive: Some(Arc::new(move || {
            let client = alive_client.clone();
            Box::pin(async move { Ok(client.screenshot_keeping_cursor_alive(None).await?.buffer) })
        })),
    }
}

fn mouse_move(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let x = require_number(&args, "x", "x", None, None).map_err(anyhow::Error::msg)?;
        let y = require_number(&args, "y", "y", None, None).map_err(anyhow::Error::msg)?;
        let relative = validate_boolean(&args, "relative").unwrap_or(false);

        // M8: parse capture before any emit (errors on a bad request).
        let capture_config = parse_capture_config(&serde_json::Value::Object(args.clone()))?;
        let mut session = begin_capture(capture_client(&shared), capture_config);
        session.before().await;

        let mut calibration_warning = String::new();
        if relative {
            shared.client.mouse_move_relative(x, y).await?;
        } else {
            let clamped_x = x.round().max(0.0);
            let clamped_y = y.round().max(0.0);
            let calibration_invalidated = shared.client.mouse_move(clamped_x, clamped_y).await?;
            if calibration_invalidated {
                calibration_warning = "\n⚠️ Resolution changed - calibration has been cleared. Recalibrate with pikvm_auto_calibrate (preferred) or pikvm_calibrate.".to_string();
            }
        }
        session.during().await;
        session.after(None).await;

        let text = if relative {
            format!("Moved mouse by ({x}, {y})")
        } else {
            format!(
                "Moved mouse to pixel ({}, {})",
                x.round().max(0.0),
                y.round().max(0.0)
            )
        };
        Ok(ToolOutcome::text(format!(
            "{text}{calibration_warning}{}",
            session.lines()
        )))
    })
}

fn button_from_str(s: &str) -> MouseButton {
    match s {
        "right" => MouseButton::Right,
        "middle" => MouseButton::Middle,
        "up" => MouseButton::Up,
        "down" => MouseButton::Down,
        _ => MouseButton::Left,
    }
}

fn mouse_click(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let button_str = validate_enum(&args, "button", VALID_BUTTONS, "left").to_string();
        let button = button_from_str(&button_str);
        let click_x = validate_number(&args, "x", Some(0.0), None);
        let click_y = validate_number(&args, "y", Some(0.0), None);

        if let (Some(cx), Some(cy)) = (click_x, click_y) {
            shared.client.mouse_move(cx.round(), cy.round()).await?;
        }

        let state = validate_enum(&args, "state", VALID_KEY_STATES, "click");
        match state {
            "press" => shared.client.mouse_click(button, Some(true), None).await?,
            "release" => shared.client.mouse_click(button, Some(false), None).await?,
            _ => shared.client.mouse_click(button, None, None).await?,
        }

        Ok(ToolOutcome::text(format!("{button_str} click")))
    })
}

fn mouse_scroll(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let delta_y =
            require_number(&args, "deltaY", "deltaY", None, None).map_err(anyhow::Error::msg)?;
        let delta_x = validate_number(&args, "deltaX", None, None).unwrap_or(0.0);
        let tx = validate_number(&args, "x", None, None);
        let ty = validate_number(&args, "y", None, None);

        if tx.is_some() != ty.is_some() {
            return Ok(ToolOutcome::error_text(
                "Error: pass both x and y to target a pane, or neither to scroll in place.",
            ));
        }

        if tx.is_some() && ty.is_some() {
            // TS routes pane-targeting through moveToPixel (move-to.ts) —
            // not assembled in this crate yet (georg's move-to.ts port,
            // parked; see docs/rust-port-plan.md §7 item 6). Explicit stub
            // with a clear error rather than a silent no-op or a wrong
            // raw-absolute-move fallback (which index.ts's own M1 fix
            // comment documents as a confirmed no-op on iPadOS).
            return Ok(ToolOutcome::error_text(
                "Error: pane-targeting (x/y) for pikvm_mouse_scroll needs moveToPixel, not yet ported in this \
                 build (blocked on move-to.ts) — omit x/y to scroll in place, or use pikvm_mouse_move_to first.",
            ));
        }

        shared.client.mouse_scroll(delta_x, delta_y).await?;
        Ok(ToolOutcome::text(format!(
            "Scrolled ({delta_x}, {delta_y})"
        )))
    })
}
