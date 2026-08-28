//! THE SOLVED MOVER — do NOT change this algorithm's behavior while
//! porting it. Faithful port of `src/pikvm/curve-mover.ts`.
//!
//! STUB: only [`DEFAULT_CURVE_SCALE_Y`] is ported so far, needed by
//! [`crate::scale_learner`]. The full curve-one-shot algorithm (the
//! deterministic, isotropic, invertible emit→displacement curve) is its
//! own dedicated increment — it's the highest-risk, highest-value file in
//! this module and per `docs/rust-port-plan.md` §7 needs a real hardware
//! gate before merge, same discipline as every mover-adjacent change this
//! project has ever shipped. Don't rush it as a side effect of a smaller
//! file's dependency.

/// Y defaults to the point-in-time drift compensation; X error is
/// negligible so it defaults to 1.0 (see `scale_learner`'s `DEFAULTS`).
pub const DEFAULT_CURVE_SCALE_Y: f64 = 1.0364;
