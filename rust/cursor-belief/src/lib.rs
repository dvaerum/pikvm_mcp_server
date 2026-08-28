//! `CursorBelief`: a Kalman-style state estimator for the on-screen mouse
//! cursor. Faithful port of `src/pikvm/cursor-belief.ts` (Phase 192-A).
//!
//! Split into its own crate (not folded into module 2 or module 3) because
//! BOTH need the type directly: module 2's `PiKVMClient` holds an instance
//! (`client.belief`) and module 3's movers/locator read and write it. The
//! TS file itself is pure/deterministic/no I/O with zero imports — the
//! ideal shape for a dependency-free shared crate. See
//! `docs/rust-port-plan.md` §7's CursorBelief coupling note.
//!
//! Diagonal-only covariance — cross-axis correlation is small for iPad
//! relative-mouse and the simpler math is plenty given the observation
//! noise. Four scalars instead of a 4×4 matrix.

mod belief;

pub use belief::{
    Axes, BeliefEdges, BeliefRegion, Bounds, CursorBelief, CursorBeliefOptions, Emit,
    ObserveOptions, Point, RatioClamp, WouldRejectOptions,
};
