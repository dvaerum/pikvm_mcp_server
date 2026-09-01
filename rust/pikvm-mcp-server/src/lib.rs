//! Module 6 (MCP protocol surface) of the pikvm-mcp-server Rust port.
//!
//! Faithful port of `src/{cli,http-server,index}.ts` + `src/prompts/*.ts`
//! — built LAST, on top of every other module, using `rmcp` per
//! `docs/rust-port-plan.md` §6. See that doc's §7 item 6 for scope: 37
//! real `pikvm_*` tool handlers, the `skill_*` prompt-passthrough family,
//! and the `login` tool.
//!
//! Structured as lib + bin (matching this port's own convention
//! elsewhere) so `cli`'s pure option-parsing stays unit-testable exactly
//! like the TS source's own `parseCliOptions(argv, env)` shape.

pub mod cli;
pub mod http_server;
pub mod offload;
pub mod prompts;
pub mod server;
pub mod tool_helpers;
pub mod tools;
