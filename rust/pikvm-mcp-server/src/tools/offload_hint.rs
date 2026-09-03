//! Discoverability hint (docs/cursor-offload-inference-design.md,
//! task_d06561d91f58): a one-line nudge appended to move/click tool
//! responses when offload is enabled (`PIKVM_OFFLOAD_ENABLED=1`) but
//! nothing is currently connected — lets an operator who turned the
//! feature on but hasn't started the helper yet discover that fact from
//! ordinary tool output, without separately remembering to check
//! `pikvm_offload_status`.
//!
//! (Design decision #10 also names a "detect" tool category — this port
//! has no standalone `pikvm_*_detect` tool yet (cascade detection is only
//! ever reached indirectly, via move/click), so the hint is wired at
//! those two real call sites only; add a third call site here if/when a
//! standalone detect tool is ported.)

use crate::server::SharedState;
use crate::tools::{ToolContent, ToolOutcome};

/// `None` when offload is disabled entirely, or when a helper IS
/// connected (nothing to nudge about) — `Some` only in the "you turned
/// this on but nothing's listening" gap.
pub async fn maybe_offload_hint(shared: &SharedState) -> Option<String> {
    let offload = shared.offload.as_ref()?;
    if offload.is_connected().await {
        return None;
    }
    Some(
        "\nℹ offload: enabled but no helper is currently connected — cascade inference is \
         running locally. Run pikvm_offload_status for setup instructions.\n"
            .to_string(),
    )
}

/// Appends the hint (if any) to the outcome's first content block —
/// mirrors `mouse.rs`'s own `with_dead_zone_warning` (same "always Text,
/// leave `is_error` untouched" contract), suffix instead of prefix since
/// this is informational, not a warning about the call itself.
pub fn with_offload_hint(mut outcome: ToolOutcome, hint: Option<String>) -> ToolOutcome {
    let Some(hint) = hint else {
        return outcome;
    };
    if let Some(ToolContent::Text(text)) = outcome.content.first_mut() {
        text.push_str(&hint);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_offload_hint_is_a_no_op_when_hint_is_none() {
        let outcome = ToolOutcome::text("ok");
        let result = with_offload_hint(outcome.clone(), None);
        match (&result.content[0], &outcome.content[0]) {
            (ToolContent::Text(a), ToolContent::Text(b)) => assert_eq!(a, b),
            _ => panic!("expected Text content"),
        }
    }

    #[test]
    fn with_offload_hint_appends_to_the_first_text_block() {
        let outcome = ToolOutcome::text("moved to (10, 20)");
        let result = with_offload_hint(outcome, Some("\nhint text\n".to_string()));
        match &result.content[0] {
            ToolContent::Text(t) => {
                assert!(t.starts_with("moved to (10, 20)"));
                assert!(t.ends_with("\nhint text\n"));
            }
            _ => panic!("expected Text content"),
        }
    }

    #[test]
    fn with_offload_hint_preserves_is_error_in_both_directions() {
        let err_outcome =
            with_offload_hint(ToolOutcome::error_text("bad"), Some("hint".to_string()));
        assert!(err_outcome.is_error);

        let ok_outcome = with_offload_hint(ToolOutcome::text("ok"), Some("hint".to_string()));
        assert!(!ok_outcome.is_error);
    }
}
