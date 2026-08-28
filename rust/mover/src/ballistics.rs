//! Mouse ballistics measurement and profile management for relative-mouse
//! HID.
//!
//! iPadOS applies non-disableable pointer acceleration to relative USB
//! HID deltas, so 1 emitted mickey ≠ 1 moved pixel. To "click at screen
//! coordinate (x, y)" we need an empirical curve: pixels-per-mickey as a
//! function of (per-call delta magnitude, pace between calls). This
//! module:
//!
//!   1. Slams the pointer into a screen corner to establish a known
//!      origin (via `cursor_anchor::anchor_cursor`).
//!   2. Sweeps (axis × magnitude × pace × rep) and measures the pixel
//!      displacement produced by each parameter combination.
//!   3. Persists the resulting profile to disk for reuse.
//!   4. Exposes a lookup function that consumers (move-to, click-at)
//!      will use to convert a desired pixel distance into a sequence of
//!      relative deltas.
//!
//! See `docs/adr/0001-do-not-merge-cursor-detection-and-calibration-
//! sampling-lookalikes.md` and `docs/troubleshooting/ipad-safety-
//! guards.md` for the design rationale and the safety guards this
//! profile feeds into.
//!
//! Faithful port of `src/pikvm/ballistics.ts`.
//!
//! `Axis` re-exports `crate::slam::Axis` — `ballistics.ts` imports its
//! `Axis` from `slam.js` (not `scale-learner.js`) and re-exports it for
//! its own callers; this module does the same rather than duplicating a
//! third `Axis` type.
//!
//! `locateCursor` is NOT re-exported here (unlike the TS `export {
//! locateCursor };`): `cursor-detect.ts`'s client-taking half
//! (`takeRawScreenshot`/`locateCursor`) is not yet ported to
//! `pikvm-mcp-detection-vision` — see that crate's `cursor_detect.rs`
//! header comment. Ballistics's own logic never calls `locateCursor`
//! internally (the TS re-export is a pure convenience for callers), so
//! this is a real, flagged gap for a Rust caller wanting it, not a
//! silent behavior change to anything in this file.
//!
//! Split into `types` (samples/profile/option structs), `capture`
//! (ADR-0001's non-nudging screenshot), `noise` (the animated-region
//! baseline + filter), `measure` (cluster-pair selection + the
//! measurement sweep — the core mechanism, plus its tests), `lookup`
//! (median aggregation + the interpolating lookup), and `persist`
//! (profile save/load/freshness) — idiomatic Rust 2018+ module layout,
//! one responsibility per file, built directly as a submodule directory
//! rather than one file mirroring the 652-line single TS source.

mod capture;
mod lookup;
mod measure;
mod noise;
mod persist;
mod types;

pub use capture::take_raw_screenshot;
pub use lookup::lookup_px_per_mickey;
pub use measure::measure_ballistics;
pub use noise::{capture_noise_baseline, CaptureNoiseBaselineOptions};
pub use persist::{default_profile_path, load_profile, profile_is_fresh_for, save_profile};
pub use types::{
    BallisticsProfile, BallisticsSample, MeasureBallisticsOptions, MeasureBallisticsResult,
    NoiseBaseline, NoiseCentroid, Pace, PairSelectionOptions,
};

pub use crate::slam::Axis;
