//! Module 2 (kvmd transport client) of the pikvm-mcp-server Rust port.
//!
//! Faithful port of `src/pikvm/{client,streamer-keepalive}.ts` and
//! `src/operator-hints.ts`. See `docs/rust-port-plan.md` §7 and
//! `docs/adr/0002-rust-port-full-bigbang.md` — this crate is
//! task_dbf947d5d878, depends on module 1 (`pikvm-mcp-foundation`).
//!
//! REST + WS transport to the PiKVM appliance — every other module calls
//! through this layer.

pub mod client;
pub mod emit_clock;
pub mod operator_hints;
pub mod streamer_keepalive;
