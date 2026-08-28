//! Shared iPad-adjacent primitives that both module 4 (mover/HID
//! orchestration) and module 5 (iPad-specific/HID recovery) depend on,
//! rather than depending on each other.
//!
//! See `docs/rust-port-plan.md` §7 and `docs/adr/0002-rust-port-full-bigbang.md`.
//!
//! `click_verify` (this crate's only module so far): the two pure
//! default-lookup functions, ported now since they only need `foundation`.
//! `emit_chunked` (`src/pikvm/gesture.ts`) and `take_raw_screenshot`
//! (`src/pikvm/ballistics.ts`) are deferred until module 2's kvmd-client
//! crate exists — both take the concrete client type directly, not an
//! injected closure, per the TS source (checked, not assumed).

pub mod click_verify;
