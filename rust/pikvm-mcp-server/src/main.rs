//! Entry point. Currently wires only `cli`'s option parsing +
//! `resolve_hid_mode_source`'s validation — the real transport/dispatch
//! layers (`http-server.ts`/`index.ts`'s rmcp tool registry) are not yet
//! built (Module 6 in progress; see docs/rust-port-plan.md §7 item 6).
//! This binary is runnable today only as far as `--help` and CLI/HID-
//! mode-source validation; it exits with a clear "not yet implemented"
//! message past that point rather than silently pretending to serve.

use pikvm_mcp_server::cli::{help_text, parse_cli_options, resolve_hid_mode_source};
use std::collections::HashMap;

fn main() {
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

    eprintln!(
        "pikvm-mcp-server: CLI/HID-mode-source validation passed (transport={:?}). \
         The MCP tool registry/dispatch (index.ts/http-server.ts) is not yet ported — \
         nothing to serve yet.",
        options.transport
    );
    std::process::exit(1);
}
