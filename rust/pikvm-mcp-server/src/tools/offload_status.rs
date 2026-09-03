//! `pikvm_offload_status` (docs/cursor-offload-inference-design.md,
//! task_d06561d91f58): reports the cascade-inference offload feature's
//! current connection state, plus concrete setup instructions when
//! there's something an operator could actually do about it (the feature
//! is off, or it's on but nothing's connected). Design decision #10b —
//! the standalone-tool half of discoverability; `tools::offload_hint` is
//! the passive half, nudging move/click responses.

use std::sync::Arc;

use crate::server::SharedState;
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![ToolEntry {
        name: "pikvm_offload_status",
        description: "Reports whether the cascade-inference offload feature (a remote helper that runs cursor \
                       detection on a faster machine) is enabled, and whether a helper is currently connected. \
                       Includes setup instructions when relevant."
            .to_string(),
        input_schema: serde_json::json!({"type": "object", "properties": {}}),
        handler: Arc::new(|shared, _args| Box::pin(offload_status(shared))),
    }]
}

fn offload_status(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let Some(offload) = &shared.offload else {
            return Ok(ToolOutcome::text(
                "Offload: DISABLED.\n\n\
                 To enable it, start this server with PIKVM_OFFLOAD_ENABLED=1 and a token \
                 (PIKVM_OFFLOAD_TOKEN, PIKVM_OFFLOAD_TOKEN_FILE, or the \"pikvm-offload-token\" \
                 systemd credential) — HTTP transport only.",
            ));
        };

        if offload.is_connected().await {
            return Ok(ToolOutcome::text(
                "Offload: ENABLED, a helper IS connected. Cascade inference is currently running \
                 remotely.",
            ));
        }

        Ok(ToolOutcome::text(setup_instructions()))
    })
}

fn setup_instructions() -> String {
    "Offload: ENABLED, but no helper is currently connected. Cascade inference is running \
     locally (correct, just slower).\n\n\
     To connect a helper from another machine:\n\
     1. Download the pikvm-offload-helper release for that machine's platform (bundles the \
        binary + the matching ml/crop-heatmap.onnx + a matching onnxruntime library).\n\
     2. Run it:\n\
     \u{2003}PIKVM_OFFLOAD_SERVER_URL=ws://<this-server-host>:<port>/offload/ws \\\n\
     \u{2003}PIKVM_OFFLOAD_TOKEN=<the SAME token this server was started with> \\\n\
     \u{2003}./pikvm-offload-helper\n\
     3. It connects out (no inbound port needed on its side), authenticates with the shared \
        token, and starts serving inference requests once its model hash matches this server's \
        bundled model exactly.\n\n\
     It reconnects automatically with backoff if the connection drops — nothing else to \
     configure on this server's side."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_instructions_names_the_env_vars_an_operator_actually_needs() {
        let text = setup_instructions();
        assert!(text.contains("PIKVM_OFFLOAD_SERVER_URL"));
        assert!(text.contains("PIKVM_OFFLOAD_TOKEN"));
        assert!(text.contains("pikvm-offload-helper"));
    }
}
