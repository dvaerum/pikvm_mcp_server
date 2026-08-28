//! Module 1 (foundation) of the pikvm-mcp-server Rust port.
//!
//! Faithful port of `src/{config,settings,auth,session-auth,kvmd-auth}.ts`
//! and `src/pikvm/{lock,util}.ts` and `src/version.ts`. See
//! `docs/rust-port-plan.md` and `docs/adr/0002-rust-port-full-bigbang.md`
//! for the full port plan and rationale — this crate is task_39b946273448.
//!
//! No PiKVM domain logic lives here; everything else in the port depends on
//! this crate.

pub mod auth;
pub mod config;
pub mod kvmd_auth;
pub mod lock;
pub mod session_auth;
pub mod settings;
pub mod util;
pub mod version;
