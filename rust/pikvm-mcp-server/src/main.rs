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
use pikvm_mcp_kvmd_client::client::{create_default_belief, PiKVMClient, PiKVMConfig};
use pikvm_mcp_server::cli::{help_text, parse_cli_options, resolve_hid_mode_source, TransportKind};
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
    if let Err(e) = resolve_hid_mode_source(options.target, hid_mode_url.as_deref()) {
        eprintln!("{e}");
        std::process::exit(1);
    }

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
    let client_config = PiKVMConfig {
        host: config.pikvm.host,
        username: config.pikvm.username,
        password: config.pikvm.password,
        verify_ssl: config.pikvm.verify_ssl,
        default_keymap: config.pikvm.default_keymap,
        proxy_url: (!config.pikvm.proxy_url.is_empty()).then_some(config.pikvm.proxy_url),
    };
    let client = PiKVMClient::new(client_config, Some(cursor_belief));

    let auth_ok = client.check_auth().await;
    if !auth_ok {
        eprintln!("Warning: Could not authenticate with PiKVM. Check credentials.");
    }

    let shared = Arc::new(SharedState::new(client));
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
