//! Configuration management for PiKVM MCP Server.
//!
//! Faithful port of `src/config.ts`.
//!
//! Reads configuration from environment variables. Supports a `.env` file
//! via `dotenvy` (the maintained Rust `dotenv` fork).
//!
//! Distinct from `settings`: this module owns the CONNECTION config
//! (host/password/…) and panics (mirroring the TS `throw`) when a required
//! value is missing — appropriate for "we can't talk to the device".
//! `settings` owns OPTIONAL tuning flags and never panics.

use crate::auth::HttpAuth;
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub struct PikvmConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
    pub default_keymap: String,
    pub proxy_url: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CalibrationConfig {
    pub rounds: i64,
    pub verify_rounds: i64,
    pub move_delay_ms: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub pikvm: PikvmConfig,
    pub calibration: CalibrationConfig,
}

/// Secret files (sops-nix, systemd credentials, docker secrets)
/// conventionally carry a trailing newline from `echo`; strip trailing
/// newlines only. Faithful port of `readSecretFile`.
fn read_secret_file(path: &str) -> std::io::Result<String> {
    let raw = std::fs::read_to_string(path)?;
    Ok(raw.trim_end_matches(['\r', '\n']).to_string())
}

/// Resolve a config/secret value from, in precedence order:
///   1. the direct env var `name` (e.g. PIKVM_PASSWORD),
///   2. a file named by `${name}_FILE` (e.g. PIKVM_PASSWORD_FILE) — its
///      contents,
///   3. `$CREDENTIALS_DIRECTORY/<cred_name>` — the directory systemd
///      populates from LoadCredential / LoadCredentialEncrypted (and where
///      sops-nix secrets can be pointed).
///
/// Returns `None` when none is set. Faithful port of `resolveSecret`. Panics
/// only if a referenced secret FILE exists but can't be read (I/O error) —
/// matching the TS original's unhandled `readFileSync` throw in that case;
/// a MISSING var/file at each precedence tier is not an error, it's "try the
/// next tier."
pub fn resolve_secret(
    env: &HashMap<String, String>,
    name: &str,
    cred_name: Option<&str>,
) -> Option<String> {
    if let Some(direct) = env.get(name) {
        if !direct.is_empty() {
            return Some(direct.clone());
        }
    }

    if let Some(file_path) = env.get(&format!("{name}_FILE")) {
        return Some(
            read_secret_file(file_path)
                .unwrap_or_else(|e| panic!("resolve_secret: couldn't read {file_path}: {e}")),
        );
    }

    if let (Some(cred_dir), Some(cred_name)) = (env.get("CREDENTIALS_DIRECTORY"), cred_name) {
        let cred_path = Path::new(cred_dir).join(cred_name);
        if cred_path.exists() {
            let cred_path_str = cred_path.to_string_lossy().to_string();
            return Some(
                read_secret_file(&cred_path_str).unwrap_or_else(|e| {
                    panic!("resolve_secret: couldn't read {cred_path_str}: {e}")
                }),
            );
        }
    }

    None
}

pub struct CliAuthArgs {
    pub auth_username: Option<String>,
    pub auth_password: Option<String>,
    pub auth_password_file: Option<String>,
}

/// Resolve the MCP HTTP auth credentials (for `--security yes`). Password
/// comes from, in precedence order: the `--auth-password` flag, the
/// `--auth-password-file` flag, then `PIKVM_MCP_AUTH_PASSWORD` / `_FILE` /
/// the `pikvm-mcp-auth-password` systemd credential (via `resolve_secret`).
/// Username: `--auth-username` / env / `"operator"`. Returns `None` when no
/// password is configured (the eventual `main()` then refuses to serve
/// `--security yes`). Faithful port of `resolveHttpAuth`.
pub fn resolve_http_auth(env: &HashMap<String, String>, cli: &CliAuthArgs) -> Option<HttpAuth> {
    let username = cli
        .auth_username
        .clone()
        .filter(|v| !v.is_empty())
        .or_else(|| {
            env.get("PIKVM_MCP_AUTH_USERNAME")
                .filter(|v| !v.is_empty())
                .cloned()
        })
        .unwrap_or_else(|| "operator".to_string());

    let mut password = cli.auth_password.clone().filter(|v| !v.is_empty());
    if password.is_none() {
        if let Some(file) = &cli.auth_password_file {
            password = Some(
                read_secret_file(file)
                    .unwrap_or_else(|e| panic!("resolve_http_auth: couldn't read {file}: {e}")),
            );
        }
    }
    if password.as_deref().map(str::is_empty).unwrap_or(true) {
        password = resolve_secret(
            env,
            "PIKVM_MCP_AUTH_PASSWORD",
            Some("pikvm-mcp-auth-password"),
        );
    }

    let password = password.filter(|v| !v.is_empty())?;
    Some(HttpAuth { username, password })
}

/// Load `.env` from the given path into the process environment, with
/// `.env` values taking precedence over any pre-existing env vars —
/// matching the TS `loadEnv({path, quiet: true, override: true})` call.
/// Silently does nothing if the file doesn't exist (same as dotenv's own
/// tolerant default when the file is simply absent).
pub fn load_dotenv_override(path: &Path) {
    if let Ok(iter) = dotenvy::from_path_iter(path) {
        for item in iter.flatten() {
            let (key, value) = item;
            std::env::set_var(key, value);
        }
    }
}

/// Load the connection [`Config`] from the real process environment.
/// Faithful port of `loadConfig()`. Panics with the same message shape as
/// the TS `throw` when `PIKVM_HOST` isn't resolvable from any tier.
pub fn load_config() -> Config {
    let env: HashMap<String, String> = std::env::vars().collect();
    load_config_from(&env)
}

/// Pure core of [`load_config`], taking an explicit env map — the
/// TS source's `loadConfig()` reads `process.env` directly with no
/// injection point; this split exists so the port stays unit-testable
/// without mutating real process env for every case (`load_config()`
/// itself is the thin real-environment wrapper faithful callers use).
pub fn load_config_from(env: &HashMap<String, String>) -> Config {
    let host = resolve_secret(env, "PIKVM_HOST", Some("pikvm-host")).unwrap_or_else(|| {
        panic!(
            "PiKVM host is required — set PIKVM_HOST, PIKVM_HOST_FILE, or provide a \
             systemd credential named \"pikvm-host\" (LoadCredential)."
        )
    });

    // The PiKVM password is OPTIONAL at startup: when the server runs on the
    // PiKVM itself (or acts purely as an authenticated MCP gateway) the
    // operator may not want to embed device credentials. It defaults to
    // empty; kvmd then returns a clear auth error only if/when a tool
    // actually drives the device.
    let password =
        resolve_secret(env, "PIKVM_PASSWORD", Some("pikvm-password")).unwrap_or_default();

    Config {
        pikvm: PikvmConfig {
            host,
            username: resolve_secret(env, "PIKVM_USERNAME", Some("pikvm-username"))
                .unwrap_or_else(|| "admin".to_string()),
            password,
            verify_ssl: env.get("PIKVM_VERIFY_SSL").map(String::as_str) == Some("true"),
            default_keymap: env
                .get("PIKVM_DEFAULT_KEYMAP")
                .filter(|v| !v.is_empty())
                .cloned()
                .unwrap_or_else(|| "en-us".to_string()),
            // Route outbound PiKVM requests through a proxy when configured.
            // Only the DEDICATED PIKVM_PROXY is honored — deliberately NOT
            // the ambient HTTPS_PROXY/ALL_PROXY, which shells commonly
            // export for internet traffic. The PiKVM is a LAN host;
            // inheriting an unrelated corporate proxy would silently
            // reroute (and break) all device traffic with no opt-in.
            proxy_url: env
                .get("PIKVM_PROXY")
                .filter(|v| !v.is_empty())
                .cloned()
                .unwrap_or_default(),
        },
        calibration: CalibrationConfig {
            rounds: env
                .get("PIKVM_CALIBRATION_ROUNDS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
            verify_rounds: env
                .get("PIKVM_CALIBRATION_VERIFY_ROUNDS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
            move_delay_ms: env
                .get("PIKVM_CALIBRATION_MOVE_DELAY")
                .and_then(|v| v.parse().ok())
                .unwrap_or(300),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_from(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    // -- resolve_secret --

    #[test]
    fn resolve_secret_prefers_the_direct_env_var() {
        let env = env_from(&[("PIKVM_HOST", "https://direct.example")]);
        assert_eq!(
            resolve_secret(&env, "PIKVM_HOST", Some("pikvm-host")),
            Some("https://direct.example".to_string())
        );
    }

    #[test]
    fn resolve_secret_returns_none_when_nothing_is_set() {
        let env = HashMap::new();
        assert_eq!(resolve_secret(&env, "PIKVM_HOST", Some("pikvm-host")), None);
    }

    #[test]
    fn resolve_secret_falls_back_to_a_named_file_and_strips_trailing_newline() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("pikvm-test-secret-{}.txt", std::process::id()));
        std::fs::write(&path, "file-value\n").unwrap();
        let env = env_from(&[("PIKVM_HOST_FILE", path.to_str().unwrap())]);

        let result = resolve_secret(&env, "PIKVM_HOST", Some("pikvm-host"));

        std::fs::remove_file(&path).ok();
        assert_eq!(result, Some("file-value".to_string()));
    }

    #[test]
    fn resolve_secret_falls_back_to_credentials_directory() {
        let dir = std::env::temp_dir().join(format!("pikvm-test-creddir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pikvm-host"), "cred-value\n").unwrap();
        let env = env_from(&[("CREDENTIALS_DIRECTORY", dir.to_str().unwrap())]);

        let result = resolve_secret(&env, "PIKVM_HOST", Some("pikvm-host"));

        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(result, Some("cred-value".to_string()));
    }

    #[test]
    fn resolve_secret_precedence_direct_env_beats_file_beats_credentials_directory() {
        let dir =
            std::env::temp_dir().join(format!("pikvm-test-precedence-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pikvm-host"), "cred-value").unwrap();
        let file_path = dir.join("file-secret.txt");
        std::fs::write(&file_path, "file-value").unwrap();
        let env = env_from(&[
            ("PIKVM_HOST", "direct-value"),
            ("PIKVM_HOST_FILE", file_path.to_str().unwrap()),
            ("CREDENTIALS_DIRECTORY", dir.to_str().unwrap()),
        ]);

        let result = resolve_secret(&env, "PIKVM_HOST", Some("pikvm-host"));

        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(result, Some("direct-value".to_string()));
    }

    // -- resolve_http_auth --

    #[test]
    fn resolve_http_auth_returns_none_when_no_password_is_configured_anywhere() {
        let env = HashMap::new();
        let cli = CliAuthArgs {
            auth_username: None,
            auth_password: None,
            auth_password_file: None,
        };
        assert_eq!(resolve_http_auth(&env, &cli), None);
    }

    #[test]
    fn resolve_http_auth_defaults_username_to_operator() {
        let env = HashMap::new();
        let cli = CliAuthArgs {
            auth_username: None,
            auth_password: Some("secret".into()),
            auth_password_file: None,
        };
        let auth = resolve_http_auth(&env, &cli).unwrap();
        assert_eq!(auth.username, "operator");
        assert_eq!(auth.password, "secret");
    }

    #[test]
    fn resolve_http_auth_cli_password_takes_precedence_over_env() {
        let env = env_from(&[("PIKVM_MCP_AUTH_PASSWORD", "env-secret")]);
        let cli = CliAuthArgs {
            auth_username: None,
            auth_password: Some("cli-secret".into()),
            auth_password_file: None,
        };
        let auth = resolve_http_auth(&env, &cli).unwrap();
        assert_eq!(auth.password, "cli-secret");
    }

    #[test]
    fn resolve_http_auth_falls_back_to_env_password_when_no_cli_password() {
        let env = env_from(&[("PIKVM_MCP_AUTH_PASSWORD", "env-secret")]);
        let cli = CliAuthArgs {
            auth_username: None,
            auth_password: None,
            auth_password_file: None,
        };
        let auth = resolve_http_auth(&env, &cli).unwrap();
        assert_eq!(auth.password, "env-secret");
    }

    // -- load_config_from --

    #[test]
    #[should_panic(expected = "PiKVM host is required")]
    fn load_config_panics_without_a_host() {
        load_config_from(&HashMap::new());
    }

    #[test]
    fn load_config_applies_documented_defaults() {
        let env = env_from(&[("PIKVM_HOST", "https://pikvm.example")]);
        let config = load_config_from(&env);
        assert_eq!(config.pikvm.host, "https://pikvm.example");
        assert_eq!(config.pikvm.username, "admin");
        assert_eq!(config.pikvm.password, "");
        assert!(!config.pikvm.verify_ssl);
        assert_eq!(config.pikvm.default_keymap, "en-us");
        assert_eq!(config.pikvm.proxy_url, "");
        assert_eq!(config.calibration.rounds, 5);
        assert_eq!(config.calibration.verify_rounds, 5);
        assert_eq!(config.calibration.move_delay_ms, 300);
    }

    #[test]
    fn load_config_reads_all_overrides() {
        let env = env_from(&[
            ("PIKVM_HOST", "https://pikvm.example"),
            ("PIKVM_USERNAME", "custom-user"),
            ("PIKVM_PASSWORD", "custom-pass"),
            ("PIKVM_VERIFY_SSL", "true"),
            ("PIKVM_DEFAULT_KEYMAP", "de-de"),
            ("PIKVM_PROXY", "http://127.0.0.1:8888"),
            ("PIKVM_CALIBRATION_ROUNDS", "10"),
            ("PIKVM_CALIBRATION_VERIFY_ROUNDS", "3"),
            ("PIKVM_CALIBRATION_MOVE_DELAY", "500"),
        ]);
        let config = load_config_from(&env);
        assert_eq!(config.pikvm.username, "custom-user");
        assert_eq!(config.pikvm.password, "custom-pass");
        assert!(config.pikvm.verify_ssl);
        assert_eq!(config.pikvm.default_keymap, "de-de");
        assert_eq!(config.pikvm.proxy_url, "http://127.0.0.1:8888");
        assert_eq!(config.calibration.rounds, 10);
        assert_eq!(config.calibration.verify_rounds, 3);
        assert_eq!(config.calibration.move_delay_ms, 500);
    }

    #[test]
    fn load_config_only_treats_the_exact_string_true_as_verify_ssl_on() {
        let env = env_from(&[
            ("PIKVM_HOST", "https://pikvm.example"),
            ("PIKVM_VERIFY_SSL", "1"),
        ]);
        let config = load_config_from(&env);
        assert!(!config.pikvm.verify_ssl); // "1" is not "true"
    }

    // -- load_dotenv_override --

    #[test]
    fn load_dotenv_override_sets_vars_from_a_real_file_and_overrides_existing_ones() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("pikvm-test-dotenv-{}.env", std::process::id()));
        std::fs::write(&path, "PIKVM_TEST_DOTENV_VAR=from-file\n").unwrap();
        std::env::set_var("PIKVM_TEST_DOTENV_VAR", "pre-existing");

        load_dotenv_override(&path);

        let result = std::env::var("PIKVM_TEST_DOTENV_VAR");
        std::fs::remove_file(&path).ok();
        std::env::remove_var("PIKVM_TEST_DOTENV_VAR");
        assert_eq!(result.as_deref(), Ok("from-file")); // .env value WON, matching override:true
    }

    #[test]
    fn load_dotenv_override_is_a_silent_no_op_when_the_file_does_not_exist() {
        let missing = std::env::temp_dir().join("pikvm-this-file-does-not-exist.env");
        load_dotenv_override(&missing); // must not panic
    }
}
