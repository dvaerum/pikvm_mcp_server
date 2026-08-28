//! Split into `types` (the data vocabulary: `Point`/`Emit`/`Bounds`/
//! options structs, plus the estimator's own private variance/ratio/
//! last-emit bookkeeping) and `estimator` (the `CursorBelief`
//! predict/observe state machine + its tests) — idiomatic Rust 2018+
//! module layout, one responsibility per file, rather than one file
//! mirroring the single TS source.

mod estimator;
mod types;

pub use estimator::CursorBelief;
pub use types::{
    Axes, BeliefEdges, BeliefRegion, Bounds, CursorBeliefOptions, Emit, ObserveOptions, Point,
    RatioClamp, WouldRejectOptions,
};
