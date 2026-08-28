//! Approximate-absolute move-to-pixel for PiKVM targets in relative
//! mouse mode (mouse.absolute=false, e.g. iPad).
//!
//! Faithful port of `src/pikvm/move-to.ts` (2711 lines, the single
//! largest file in the codebase).
//!
//! **Split under construction** — see `docs/rust-port-plan.md` §7 item 4
//! (v13) for the full planned layout and the real dependency-gap
//! findings (`find_cursor_by_v8_full_frame` now built; `locate_cursor`/
//! `find_cursor_by_ml_multi_hint` still pending) discovered while
//! reading the file in full before writing any of this.

mod types;

pub use types::{
    Axis, CorrectionPass, DetectionMode, MoveLearnSample, MovePassDiagnostic, MoveStrategy,
    MoveToOptions, MoveToResult, Point,
};
