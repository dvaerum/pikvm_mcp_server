//! Operator-hint enrichment for MCP tool error messages.
//!
//! Faithful port of `src/operator-hints.ts`.
//!
//! When a tool throws, the central catch handler (module 6's eventual MCP
//! dispatch) returns the raw error message to the MCP client. Some error
//! patterns are actionable but their raw form doesn't say so:
//!
//! - "PiKVM API error 503 ... UnavailableError ... Service Unavailable"
//!   means the streamer source is offline (the device behind the HDMI
//!   cable is off / mid-reboot / unplugged), not that PiKVM is down. The
//!   LLM agent should call `pikvm_health_check` first to see
//!   `streamer.source.online` before retrying or escalating.
//!
//! `append_operator_hint(message)` matches against known patterns and
//! appends a one-line hint when a match fires. Pure: no I/O, no state,
//! deterministic.
//!
//! Adding a new hint = add a pattern + line below. Order matters: more
//! specific patterns first (the first match wins).

/// Note: this file lives in the `kvmd-client` crate (module 2) per
/// `docs/rust-port-plan.md` §7's own module grouping, even though the TS
/// source sits at top-level `src/operator-hints.ts` rather than under
/// `src/pikvm/` — the plan groups it with `client.ts`/`streamer-keepalive.ts`
/// since it's error-message policy specifically for kvmd transport errors.
pub fn append_operator_hint(message: &str) -> String {
    match match_hint(message) {
        // Newline + bullet keeps the hint visually separate from the raw
        // error in MCP clients that render Markdown.
        Some(hint) => format!("{message}\n  → {hint}"),
        None => message.to_string(),
    }
}

fn match_hint(message: &str) -> Option<&'static str> {
    // 503 / UnavailableError → source-side outage (streamer state).
    if contains_word_503(message) && message.to_lowercase().contains("unavailableerror") {
        return Some(
            "Source-side outage suspected: the device behind the HDMI cable \
             (iPad in our setup) is likely off, mid-reboot, or unplugged. Run \
             pikvm_health_check first — it reports streamer.source.online and \
             lets you confirm before retrying.",
        );
    }

    // Bare "Service Unavailable" (the user-visible part of the 503 body)
    // can appear without the numeric code on some error paths. Same hint.
    if message.to_lowercase().contains("service unavailable") {
        return Some(
            "Source-side outage suspected: streamer reports unavailable. Run \
             pikvm_health_check first to see whether the device behind the \
             HDMI cable is offline before retrying.",
        );
    }

    None
}

/// Faithful port of the TS regex `/\b503\b/` — "503" as a whole word (word
/// boundaries on both sides), not merely a substring (so e.g. "15033"
/// doesn't false-match). Hand-rolled rather than pulling in the `regex`
/// crate for one pattern in one function — a plain byte scan is simpler to
/// audit here and needs no dependency.
fn contains_word_503(message: &str) -> bool {
    let bytes = message.as_bytes();
    let needle = b"503";
    let is_word_byte = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut i = 0;
    while let Some(pos) = find_subslice(&bytes[i..], needle) {
        let start = i + pos;
        let end = start + needle.len();
        let left_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let right_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok {
            return true;
        }
        i = start + 1;
    }
    false
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_hint_for_an_unrelated_message() {
        let msg = "PiKVM API error 401: unauthorized";
        assert_eq!(append_operator_hint(msg), msg);
    }

    #[test]
    fn hint_fires_for_503_plus_unavailableerror() {
        let msg = "PiKVM API error 503: {\"ok\":false,\"result\":{\"error\":\"UnavailableError\",\"error_msg\":\"Service Unavailable\"}}";
        let result = append_operator_hint(msg);
        assert!(result.starts_with(msg));
        assert!(result.contains("Source-side outage suspected"));
        assert!(result.contains("pikvm_health_check"));
    }

    #[test]
    fn hint_fires_for_bare_service_unavailable_without_the_numeric_code() {
        let msg = "streamer returned: Service Unavailable";
        let result = append_operator_hint(msg);
        assert!(result.contains("Source-side outage suspected"));
    }

    #[test]
    fn the_503_pattern_is_case_sensitive_on_the_digits_but_matched_as_a_whole_word() {
        // "15033" must NOT match \b503\b — regression target for the
        // word-boundary hand-rolled scan.
        let msg = "error code 15033 UnavailableError";
        assert_eq!(append_operator_hint(msg), msg);
    }

    #[test]
    fn unavailableerror_matching_is_case_insensitive() {
        let msg = "503 unavailableerror";
        let result = append_operator_hint(msg);
        assert!(result.contains("Source-side outage suspected"));
    }

    #[test]
    fn service_unavailable_matching_is_case_insensitive() {
        let msg = "SERVICE UNAVAILABLE";
        let result = append_operator_hint(msg);
        assert!(result.contains("Source-side outage suspected"));
    }

    #[test]
    fn more_specific_503_pattern_wins_when_both_could_match() {
        // Both patterns' triggers are present; the 503+UnavailableError
        // branch is checked first (matches the TS "order matters, more
        // specific first" doc) — assert the FIRST hint's exact wording wins,
        // not the second's, so a future reordering regresses visibly.
        let msg = "503 UnavailableError: Service Unavailable";
        let result = append_operator_hint(msg);
        assert!(result.contains("it reports streamer.source.online")); // first hint's distinguishing phrase
    }

    #[test]
    fn contains_word_503_rejects_a_run_of_digits_that_merely_contains_503() {
        assert!(!contains_word_503("415033"));
        assert!(!contains_word_503("50399"));
    }

    #[test]
    fn contains_word_503_accepts_503_at_the_very_start_or_end_of_the_string() {
        assert!(contains_word_503("503"));
        assert!(contains_word_503("503 error"));
        assert!(contains_word_503("error 503"));
    }
}
