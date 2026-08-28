//! Module 5 (iPad-specific / HID recovery) of the pikvm-mcp-server Rust port.
//!
//! Faithful port of `src/pikvm/{hid-recovery,hid-diagnosis,hid-mode,
//! hid-latch-*,ipad-*,health-check,desktop-e2e-metrics}.ts` and
//! `src/hid-latch-monitor-main.ts`. See `docs/rust-port-plan.md` and
//! `docs/adr/0002-rust-port-full-bigbang.md` — this crate is
//! task_4719c8794fbd.
//!
//! Depends on module 1 (`pikvm-mcp-foundation`) only; independent of module 4
//! (mover/HID orchestration) per the import-graph verification in the plan's
//! review — two known exceptions (takeRawScreenshot/emitChunked/click-verify
//! defaults) are tracked separately, not yet resolved.

pub mod desktop_e2e_metrics;
pub mod hid_diagnosis;
pub mod hid_latch_monitor;
pub mod hid_latch_runner;
pub mod hid_recovery;
pub mod ipad_keys;
