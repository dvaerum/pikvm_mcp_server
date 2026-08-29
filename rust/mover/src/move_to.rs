//! Approximate-absolute move-to-pixel for PiKVM targets in relative
//! mouse mode (mouse.absolute=false, e.g. iPad).
//!
//! Faithful port of `src/pikvm/move-to.ts` (2711 lines, the single
//! largest file in the codebase).
//!
//! **Built in parallel across two agents, reconciled via branch merge
//! (2026-08-29)** — see `docs/rust-port-plan.md` §7 item 4 (v13, v16,
//! v17) for the full planned layout. `correction_math`/`motion_diff`/
//! `template_cache`/`wiggle_verify` are nixos-dev's; `types`/`origin`/
//! `resolved_options` (and `legacy_move`, next) are georgs-mac-mini's.
//! Each nixos-dev file shipped with its own provisional stand-in for
//! `move_to::types`' shared types (documented inline in each file as
//! "independently buildable/testable now, superseded once merged") —
//! reconciled at merge time by switching each file to `super::types`'
//! real shapes; see this crate's git history for the exact diffs.
//! `pointer_accel_bridge` (the opt-in `PIKVM_USE_LEARNED_BALLISTICS`
//! path) is still pending — `legacy_move.rs` doesn't need it (v13
//! scoped it out of the initial port; off by default, gated behind a
//! model file this repo doesn't bundle).

mod correction_math;
mod motion_diff;
mod origin;
mod resolved_options;
mod template_cache;
mod types;
mod wiggle_verify;

pub use types::{
    Axis, CorrectionPass, DetectionMode, MoveLearnSample, MovePassDiagnostic, MoveStrategy,
    MoveToOptions, MoveToResult, Point,
};
