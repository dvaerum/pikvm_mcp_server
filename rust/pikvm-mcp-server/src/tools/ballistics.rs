//! Faithful port of `index.ts`'s `handle_pikvm_measure_ballistics`.

use std::sync::Arc;

use pikvm_mcp_mover::ballistics::{measure_ballistics, Axis, MeasureBallisticsOptions, Pace};

use crate::server::SharedState;
use crate::tool_helpers::{validate_boolean, validate_number, validate_string};
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![ToolEntry {
        name: "pikvm_measure_ballistics",
        description: "Characterise the relative-mouse acceleration curve and write a ballistics profile. Blocks \
                       other tools while running (except itself/pikvm_auto_calibrate, which report their own \
                       'in progress' message)."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "magnitudes": {"type": "array", "items": {"type": "number"}, "description": "Mickey magnitudes to test, each in (0, 127]. Default: a built-in sweep."},
                "paces": {"type": "array", "items": {"type": "string", "enum": ["fast", "slow"]}, "description": "Which paces to test. Default: both."},
                "axes": {"type": "array", "items": {"type": "string", "enum": ["x", "y"]}, "description": "Which axes to test. Default: both."},
                "reps": {"type": "number", "description": "Repetitions per cell (1-10)."},
                "callsPerCell": {"type": "number", "description": "Calls of magnitude per rep (1-50)."},
                "slowPaceMs": {"type": "number", "description": "Inter-call delay for the slow pace, ms (0-1000)."},
                "profilePath": {"type": "string", "description": "Where to write the profile. Default: the standard profile path."},
                "verbose": {"type": "boolean"}
            }
        }),
        handler: Arc::new(|shared, args| Box::pin(measure_ballistics_tool(shared, args))),
    }]
}

fn measure_ballistics_tool(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        {
            // Single critical section for the check-then-acquire: index.ts's
            // `lock.isBusy` check and `lock.acquire()` are two statements
            // but Node is single-threaded, so nothing can interleave between
            // them. tokio genuinely can (two concurrent tool calls) — taking
            // ONE lock() guard across both the check and the acquire closes
            // that TOCTOU gap (BusyLock::acquire panics on an already-held
            // lock, so a race here would panic instead of returning the
            // intended graceful message).
            let mut lock = shared.lock.lock().unwrap();
            if lock.is_busy() {
                return Ok(ToolOutcome::error_text(
                    "Ballistics measurement is already in progress.",
                ));
            }
            lock.acquire("Ballistics measurement");
        }
        // Faithful port of index.ts's try/finally: the lock is released on
        // every exit path, including an early `?` error return, via this
        // guard's Drop impl.
        struct ReleaseOnDrop<'a>(&'a SharedState);
        impl Drop for ReleaseOnDrop<'_> {
            fn drop(&mut self) {
                self.0.lock.lock().unwrap().release();
            }
        }
        let _guard = ReleaseOnDrop(&shared);

        let magnitudes: Vec<f64> = args
            .get("magnitudes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_f64())
                    .filter(|&m| m > 0.0 && m <= 127.0)
                    .collect()
            })
            .unwrap_or_default();
        let paces: Vec<Pace> = args
            .get("paces")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| match v.as_str() {
                        Some("fast") => Some(Pace::Fast),
                        Some("slow") => Some(Pace::Slow),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let axes: Vec<Axis> = args
            .get("axes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| match v.as_str() {
                        Some("x") => Some(Axis::X),
                        Some("y") => Some(Axis::Y),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();

        let defaults = MeasureBallisticsOptions::default();
        let options = MeasureBallisticsOptions {
            magnitudes: if magnitudes.is_empty() {
                defaults.magnitudes
            } else {
                magnitudes
            },
            paces: if paces.is_empty() {
                defaults.paces
            } else {
                paces
            },
            axes: if axes.is_empty() { defaults.axes } else { axes },
            reps: validate_number(&args, "reps", Some(1.0), Some(10.0))
                .map(|v| v as u32)
                .unwrap_or(defaults.reps),
            calls_per_cell: validate_number(&args, "callsPerCell", Some(1.0), Some(50.0))
                .map(|v| v as u32)
                .unwrap_or(defaults.calls_per_cell),
            slow_pace_ms: validate_number(&args, "slowPaceMs", Some(0.0), Some(1000.0))
                .map(|v| v as u64)
                .unwrap_or(defaults.slow_pace_ms),
            profile_path: validate_string(&args, "profilePath").map(std::path::PathBuf::from),
            verbose: validate_boolean(&args, "verbose").unwrap_or(false),
            ..defaults
        };

        let result = measure_ballistics(&shared.client, options).await?;

        let mut summary = format!("{}\n", result.message);
        if let Some(profile) = &result.profile {
            let mut keys: Vec<&String> = profile.medians.keys().collect();
            keys.sort();
            summary.push_str("\nMedian px/mickey by cell:\n");
            for k in keys {
                summary.push_str(&format!("  {k} → {:.4}\n", profile.medians[k]));
            }
            // Refresh the in-memory profile so subsequent move-to calls use it.
            *shared.cached_profile.lock().unwrap() = Some(profile.clone());
        }

        Ok(ToolOutcome {
            content: vec![crate::tools::ToolContent::Text(summary)],
            is_error: !result.success,
        })
    })
}
