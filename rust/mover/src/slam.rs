//! Slam-to-corner mechanism: corner geometry + the emit loop that drives
//! the relative-mouse pointer into a screen corner, plus its optional
//! post-slam motion-verification check.
//!
//! Layering (matches cursor-anchor.ts's own header comment, once that
//! lands): this module is pure MECHANISM (corner geometry, the raw emit
//! loop, the optional motion-verification diff) — no safety guard, no
//! recovery policy. Those live one layer up, in `cursor_anchor`.
//!
//! Faithful port of `src/pikvm/slam.ts`.
//!
//! Split into `types` (the enums), `geometry` (pure corner-target math),
//! and `motion` (the async emit-loop mechanism + its tests) — idiomatic
//! Rust 2018+ module layout, one responsibility per file, rather than
//! one file mirroring the single TS source.

mod geometry;
mod motion;
mod types;

pub use geometry::{corner_target_from_bounds, corner_target_px, corner_vector};
pub use motion::{nudge_from_edge, slam_to_corner, NudgeOptions, SlamMotionCheck, SlamOptions};
pub use types::{Axis, Corner, ScreenshotMode};
