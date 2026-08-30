//! Entry point. Faithful (partial) port of `src/index.ts`'s `main()`.
//!
//! Both transports are wired: stdio (Module 6 Phase A) and Streamable
//! HTTP (Phase C1/C2 — see `http_server.rs`'s own header comment for
//! what's not yet wired there: `--allow-tool-login`'s pre-auth session
//! and the `skill_*` dynamic tools).

use std::collections::HashMap;
use std::sync::Arc;

use pikvm_mcp_foundation::auth::{make_static_authorizer, HeaderAuthorizer};
use pikvm_mcp_foundation::config::{load_config, resolve_http_auth, CliAuthArgs};
use pikvm_mcp_foundation::kvmd_auth::{make_kvmd_authorizer, KvmdAuthDeps, KvmdAuthOptions};
use pikvm_mcp_ipad_hid::hid_mode::{
    make_http_hid_mode_endpoint, HidMode, HidModeHttpConfig, HidModeHttpDeps, HidModeResolver,
    HidModeResolverOpts,
};
use pikvm_mcp_kvmd_client::client::{create_default_belief, PiKVMClient, PiKVMConfig};
use pikvm_mcp_server::cli::{
    help_text, parse_cli_options, resolve_hid_mode_source, HidModeSource, SecurityChoice,
    TargetKind, TransportKind,
};
use pikvm_mcp_server::server::{PikvmAuthConfig, PikvmMcpServer, SharedState};
use rmcp::transport::stdio;
use rmcp::ServiceExt;

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let env: HashMap<String, String> = std::env::vars().collect();

    let options = match parse_cli_options(&argv, &env) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    if options.help {
        println!("{}", help_text("pikvm-mcp-server"));
        return;
    }

    let hid_mode_url = env.get("PIKVM_HIDMODE_URL").cloned();
    let hid_mode_source = match resolve_hid_mode_source(options.target, hid_mode_url.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    // In http mode the security posture is an EXPLICIT, required choice
    // (the endpoint drives real input on a physical machine). Resolve it
    // before doing any work so a misconfiguration fails fast.
    let mut static_http_auth = None;
    if options.transport == TransportKind::Http {
        let Some(security) = options.security else {
            eprintln!(
                "--security is required in http mode — pass --security yes (static credential), \
                 --security kvmd (validate clients against PiKVM/kvmd users), or --security no \
                 (serve it with NO authentication). See --help."
            );
            std::process::exit(2);
        };
        match security {
            SecurityChoice::Yes => {
                let auth_args = CliAuthArgs {
                    auth_username: options.auth_username.clone(),
                    auth_password: options.auth_password.clone(),
                    auth_password_file: options.auth_password_file.clone(),
                };
                let Some(auth) = resolve_http_auth(&env, &auth_args) else {
                    eprintln!(
                        "--security yes requires an auth password — set --auth-password, \
                         --auth-password-file, PIKVM_MCP_AUTH_PASSWORD[_FILE], or the \
                         \"pikvm-mcp-auth-password\" systemd credential."
                    );
                    std::process::exit(2);
                };
                eprintln!(
                    "HTTP auth: ENABLED (static Basic, user \"{}\").",
                    auth.username
                );
                static_http_auth = Some(auth);
            }
            SecurityChoice::Kvmd => {
                eprintln!("HTTP auth: ENABLED (kvmd-backed — clients log in with their PiKVM username/password).");
            }
            SecurityChoice::No => {
                eprintln!(
                    "⚠ HTTP auth: DISABLED (--security no). Anyone who can reach {}:{} can control the machine.",
                    options.host, options.port
                );
            }
        }
        if options.allow_tool_login && security != SecurityChoice::No {
            eprintln!(
                "Note: --allow-tool-login is ENABLED — a header-less initialize opens a pre-auth session gated \
                 to the \"login\" tool until it authenticates."
            );
        } else if options.allow_tool_login {
            eprintln!("Note: --allow-tool-login has no effect with --security no (nothing to authenticate).");
        }
    }

    // Load configuration (deferred to here for proper error handling,
    // matching index.ts's own ordering: CLI parse → HID-mode-source →
    // config).
    let config = load_config();
    let cursor_belief = create_default_belief();
    // Kept for hidModeEndpointConfig's Basic-auth fallback below (the
    // off-box front-door /hidmode deployment reuses the ALREADY-RESOLVED
    // kvmd credentials + proxy, matching index.ts's own comment on this —
    // it deliberately does NOT re-read PIKVM_USERNAME/PASSWORD/PROXY a
    // second time).
    let config_username = config.pikvm.username.clone();
    let config_password = config.pikvm.password.clone();
    let config_host = config.pikvm.host.clone();
    let config_verify_ssl = config.pikvm.verify_ssl;
    let config_proxy_url =
        (!config.pikvm.proxy_url.is_empty()).then(|| config.pikvm.proxy_url.clone());
    let client_config = PiKVMConfig {
        host: config.pikvm.host,
        username: config.pikvm.username,
        password: config.pikvm.password,
        verify_ssl: config.pikvm.verify_ssl,
        default_keymap: config.pikvm.default_keymap,
        proxy_url: config_proxy_url.clone(),
        // Default off — see docs/streamer-source-online-wake-nudge-plan.md;
        // not yet live-verified, deliberately not wired to a config/env
        // knob until that verification happens.
        source_online_wake_nudge: false,
    };
    let client = PiKVMClient::new(client_config, Some(cursor_belief));

    let auth_ok = client.check_auth().await;
    if !auth_ok {
        eprintln!("Warning: Could not authenticate with PiKVM. Check credentials.");
    }

    // (#51) HID-mode resolver: a declared --target is a fixed mode; an
    // endpoint source derives it from the appliance /hidmode (unknown
    // when unreachable — pointer ops then refuse rather than guess). See
    // ADR 0002. `pikvmCreds` reuses the ALREADY-RESOLVED kvmd credentials
    // + proxy for the off-box front-door /hidmode deployment's Basic-auth
    // fallback, matching index.ts's own `hidModeEndpointConfig`.
    let mut hid_mode_resolver = match hid_mode_source {
        HidModeSource::Declared { target } => HidModeResolver::new(HidModeResolverOpts {
            declared: Some(match target {
                TargetKind::Ipad => HidMode::Ipad,
                TargetKind::Desktop => HidMode::Desktop,
            }),
            endpoint: None,
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        }),
        HidModeSource::Endpoint => {
            let endpoint = make_http_hid_mode_endpoint(
                HidModeHttpConfig {
                    url: hid_mode_url,
                    token: env.get("PIKVM_HIDMODE_TOKEN").cloned(),
                    username: Some(config_username.clone()),
                    password: Some(config_password.clone()),
                    proxy_url: config_proxy_url.clone(),
                    verify_ssl: Some(
                        env.get("PIKVM_HIDMODE_VERIFY_SSL").map(String::as_str) == Some("true"),
                    ),
                    timeout_ms: None,
                },
                HidModeHttpDeps {
                    get: None,
                    post: None,
                },
            );
            HidModeResolver::new(HidModeResolverOpts {
                declared: None,
                endpoint: Some(endpoint),
                ttl_ms: None,
                settle_window_ms: None,
                now: None,
            })
        }
    };
    hid_mode_resolver.resolve().await;

    // (#41) EXPERIMENTAL, off by default: warm-start from persisted state
    // when opted in via PIKVM_MOVER_LEARN=1. A true no-op otherwise — see
    // load_warm_start's own doc comment for what's NOT ported yet (the
    // periodic-flush timer half).
    let env_learn_1 = env.get("PIKVM_MOVER_LEARN").map(String::as_str) == Some("1");
    let scale_learner =
        pikvm_mcp_mover::scale_learner::ScaleLearner::new(Default::default(), env_learn_1);
    let scale_learner = std::sync::Mutex::new(scale_learner);
    pikvm_mcp_server::tools::scale_learner_load_warm_start(&scale_learner).await;
    let scale_learner = scale_learner.into_inner().unwrap();

    // Load ballistics profile if present (used by pikvm_mouse_move_to,
    // currently blocked on move-to.ts — see SharedState::cached_profile's
    // own doc comment).
    let profile_path = pikvm_mcp_mover::ballistics::default_profile_path();
    let cached_profile = pikvm_mcp_mover::ballistics::load_profile(&profile_path)
        .await
        .unwrap_or(None);
    if let Some(profile) = &cached_profile {
        eprintln!(
            "Loaded ballistics profile ({} samples).",
            profile.samples.len()
        );
    }

    let shared = Arc::new(SharedState::new(
        client,
        hid_mode_resolver,
        scale_learner,
        config.calibration,
        cached_profile,
    ));

    if options.transport == TransportKind::Http {
        // Build the /mcp header authorizer now that config (the PiKVM
        // host/TLS/proxy the kvmd backend validates against) is
        // available. `None` = open (--security no).
        let authorize: Option<HeaderAuthorizer> = match options.security {
            Some(SecurityChoice::Yes) => {
                let auth =
                    static_http_auth.expect("--security yes already validated a password above");
                Some(make_static_authorizer(auth))
            }
            Some(SecurityChoice::Kvmd) => Some(make_kvmd_authorizer(
                KvmdAuthOptions {
                    host: config_host,
                    verify_ssl: config_verify_ssl,
                    proxy_url: config_proxy_url,
                    ttl_ms: None,
                },
                KvmdAuthDeps {
                    check: None,
                    now: None,
                },
            )),
            _ => None,
        };
        let auth_config = PikvmAuthConfig {
            authorize,
            allow_tool_login: options.allow_tool_login,
        };
        if let Err(e) = pikvm_mcp_server::http_server::run_http_server(
            shared,
            &options.host,
            options.port,
            auth_config,
        )
        .await
        {
            eprintln!("Fatal error: {e}");
            std::process::exit(1);
        }
        return;
    }

    let server = PikvmMcpServer::new(shared, Arc::new(PikvmAuthConfig::default()));

    eprintln!("PiKVM MCP Server running (stdio)");
    let service = match server.serve(stdio()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Fatal error: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = service.waiting().await {
        eprintln!("Fatal error: {e}");
        std::process::exit(1);
    }
}
