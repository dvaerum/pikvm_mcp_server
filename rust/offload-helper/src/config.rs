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
    /// An HTTP CONNECT proxy to tunnel the WS connection through, e.g.
    /// `http://127.0.0.1:8888`. Reuses `PIKVM_PROXY` — this project's
    /// OWN established env var name for exactly this (a loopback
    /// tinyproxy routing around a network/TCC restriction on direct
    /// outbound connections; see docs/project memory on
    /// `macos_local_network_proxy`) — rather than inventing a
    /// second, offload-specific name for the same knob.
    pub proxy_url: Option<String>,
    /// Skip TLS certificate verification for `wss://` targets — needed
    /// for a `pikvm-mcp-server` behind its own self-signed appliance
    /// cert (matches the spirit of this project's existing
    /// `PikvmConfig::verify_ssl`/`--insecure` knobs for talking to a
    /// PiKVM appliance's own cert, ported here as its own explicit,
    /// named opt-in rather than an implicit always-off default).
    pub insecure_tls: bool,
}

/// Flags with no value argument — presence alone is the signal.
const BOOL_FLAGS: &[&str] = &["insecure-tls"];

fn scan_flags(argv: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut i = 0;
    while i < argv.len() {
        if let Some(name) = argv[i].strip_prefix("--") {
            if BOOL_FLAGS.contains(&name) {
                out.insert(name.to_string(), "1".to_string());
                i += 1;
                continue;
            }
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

    let proxy_url = flags
        .get("proxy")
        .cloned()
        .or_else(|| env.get("PIKVM_PROXY").cloned())
        .filter(|v| !v.is_empty());

    let insecure_tls = flags.contains_key("insecure-tls")
        || matches!(
            env.get("PIKVM_OFFLOAD_INSECURE_TLS").map(String::as_str),
            Some("1")
        );

    Ok(HelperOptions {
        server_url,
        token,
        label,
        model_path,
        proxy_url,
        insecure_tls,
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

    fn base_env() -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert(
            "PIKVM_OFFLOAD_SERVER_URL".to_string(),
            "ws://x/offload/ws".to_string(),
        );
        env.insert("PIKVM_OFFLOAD_TOKEN".to_string(), "t".to_string());
        env
    }

    #[test]
    fn proxy_url_is_none_by_default() {
        let opts = parse_cli_options(&argv(&[]), &base_env(), || None).unwrap();
        assert_eq!(opts.proxy_url, None);
    }

    #[test]
    fn proxy_url_reuses_the_projects_own_pikvm_proxy_env_var() {
        let mut env = base_env();
        env.insert(
            "PIKVM_PROXY".to_string(),
            "http://127.0.0.1:8888".to_string(),
        );
        let opts = parse_cli_options(&argv(&[]), &env, || None).unwrap();
        assert_eq!(opts.proxy_url, Some("http://127.0.0.1:8888".to_string()));
    }

    #[test]
    fn proxy_flag_takes_precedence_over_env() {
        let mut env = base_env();
        env.insert(
            "PIKVM_PROXY".to_string(),
            "http://from-env:8888".to_string(),
        );
        let opts =
            parse_cli_options(&argv(&["--proxy", "http://from-flag:8888"]), &env, || None).unwrap();
        assert_eq!(opts.proxy_url, Some("http://from-flag:8888".to_string()));
    }

    #[test]
    fn insecure_tls_defaults_to_false() {
        let opts = parse_cli_options(&argv(&[]), &base_env(), || None).unwrap();
        assert!(!opts.insecure_tls);
    }

    #[test]
    fn insecure_tls_flag_is_a_bare_boolean_not_a_value_consumer() {
        // Must not swallow the NEXT argument as its own value.
        let opts = parse_cli_options(
            &argv(&["--insecure-tls", "--label", "my-label"]),
            &base_env(),
            || None,
        )
        .unwrap();
        assert!(opts.insecure_tls);
        assert_eq!(opts.label, "my-label");
    }

    #[test]
    fn insecure_tls_env_var_requires_the_literal_string_one() {
        let mut env = base_env();
        env.insert("PIKVM_OFFLOAD_INSECURE_TLS".to_string(), "true".to_string());
        let opts = parse_cli_options(&argv(&[]), &env, || None).unwrap();
        assert!(
            !opts.insecure_tls,
            "only the literal \"1\" should enable it"
        );

        env.insert("PIKVM_OFFLOAD_INSECURE_TLS".to_string(), "1".to_string());
        let opts = parse_cli_options(&argv(&[]), &env, || None).unwrap();
        assert!(opts.insecure_tls);
    }
}
