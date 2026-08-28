//! Faithful port of `index.ts`'s
//! `handle_pikvm_calibrate`/`handle_pikvm_set_calibration`/
//! `handle_pikvm_get_calibration`/`handle_pikvm_clear_calibration`.

use std::sync::Arc;

use crate::server::SharedState;
use crate::tool_helpers::require_number;
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "pikvm_calibrate",
            description: "Manual calibration: move to center, report expected position."
                .to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(calibrate(shared))),
        },
        ToolEntry {
            name: "pikvm_set_calibration",
            description: "Set factorX/factorY calibration factors directly.".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "factorX": {"type": "number", "description": "X-axis calibration factor."},
                    "factorY": {"type": "number", "description": "Y-axis calibration factor."}
                },
                "required": ["factorX", "factorY"]
            }),
            handler: Arc::new(|shared, args| Box::pin(set_calibration(shared, args))),
        },
        ToolEntry {
            name: "pikvm_get_calibration",
            description: "Get the current calibration factors.".to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(get_calibration(shared))),
        },
        ToolEntry {
            name: "pikvm_clear_calibration",
            description: "Clear calibration back to the default 1.0 factor.".to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(clear_calibration(shared))),
        },
    ]
}

fn calibrate(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let result = shared.client.calibrate().await?;
        Ok(ToolOutcome::text(format!(
            "Calibration started.\nResolution: {}x{}\nExpected cursor position: ({}, {})\nNormalized coordinates \
             sent: ({}, {})\n\n{}",
            result.resolution.width,
            result.resolution.height,
            result.expected_position.0,
            result.expected_position.1,
            result.requested_normalized.0,
            result.requested_normalized.1,
            result.message
        )))
    })
}

fn set_calibration(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let factor_x =
            require_number(&args, "factorX", "factorX", None, None).map_err(anyhow::Error::msg)?;
        let factor_y =
            require_number(&args, "factorY", "factorY", None, None).map_err(anyhow::Error::msg)?;
        shared.client.set_calibration_factors(factor_x, factor_y)?;
        let calibration = shared.client.get_calibration();
        let resolution_text = match calibration {
            Some(c) => format!("{}x{}", c.resolution.width, c.resolution.height),
            None => "unknown".to_string(),
        };
        Ok(ToolOutcome::text(format!(
            "Calibration set: factorX={factor_x:.4}, factorY={factor_y:.4}\nResolution at calibration: \
             {resolution_text}\nNote: Calibration will be automatically cleared if resolution changes."
        )))
    })
}

fn get_calibration(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        match shared.client.get_calibration() {
            Some(c) => Ok(ToolOutcome::text(format!(
                "Current calibration:\n  factorX: {:.4}\n  factorY: {:.4}\n  Resolution at calibration: {}x{}",
                c.factor_x, c.factor_y, c.resolution.width, c.resolution.height
            ))),
            None => Ok(ToolOutcome::text("Not calibrated. Mouse coordinates use default 1.0 factor (no correction).")),
        }
    })
}

fn clear_calibration(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        shared.client.clear_calibration();
        Ok(ToolOutcome::text(
            "Calibration cleared. Mouse coordinates now use default 1.0 factor (no correction).",
        ))
    })
}
