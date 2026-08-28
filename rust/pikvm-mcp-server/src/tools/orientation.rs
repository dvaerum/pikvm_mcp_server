//! Faithful port of `index.ts`'s `handle_pikvm_detect_orientation`.

use std::sync::Arc;

use pikvm_mcp_detection_vision::orientation::{detect_ipad_bounds, DetectOptions, IpadOrientation};

use crate::server::SharedState;
use crate::tool_helpers::validate_number;
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![ToolEntry {
        name: "pikvm_detect_orientation",
        description: "Detect the iPad's letterbox bounds/orientation within the HDMI capture."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "brightnessSum": {"type": "number", "description": "Per-channel sum (R+G+B) above which a pixel counts as iPad content rather than letterbox black (0-765)."}
            }
        }),
        handler: Arc::new(|shared, args| Box::pin(detect_orientation(shared, args))),
    }]
}

fn detect_orientation(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let mut options = DetectOptions::default();
        if let Some(sum) = validate_number(&args, "brightnessSum", Some(0.0), Some(765.0)) {
            options.brightness_sum = sum as u32;
        }
        let bounds = detect_ipad_bounds(&shared.client, options).await?;
        let orientation = match bounds.orientation {
            IpadOrientation::Portrait => "portrait",
            IpadOrientation::Landscape => "landscape",
        };
        let message = format!(
            "iPad {orientation} content: {}×{} at HDMI ({},{})→({},{}); centre ({},{}); HDMI frame {}×{}.",
            bounds.width,
            bounds.height,
            bounds.x,
            bounds.y,
            bounds.x + bounds.width - 1,
            bounds.y + bounds.height - 1,
            bounds.center_x,
            bounds.center_y,
            bounds.resolution.0,
            bounds.resolution.1
        );
        let json = serde_json::json!({
            "x": bounds.x,
            "y": bounds.y,
            "width": bounds.width,
            "height": bounds.height,
            "centerX": bounds.center_x,
            "centerY": bounds.center_y,
            "orientation": orientation,
            "resolution": {"width": bounds.resolution.0, "height": bounds.resolution.1},
        });
        Ok(ToolOutcome {
            content: vec![
                crate::tools::ToolContent::Text(message),
                crate::tools::ToolContent::Text(json.to_string()),
            ],
            is_error: false,
        })
    })
}
