//! Faithful port of `index.ts`'s `handle_pikvm_auto_calibrate`.

use std::sync::Arc;

use pikvm_mcp_mover::auto_calibrate::{auto_calibrate_with_retries, AutoCalibrationConfig};

use crate::server::SharedState;
use crate::tool_helpers::{validate_boolean, validate_number};
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![ToolEntry {
        name: "pikvm_auto_calibrate",
        description: "Auto-calibrate via move+diff screenshots. Blocks other tools while running (except \
                       itself/pikvm_measure_ballistics, which report their own 'in progress' message)."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "rounds": {"type": "number", "description": "2-20."},
                "verifyRounds": {"type": "number", "description": "1-20."},
                "moveDelayMs": {"type": "number", "description": "50-2000."},
                "mergeRadius": {"type": "number", "description": "0-200."},
                "minSamples": {"type": "number", "description": "1-20."},
                "maxRatioDivergence": {"type": "number", "description": "0-1."},
                "verbose": {"type": "boolean"}
            }
        }),
        handler: Arc::new(|shared, args| Box::pin(auto_calibrate_tool(shared, args))),
    }]
}

fn auto_calibrate_tool(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        {
            // See ballistics.rs's own comment on why the check-then-acquire
            // is one critical section here, not two — same TOCTOU gap.
            let mut lock = shared.lock.lock().unwrap();
            if lock.is_busy() {
                return Ok(ToolOutcome::error_text(
                    "Auto-calibration is already in progress.",
                ));
            }
            lock.acquire("Auto-calibration");
        }
        struct ReleaseOnDrop<'a>(&'a SharedState);
        impl Drop for ReleaseOnDrop<'_> {
            fn drop(&mut self) {
                self.0.lock.lock().unwrap().release();
            }
        }
        let _guard = ReleaseOnDrop(&shared);

        let defaults = AutoCalibrationConfig::default();
        let config = AutoCalibrationConfig {
            rounds: validate_number(&args, "rounds", Some(2.0), Some(20.0))
                .map(|v| v as u32)
                .unwrap_or(shared.calibration_config.rounds as u32),
            verify_rounds: validate_number(&args, "verifyRounds", Some(1.0), Some(20.0))
                .map(|v| v as u32)
                .unwrap_or(shared.calibration_config.verify_rounds as u32),
            move_delay_ms: validate_number(&args, "moveDelayMs", Some(50.0), Some(2000.0))
                .map(|v| v as u64)
                .unwrap_or(shared.calibration_config.move_delay_ms as u64),
            merge_radius: validate_number(&args, "mergeRadius", Some(0.0), Some(200.0))
                .unwrap_or(defaults.merge_radius),
            min_samples: validate_number(&args, "minSamples", Some(1.0), Some(20.0))
                .map(|v| v as usize)
                .unwrap_or(defaults.min_samples),
            max_ratio_divergence: validate_number(
                &args,
                "maxRatioDivergence",
                Some(0.0),
                Some(1.0),
            )
            .unwrap_or(defaults.max_ratio_divergence),
            verbose: validate_boolean(&args, "verbose").unwrap_or(false),
            ..defaults
        };

        let result = auto_calibrate_with_retries(&shared.client, config).await?;

        Ok(ToolOutcome::text(format!(
            "Auto-calibration {}.\nResolution: {}x{}\nFactors: X={:.4}, Y={:.4}\nConfidence: {:.0}%\nVerification \
             score: {}\nValid samples: {}/{}\n\n{}",
            if result.success { "succeeded" } else { "failed" },
            result.resolution.width,
            result.resolution.height,
            result.factor_x,
            result.factor_y,
            result.confidence * 100.0,
            result.verification_score,
            result.valid_samples,
            result.total_rounds,
            result.message
        )))
    })
}
