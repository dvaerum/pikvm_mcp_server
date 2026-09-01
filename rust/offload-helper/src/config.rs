//! CLI/env option resolution — a pure function of `(argv, env)`, matching
//! `pikvm-mcp-server/src/cli.rs`'s own convention (hand-rolled small flag
//! scanner, not `clap`, for the same reason that file gives: a handful of
//! flags scanned by hand stays unit-testable without a framework, and
//! this crate is a separate binary that can't reuse that file's private
//! helpers directly anyway).

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperOptions {
    /// The pikvm-mcp-server's offload WS endpoint, e.g.
    /// `ws://192.168.1.50:8080/offload/ws`.
    pub server_url: String,
    pub token: String,
    /// Sent as `Hello`'s `label` — purely informational (shows up in the
    /// server's own connect log and `pikvm_offload_status`), defaults to
    /// this machine's hostname when unset.
    pub label: String,
    /// Overrides detection-vision's own `resolve_verifier_model()`
    /// discovery when set — matches that function's own
    /// `PIKVM_ML_VERIFIER_MODEL` env var name deliberately (same knob,
    /// same effect, so operators don't need to learn two different
    /// override variables for what's conceptually the same setting).
    pub model_path: Option<String>,
}

fn scan_flags(argv: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut i = 0;
    while i < argv.len() {
        if let Some(name) = argv[i].strip_prefix("--") {
            if let Some(value) = argv.get(i + 1) {
                out.insert(name.to_string(), value.clone());
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Resolve helper options from (in precedence order) CLI flags, then env
/// vars, then a computed default. Returns `Err(message)` for the caller
/// to print and exit — kept pure so it's unit-testable without touching
/// real process env/args.
pub fn parse_cli_options(
    argv: &[String],
    env: &HashMap<String, String>,
    hostname: impl FnOnce() -> Option<String>,
) -> Result<HelperOptions, String> {
    let flags = scan_flags(argv);

    let server_url = flags
        .get("server")
        .cloned()
        .or_else(|| env.get("PIKVM_OFFLOAD_SERVER_URL").cloned())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            "A server URL is required — pass --server ws://host:port/offload/ws or set \
             PIKVM_OFFLOAD_SERVER_URL."
                .to_string()
        })?;

    let token = flags
        .get("token")
        .cloned()
        .filter(|v| !v.is_empty())
        .or_else(|| pikvm_mcp_foundation::config::resolve_offload_token(env))
        .ok_or_else(|| {
            "A token is required — pass --token, or set PIKVM_OFFLOAD_TOKEN / \
             PIKVM_OFFLOAD_TOKEN_FILE / the \"pikvm-offload-token\" systemd credential (the \
             SAME token the server was started with)."
                .to_string()
        })?;

    let label = flags
        .get("label")
        .cloned()
        .or_else(|| env.get("PIKVM_OFFLOAD_LABEL").cloned())
        .filter(|v| !v.is_empty())
        .or_else(hostname)
        .unwrap_or_else(|| "pikvm-offload-helper".to_string());

    let model_path = flags
        .get("model")
        .cloned()
        .or_else(|| env.get("PIKVM_ML_VERIFIER_MODEL").cloned())
        .filter(|v| !v.is_empty());

    Ok(HelperOptions {
        server_url,
        token,
        label,
        model_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn requires_a_server_url() {
        let env = HashMap::new();
        let result = parse_cli_options(&argv(&["--token", "t"]), &env, || None);
        assert!(result.unwrap_err().contains("server URL"));
    }

    #[test]
    fn requires_a_token() {
        let mut env = HashMap::new();
        env.insert(
            "PIKVM_OFFLOAD_SERVER_URL".to_string(),
            "ws://x/offload/ws".to_string(),
        );
        let result = parse_cli_options(&argv(&[]), &env, || None);
        assert!(result.unwrap_err().contains("token"));
    }

    #[test]
    fn cli_flags_take_precedence_over_env() {
        let mut env = HashMap::new();
        env.insert(
            "PIKVM_OFFLOAD_SERVER_URL".to_string(),
            "ws://from-env/offload/ws".to_string(),
        );
        let opts = parse_cli_options(
            &argv(&["--server", "ws://from-flag/offload/ws", "--token", "t"]),
            &env,
            || None,
        )
        .unwrap();
        assert_eq!(opts.server_url, "ws://from-flag/offload/ws");
    }

    #[test]
    fn token_resolves_via_the_shared_resolve_offload_token_precedence() {
        let mut env = HashMap::new();
        env.insert(
            "PIKVM_OFFLOAD_SERVER_URL".to_string(),
            "ws://x/offload/ws".to_string(),
        );
        env.insert("PIKVM_OFFLOAD_TOKEN".to_string(), "env-token".to_string());
        let opts = parse_cli_options(&argv(&[]), &env, || None).unwrap();
        assert_eq!(opts.token, "env-token");
    }

    #[test]
    fn label_falls_back_to_hostname_then_a_final_default() {
        let mut env = HashMap::new();
        env.insert(
            "PIKVM_OFFLOAD_SERVER_URL".to_string(),
            "ws://x/offload/ws".to_string(),
        );
        env.insert("PIKVM_OFFLOAD_TOKEN".to_string(), "t".to_string());

        let with_hostname =
            parse_cli_options(&argv(&[]), &env, || Some("my-mac".to_string())).unwrap();
        assert_eq!(with_hostname.label, "my-mac");

        let without_hostname = parse_cli_options(&argv(&[]), &env, || None).unwrap();
        assert_eq!(without_hostname.label, "pikvm-offload-helper");
    }

    #[test]
    fn model_path_is_none_by_default_letting_detection_vision_discover_it() {
        let mut env = HashMap::new();
        env.insert(
            "PIKVM_OFFLOAD_SERVER_URL".to_string(),
            "ws://x/offload/ws".to_string(),
        );
        env.insert("PIKVM_OFFLOAD_TOKEN".to_string(), "t".to_string());
        let opts = parse_cli_options(&argv(&[]), &env, || None).unwrap();
        assert_eq!(opts.model_path, None);
    }

    #[test]
    fn empty_string_flags_are_treated_as_unset() {
        let mut env = HashMap::new();
        env.insert("PIKVM_OFFLOAD_SERVER_URL".to_string(), "".to_string());
        let result = parse_cli_options(&argv(&["--token", "t"]), &env, || None);
        assert!(result.is_err());
    }
}
