//! Entry point. Faithful (partial) port of `src/index.ts`'s `main()`.
//!
//! Phase A of the Module 6 rmcp integration (see docs/rust-port-plan.md
//! §7 item 6): the stdio transport is wired end-to-end against a
//! representative subset of `index.ts`'s 37 tools (`server.rs`/
//! `tools.rs`). The Streamable HTTP transport (`http-server.ts`: axum +
//! Basic/kvmd auth + the login gate + `skill_*` dynamic tools) is NOT yet
//! wired — `--transport http` exits with a clear "not yet implemented"
//! message rather than silently pretending to serve.

use std::collections::HashMap;
use std::sync::Arc;

use pikvm_mcp_foundation::config::load_config;
use pikvm_mcp_ipad_hid::hid_mode::{
    make_http_hid_mode_endpoint, HidMode, HidModeHttpConfig, HidModeHttpDeps, HidModeResolver,
    HidModeResolverOpts,
};
use pikvm_mcp_kvmd_client::client::{create_default_belief, PiKVMClient, PiKVMConfig};
use pikvm_mcp_server::cli::{
    help_text, parse_cli_options, resolve_hid_mode_source, HidModeSource, TargetKind, TransportKind,
};
use pikvm_mcp_server::server::{PikvmMcpServer, SharedState};
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

    if options.transport == TransportKind::Http {
        eprintln!(
            "pikvm-mcp-server: --transport http is not yet implemented (http-server.ts's axum \
             transport + auth is a later Module 6 phase — see docs/rust-port-plan.md §7 item 6). \
             Use stdio for now."
        );
        std::process::exit(1);
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
    let config_proxy_url =
        (!config.pikvm.proxy_url.is_empty()).then(|| config.pikvm.proxy_url.clone());
    let client_config = PiKVMConfig {
        host: config.pikvm.host,
        username: config.pikvm.username,
        password: config.pikvm.password,
        verify_ssl: config.pikvm.verify_ssl,
        default_keymap: config.pikvm.default_keymap,
        proxy_url: config_proxy_url.clone(),
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

    let shared = Arc::new(SharedState::new(client, hid_mode_resolver, scale_learner));
    let server = PikvmMcpServer::new(shared, None);

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
