//! Approximate-absolute move-to-pixel for PiKVM targets in relative
//! mouse mode (mouse.absolute=false, e.g. iPad).
//!
//! Faithful port of `src/pikvm/move-to.ts` (2711 lines, the single
//! largest file in the codebase).
//!
//! **Split under construction** — see `docs/rust-port-plan.md` §7 item 4
//! (v13, v16) for the full planned layout. Dependency gaps
//! (`find_cursor_by_v8_full_frame`/`locate_cursor`/
//! `find_cursor_by_ml_multi_hint`) found while reading the file in full
//! are now all resolved. Remaining files
//! (`correction_math`/`template_cache`/`motion_diff`/`wiggle_verify`/
//! `pointer_accel_bridge`) split to nixos-dev (2026-08-29) — `origin`
//! and `legacy_move` stay here since `discover_origin`'s result threads
//! directly into the whole correction loop.

mod origin;
mod types;

pub use types::{
    Axis, CorrectionPass, DetectionMode, MoveLearnSample, MovePassDiagnostic, MoveStrategy,
    MoveToOptions, MoveToResult, Point,
};
