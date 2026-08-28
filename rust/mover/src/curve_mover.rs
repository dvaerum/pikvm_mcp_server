//! Curve-based one-shot mover.
//!
//! Validated 2026-07-20 (N=80 paired, live, vs iPadCollector getCursor,
//! realistic home scene): beats the iterative moveToPixel 80/80 — median
//! 9.1px vs 72.9px, p90 12.4 vs 154. See docs/movement-accuracy-plan.md
//! Phase 3-5 and memory project_curve_oneshot_mover.
//!
//! Why it works: the iPad emit→displacement transfer function is a
//! fixed, deterministic, isotropic nonlinear curve. mouse_move_relative
//! clamps to ±127/report; a single report's displacement follows
//! EMIT_CURVE (std 0.0), and bursts are linear (FULL_REPORT_PX per full
//! ±127 report). So we detect the cursor once (V8), invert the curve to
//! plan per-axis bursts, and land in ONE open-loop shot — no iterative
//! motion-diff correction (which is what makes the legacy path
//! oscillate / go blind on a textured background).
//!
//! CAVEAT: the curve is calibrated for the current iPad-in-HDMI geometry
//! (1920×1080 frame, this iPad's screen size/position). A future
//! calibration routine should learn it and cache in ballistics.json;
//! until then it is hardcoded from the validation session.
//!
//! Faithful port of `src/pikvm/curve-mover.ts`.
//!
//! Split into `types` (options/DI types), `curve` (the pure displacement
//! curve + its inversion + the correction-gate derivation), `wake` (the
//! faded-cursor jiggle, pure plan + client-taking apply), and `mover`
//! (the `CursorLocator` wiring, `emit_toward`, and
//! `move_by_curve_one_shot` itself, plus its tests) — idiomatic Rust
//! 2018+ module layout, one responsibility per file, built directly as
//! a submodule directory from the start.

mod curve;
mod mover;
mod types;
mod wake;

pub use curve::{
    derive_correction_gate_px, mickeys_for_report, plan_axis_emits, CORRECTION_GATE_FLOOR_PX,
    CORRECTION_GATE_FRACTION, DEFAULT_ACCEPT_GATE_PX, DEFAULT_CURVE_SCALE_Y, EMIT_CURVE_X,
    FULL_REPORT_PX, Y_SCALE,
};
pub use mover::move_by_curve_one_shot;
pub use types::{BoxFuture, CurveOneShotDeps, CurveOneShotOptions, DetectFn};
pub use wake::{plan_wake_emits, WAKE_EMIT_COUNT, WAKE_EMIT_DX, WAKE_EMIT_DY};
