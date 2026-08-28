//! Faithful port of `index.ts`'s `handle_pikvm_mover_scale_status`/
//! `handle_pikvm_mover_scale_control`/`handle_pikvm_mover_scale_reset`.
//!
//! EXPERIMENTAL (#41), off by default: these 3 tools are registered ONLY
//! when `PIKVM_MOVER_LEARN=1` is set at process startup — matching
//! index.ts's own `activeToolRegistry` filter (`toolRegistry` minus
//! `MOVER_SCALE_TOOL_NAMES` unless `scaleLearner.isFeatureEnabled()`).
//! `entries()` reads the env once at startup (called from
//! `tool_registry()`, itself called once in `SharedState::new`) — same
//! module-load-time evaluation semantics as the TS source's own
//! `scaleLearner` singleton construction.

use std::sync::Arc;

use pikvm_mcp_mover::scale_learner::{AxisStatus, LearnerState, LearnerStatus, ScaleLearner};

use crate::server::SharedState;
use crate::tool_helpers::validate_enum;
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    if std::env::var("PIKVM_MOVER_LEARN").as_deref() != Ok("1") {
        return Vec::new();
    }
    vec![
        ToolEntry {
            name: "pikvm_mover_scale_status",
            description: "EXPERIMENTAL (#41, opt-in via PIKVM_MOVER_LEARN=1). Report the passive curve-scale \
                           learner: per-axis applied scale, the UNCLAMPED estimate, shipped defaults, \
                           divergence, sample counters, window SE, last update, and warnings. Read-only."
                .to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(mover_scale_status(shared))),
        },
        ToolEntry {
            name: "pikvm_mover_scale_control",
            description: "EXPERIMENTAL (#41). Enable or disable the passive curve-scale learner within this \
                           opted-in session. disable FREEZES it at the shipped default; enable resumes."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["enable", "disable"], "description": "enable to resume adapting, disable to freeze at the current scales."}
                },
                "required": ["action"]
            }),
            handler: Arc::new(|shared, args| Box::pin(mover_scale_control(shared, args))),
        },
        ToolEntry {
            name: "pikvm_mover_scale_reset",
            description: "EXPERIMENTAL (#41). Reset the passive curve-scale learner to the shipped defaults: \
                           clears the learned state AND deletes the persisted file."
                .to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(mover_scale_reset(shared))),
        },
    ]
}

fn axis_status_json(a: &AxisStatus) -> serde_json::Value {
    serde_json::json!({
        "applied": a.applied,
        "estimatedScale": a.estimated_scale,
        "shippedDefault": a.shipped_default,
        "divergenceFromDefault": a.divergence_from_default,
        "seen": a.seen,
        "accepted": a.accepted,
        "rejected": a.rejected,
        "windowSize": a.window_size,
        "windowBalance": {"up": a.window_balance.up, "down": a.window_balance.down},
        "windowSe": a.window_se,
        "lastUpdate": a.last_update,
        "slope": a.slope,
        "intercept": a.intercept,
        "warnings": a.warnings,
    })
}

fn learner_state_str(s: LearnerState) -> &'static str {
    match s {
        LearnerState::Disabled => "disabled",
        LearnerState::IdleNoQualifyingSamplesYet => "idle-no-qualifying-samples-yet",
        LearnerState::Learning => "learning",
    }
}

fn status_json(status: &LearnerStatus) -> serde_json::Value {
    serde_json::json!({
        "experimental": status.experimental,
        "featureEnabled": status.feature_enabled,
        "active": status.active,
        "state": learner_state_str(status.state),
        "x": axis_status_json(&status.x),
        "y": axis_status_json(&status.y),
    })
}

fn mover_scale_status(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let learner = shared.scale_learner.lock().unwrap();
        Ok(ToolOutcome::text(serde_json::to_string_pretty(
            &status_json(&learner.status()),
        )?))
    })
}

fn mover_scale_control(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let action = validate_enum(&args, "action", &["enable", "disable"], "enable").to_string();
        let mut learner = shared.scale_learner.lock().unwrap();
        if action == "disable" {
            learner.disable();
        } else {
            learner.enable();
        }
        let note = if action == "disable" {
            "Frozen at the current scales; no further adapting or persisting."
        } else {
            "Resumed adapting from real moves."
        };
        Ok(ToolOutcome::text(format!(
            "Passive scale learner {action}d. {note}\n{}",
            serde_json::to_string_pretty(&status_json(&learner.status()))?
        )))
    })
}

fn mover_scale_reset(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        {
            let mut learner = shared.scale_learner.lock().unwrap();
            learner.reset();
        }
        let env: std::collections::HashMap<String, String> = std::env::vars().collect();
        let deleted = pikvm_mcp_mover::scale_persist::delete_persisted(&env).await;
        let learner = shared.scale_learner.lock().unwrap();
        Ok(ToolOutcome::text(format!(
            "Passive scale learner RESET to shipped defaults; persisted state {}.\n{}",
            if deleted {
                "deleted"
            } else {
                "not found/undeletable"
            },
            serde_json::to_string_pretty(&status_json(&learner.status()))?
        )))
    })
}

/// Faithful port of `startScaleLearnerPersistence`'s warm-start half only
/// (the periodic-flush timer half needs a background task the stdio
/// entry-point doesn't currently run one of — see main.rs). A true no-op
/// when the feature isn't opted in, matching the TS source's own
/// early-return.
pub async fn load_warm_start(learner: &std::sync::Mutex<ScaleLearner>) {
    let feature_enabled = learner.lock().unwrap().is_feature_enabled();
    if !feature_enabled {
        return;
    }
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    if let Some(persisted) = pikvm_mcp_mover::scale_persist::load_persisted(&env).await {
        let x = Some((persisted.scales.x.applied, persisted.scales.x.last_update));
        let y = Some((persisted.scales.y.applied, persisted.scales.y.last_update));
        learner.lock().unwrap().load_snapshot(x, y);
    }
}
