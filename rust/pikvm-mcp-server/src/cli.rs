//! Command-line option parsing for the MCP server entry point.
//!
//! Transport is chosen by (in precedence order): the --transport/--http
//! flag, then the `PIKVM_MCP_TRANSPORT` env var, then the stdio default.
//! Host/port fall back the same way (flag > env > default) and only
//! matter in http mode. Kept as a pure function of (argv, env) so it is
//! fully unit-testable — mirrors `node:util`'s `parseArgs` usage in the
//! TS source; hand-rolled here rather than reaching for `clap` since a
//! dozen flags scanned by hand keeps the same explicit-(argv,env)-params
//! purity the TS version was deliberately written for (§6's "use a
//! mature crate" rule targets protocol/infra-scale hand-rolling — MCP
//! wire framing, HTTP, WebSocket — not a small flag scanner).
//!
//! The HTTP endpoint drives real input on a physical machine, so http
//! mode REQUIRES an explicit `--security yes|no|kvmd` choice (there is
//! deliberately no default): `yes` enforces authentication (see
//! `foundation::auth`), `no` serves it open, `kvmd` delegates to the
//! appliance's own credentials.
//!
//! Faithful port of `src/cli.ts`.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    Stdio,
    Http,
}

/// Which control path to use (REQUIRED — no auto-detect):
///  - `Ipad` — relative-mouse target: curve-one-shot mover + the cascade
///    detector.
///  - `Desktop` — absolute-mouse target: the legacy detect-then-move path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    Ipad,
    Desktop,
}

/// (#51) Where the HID mode comes from. Exactly one source:
///  - `Declared` — a fixed `--target` (stock PiKVM / pikvm01; no
///    /hidmode endpoint).
///  - `Endpoint` — derived from the appliance `PIKVM_HIDMODE_URL` (the
///    single source of truth; the MCP holds no copy). See ADR 0002.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HidModeSource {
    Declared { target: TargetKind },
    Endpoint,
}

/// Resolve the HID-mode source from the declared `target` and the
/// endpoint URL. Exactly one must be present: BOTH is the two-copies
/// defect #51 kills (they can disagree at runtime); NEITHER leaves no
/// source. Returns `Err(message)` for the caller to print + exit — kept
/// pure so it is unit-testable.
pub fn resolve_hid_mode_source(
    target: Option<TargetKind>,
    hid_mode_url: Option<&str>,
) -> Result<HidModeSource, String> {
    let url_set = hid_mode_url.is_some_and(|u| !u.trim().is_empty());
    if url_set && target.is_some() {
        return Err(
            "--target and PIKVM_HIDMODE_URL are mutually exclusive: the appliance /hidmode endpoint is the \
             single source of truth for the HID mode, so a declared --target would be a second copy that can \
             disagree at runtime. Set exactly one."
                .to_string(),
        );
    }
    if !url_set && target.is_none() {
        return Err(
            "A HID-mode source is required — pass --target ipad|desktop (declared; stock PiKVM / pikvm01) OR \
             set PIKVM_HIDMODE_URL to derive the mode from the appliance /hidmode endpoint."
                .to_string(),
        );
    }
    Ok(if url_set {
        HidModeSource::Endpoint
    } else {
        HidModeSource::Declared {
            target: target.expect("checked above: target is Some when url is unset"),
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecurityChoice {
    Yes,
    No,
    Kvmd,
}

#[derive(Debug, Clone)]
pub struct CliOptions {
    pub transport: TransportKind,
    pub host: String,
    pub port: u16,
    /// `None` when neither --target nor PIKVM_TARGET was given; main()
    /// then errors.
    pub target: Option<TargetKind>,
    /// http-mode auth switch (flag > PIKVM_MCP_SECURITY). REQUIRED in
    /// http mode — `None` here makes main() error rather than silently
    /// pick a default.
    pub security: Option<SecurityChoice>,
    /// Username for the MCP HTTP Basic auth (default resolved in config).
    pub auth_username: Option<String>,
    /// Literal auth password from the flag (prefer
    /// --auth-password-file / env for secrets).
    pub auth_password: Option<String>,
    /// Path to a file holding the auth password.
    pub auth_password_file: Option<String>,
    /// Opt-in (default false): also expose an in-band `login` MCP tool
    /// so a client can authenticate its session without an Authorization
    /// header. Only meaningful with --security yes|kvmd. Flag >
    /// PIKVM_MCP_ALLOW_TOOL_LOGIN.
    pub allow_tool_login: bool,
    pub help: bool,
}

pub const DEFAULT_HTTP_HOST: &str = "127.0.0.1";
pub const DEFAULT_HTTP_PORT: u16 = 3000;

/// A single `--flag value` / `--flag` (boolean) command-line argument.
enum ParsedFlag {
    WithValue(String),
    Boolean,
}

/// Hand-rolled strict flag scanner: `--name value` for string-valued
/// flags, bare `--name` for boolean flags, `-h` as `--help`'s short
/// form. Rejects unknown flags (matches `node:util`'s `parseArgs`
/// `strict: true`).
fn scan_flags(argv: &[String]) -> Result<HashMap<String, ParsedFlag>, String> {
    const STRING_FLAGS: &[&str] = &[
        "transport",
        "host",
        "port",
        "target",
        "security",
        "auth-username",
        "auth-password",
        "auth-password-file",
    ];
    const BOOL_FLAGS: &[&str] = &["http", "allow-tool-login", "help"];

    let mut out = HashMap::new();
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        let name = if arg == "-h" {
            "help"
        } else if let Some(n) = arg.strip_prefix("--") {
            n
        } else {
            return Err(format!("Unrecognized argument \"{arg}\""));
        };

        if BOOL_FLAGS.contains(&name) {
            out.insert(name.to_string(), ParsedFlag::Boolean);
            i += 1;
        } else if STRING_FLAGS.contains(&name) {
            let value = argv
                .get(i + 1)
                .ok_or_else(|| format!("Option \"--{name}\" requires a value"))?;
            out.insert(name.to_string(), ParsedFlag::WithValue(value.clone()));
            i += 2;
        } else {
            return Err(format!("Unrecognized option \"--{name}\""));
        }
    }
    Ok(out)
}

fn flag_str(flags: &HashMap<String, ParsedFlag>, name: &str) -> Option<String> {
    match flags.get(name) {
        Some(ParsedFlag::WithValue(v)) => Some(v.clone()),
        _ => None,
    }
}

fn flag_bool(flags: &HashMap<String, ParsedFlag>, name: &str) -> bool {
    matches!(flags.get(name), Some(ParsedFlag::Boolean))
}

pub fn parse_cli_options(
    argv: &[String],
    env: &HashMap<String, String>,
) -> Result<CliOptions, String> {
    let flags = scan_flags(argv)?;

    let transport_raw = if flag_bool(&flags, "http") {
        Some("http".to_string())
    } else {
        flag_str(&flags, "transport")
    }
    .or_else(|| env.get("PIKVM_MCP_TRANSPORT").cloned())
    .unwrap_or_else(|| "stdio".to_string());
    let transport = match transport_raw.as_str() {
        "stdio" => TransportKind::Stdio,
        "http" => TransportKind::Http,
        other => {
            return Err(format!(
                "Invalid --transport \"{other}\" (expected \"stdio\" or \"http\")"
            ))
        }
    };

    let host = flag_str(&flags, "host")
        .or_else(|| env.get("PIKVM_MCP_HOST").cloned())
        .unwrap_or_else(|| DEFAULT_HTTP_HOST.to_string());

    let port_raw = flag_str(&flags, "port")
        .or_else(|| env.get("PIKVM_MCP_PORT").cloned())
        .unwrap_or_else(|| DEFAULT_HTTP_PORT.to_string());
    let port: u16 = port_raw
        .parse::<i64>()
        .ok()
        .filter(|p| *p >= 1 && *p <= 65535)
        .map(|p| p as u16)
        .ok_or_else(|| format!("Invalid --port \"{port_raw}\" (expected an integer 1-65535)"))?;

    // Optional (a HID-mode source is enforced in main so --help works
    // without it). An empty value (blank flag or PIKVM_TARGET="") is
    // treated as UNSET — consistent with how an empty PIKVM_HIDMODE_URL
    // is unset — so it falls through to the source-required check rather
    // than a confusing "invalid target" (#51).
    let target_raw = flag_str(&flags, "target")
        .or_else(|| env.get("PIKVM_TARGET").cloned())
        .filter(|s| !s.is_empty());
    let target = match target_raw.as_deref() {
        None => None,
        Some("ipad") => Some(TargetKind::Ipad),
        Some("desktop") => Some(TargetKind::Desktop),
        Some(other) => {
            return Err(format!(
                "Invalid --target \"{other}\" (expected \"ipad\" or \"desktop\")"
            ))
        }
    };

    let security_raw =
        flag_str(&flags, "security").or_else(|| env.get("PIKVM_MCP_SECURITY").cloned());
    let security = match security_raw.as_deref() {
        None => None,
        Some("yes") => Some(SecurityChoice::Yes),
        Some("no") => Some(SecurityChoice::No),
        Some("kvmd") => Some(SecurityChoice::Kvmd),
        Some(other) => {
            return Err(format!(
                "Invalid --security \"{other}\" (expected \"yes\", \"no\", or \"kvmd\")"
            ))
        }
    };

    // Opt-in in-band login tool (flag > env). Env is truthy on "true"/"1".
    let allow_tool_login_env = matches!(
        env.get("PIKVM_MCP_ALLOW_TOOL_LOGIN").map(String::as_str),
        Some("true") | Some("1")
    );
    let allow_tool_login = if flags.contains_key("allow-tool-login") {
        flag_bool(&flags, "allow-tool-login")
    } else {
        allow_tool_login_env
    };

    Ok(CliOptions {
        transport,
        host,
        port,
        target,
        security,
        auth_username: flag_str(&flags, "auth-username")
            .or_else(|| env.get("PIKVM_MCP_AUTH_USERNAME").cloned()),
        auth_password: flag_str(&flags, "auth-password"),
        auth_password_file: flag_str(&flags, "auth-password-file"),
        allow_tool_login,
        help: flag_bool(&flags, "help"),
    })
}

pub fn help_text(bin_name: &str) -> String {
    [
        format!("{bin_name} — MCP server for controlling remote machines via PiKVM"),
        String::new(),
        "Usage:".to_string(),
        format!("  {bin_name} [options]"),
        String::new(),
        "Options:".to_string(),
        "  --transport <stdio|http>     Transport to serve on (default: stdio)".to_string(),
        "  --http                       Shorthand for --transport http".to_string(),
        "  --host <addr>                HTTP bind address (default: 127.0.0.1)".to_string(),
        "  --port <n>                   HTTP port (default: 3000)".to_string(),
        "  --target <ipad|desktop>      Control path (REQUIRED):".to_string(),
        "                                 ipad    = curve-one-shot mover + cascade detector".to_string(),
        "                                 desktop = legacy detect-then-move (absolute mouse)".to_string(),
        "  --security <yes|no|kvmd>     REQUIRED in http mode. yes = require auth on /mcp".to_string(),
        "                               against a static credential; kvmd = clients log in with".to_string(),
        "                               their PiKVM (kvmd) username/password;".to_string(),
        "                                 no = serve /mcp with NO auth (anyone who can reach".to_string(),
        "                                 the port controls the machine).".to_string(),
        "  --auth-username <name>       Username for http auth (default: operator).".to_string(),
        "  --auth-password <pw>         Password for http auth (prefer the file/env forms).".to_string(),
        "  --auth-password-file <path>  Read the http auth password from a file.".to_string(),
        "  --allow-tool-login           Also expose an in-band `login` MCP tool so a client can".to_string(),
        "                               authenticate its session without an Authorization header.".to_string(),
        "                               Opt-in (default off); only meaningful with --security yes|kvmd.".to_string(),
        "                               A pre-auth session may connect but can call ONLY `login`".to_string(),
        "                               until it authenticates. The header path stays recommended.".to_string(),
        "  -h, --help                   Show this help and exit".to_string(),
        String::new(),
        "Environment (used when the matching flag is absent):".to_string(),
        "  PIKVM_MCP_TRANSPORT, PIKVM_MCP_HOST, PIKVM_MCP_PORT, PIKVM_TARGET".to_string(),
        "  PIKVM_MCP_SECURITY           yes|no|kvmd".to_string(),
        "  PIKVM_MCP_ALLOW_TOOL_LOGIN   true|1 to enable the in-band login tool".to_string(),
        "  PIKVM_MCP_AUTH_USERNAME, PIKVM_MCP_AUTH_PASSWORD[_FILE]   http auth credentials".to_string(),
        "  PIKVM_HOST                   required to reach the PiKVM".to_string(),
        "  PIKVM_PASSWORD[_FILE]        needed only to actually drive the PiKVM device".to_string(),
        String::new(),
        "In http mode the modern Streamable HTTP transport is served at".to_string(),
        "POST/GET/DELETE /mcp, with a health check at GET /health.".to_string(),
        "With --security yes, /mcp requires HTTP Basic auth (Authorization header) on".to_string(),
        "every request; a validated initialize also authorizes its session. /health is".to_string(),
        "always open.".to_string(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests;
