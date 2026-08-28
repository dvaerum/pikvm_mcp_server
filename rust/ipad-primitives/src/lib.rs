//! Shared iPad-adjacent primitives that both module 4 (mover/HID
//! orchestration) and module 5 (iPad-specific/HID recovery) depend on,
//! rather than depending on each other.
//!
//! See `docs/rust-port-plan.md` §7 and `docs/adr/0002-rust-port-full-bigbang.md`.
//!
//! `click_verify`: the two pure default-lookup functions, ported now since
//! they only need `foundation`. `emit_chunked` (`src/pikvm/gesture.ts`) and
//! `take_raw_screenshot` (`src/pikvm/ballistics.ts`) are deferred until
//! module 2's kvmd-client crate exists — both take the concrete client type
//! directly, not an injected closure, per the TS source (checked, not
//! assumed).
//!
//! `ipad_keys` (`src/pikvm/ipad-keys.ts`): moved here from module 5's crate
//! (2026-08-28) once cursor-anchor.ts's real callers were traced —
//! ipad-unlock.ts (module 5) and cursor-anchor.ts (module 4, per its own
//! crate-placement finding) both need it, so it lives in the crate neither
//! of them has to depend on the other to reach — the exact role this
//! crate's own header already describes.

pub mod click_verify;
pub mod ipad_keys;
