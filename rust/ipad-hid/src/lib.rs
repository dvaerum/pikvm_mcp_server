//! Module 5 (iPad-specific / HID recovery) of the pikvm-mcp-server Rust port.
//!
//! Faithful port of `src/pikvm/{hid-recovery,hid-diagnosis,hid-mode,
//! hid-latch-*,ipad-*,health-check,desktop-e2e-metrics}.ts` and
//! `src/hid-latch-monitor-main.ts`. See `docs/rust-port-plan.md` and
//! `docs/adr/0002-rust-port-full-bigbang.md` — this crate is
//! task_4719c8794fbd.
//!
//! Depends on module 1 (`pikvm-mcp-foundation`), module 3
//! (`pikvm-mcp-detection-vision`, for brightness.rs's VERY_DIM_THRESHOLD),
//! and `pikvm-mcp-ipad-primitives` (click-verify defaults, and — as of
//! the cursor-anchor.ts crate-placement finding — `ipad_keys`); independent
//! of module 4 (mover/HID orchestration) per the import-graph verification
//! in the plan's review.
//!
//! `ipad-keys.ts`'s port moved to `pikvm-mcp-ipad-primitives::ipad_keys`
//! (2026-08-28): it was first ported here since its TS source sits
//! alongside this module's other `ipad-*.ts` files, but cursor-anchor.ts —
//! its other real caller — turned out to belong in `rust/mover` (module 4,
//! not module 3 as originally filed), which cannot depend on this crate
//! without inverting the module 4→5 dependency direction. Same
//! shared-primitive resolution as `click_verify`/`emit_chunked`/
//! `take_raw_screenshot` below it in that crate.

pub mod desktop_e2e_metrics;
pub mod hid_diagnosis;
pub mod hid_latch_local_source;
pub mod hid_latch_monitor;
pub mod hid_latch_runner;
pub mod hid_latch_ssh_source;
pub mod hid_mode;
pub mod hid_recovery;
