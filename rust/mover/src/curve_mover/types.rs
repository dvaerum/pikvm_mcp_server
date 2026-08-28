//! `curve_mover`'s own option/DI types: `CurveOneShotOptions` and the
//! `detect` test-injection seam (`DetectFn`/`CurveOneShotDeps`).
//!
//! `client: Arc<PiKVMClient>` (not the plain `&PiKVMClient` most of this
//! crate's functions take) — same reasoning as `cursor_anchor.rs`'s own
//! header doc and `ballistics.rs`'s `measure_cell`: the `detect` seam is
//! a DI closure (`Arc<dyn Fn(...) -> BoxFuture<...>>`), and Rust's
//! borrow checker can't thread a bare `&PiKVMClient` reference through a
//! `'static`-boxed future's closure capture — an owned, cheap-to-clone
//! `Arc` sidesteps that entirely, matching the pattern this port already
//! uses everywhere a client needs to be captured in a stored closure.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use pikvm_mcp_kvmd_client::client::PiKVMClient;

use super::super::move_to::Point;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Detection seam — screenshot + locate the cursor. `hint`
/// (task_484bed055820, optional): when the caller already has a
/// reasonable guess (e.g. the target of an emit that was just made),
/// the cascade searches a bounded window around it first instead of the
/// whole region. Omit for cold-start detects.
pub type DetectFn = Arc<
    dyn Fn(
            Arc<PiKVMClient>,
            f64,
            Option<Point>,
        ) -> BoxFuture<'static, anyhow::Result<Option<Point>>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, Copy, Default)]
pub struct CurveOneShotOptions {
    /// ms between per-report emits (default 110 — matches the
    /// calibration pace).
    pub emit_pace_ms: Option<u64>,
    /// ms to settle after the burst before the verify screenshot
    /// (default 250).
    pub settle_ms: Option<u64>,
    /// V8 presence gate for start/verify detection (default 0.5).
    pub min_presence: Option<f64>,
    /// Run ONE correction shot (re-detect + re-shoot) only if the first
    /// shot's residual is in the PLAUSIBLE miss band
    /// (`correct_gate_px`, `correct_max_px`). `None` = DERIVED from the
    /// acceptance gate (see `accept_gate_px`) — correct iff the shot
    /// would otherwise skip. A FINITE explicit value is honored but
    /// CAPPED at the acceptance gate (a caller can't reopen the dead
    /// band). Pass `Some(f64::INFINITY)` to DISABLE the correction
    /// entirely — a pure open-loop single shot, for
    /// calibration/measurement of the raw curve error.
    pub correct_gate_px: Option<f64>,
    /// Upper bound of the correction band (default 80px). A residual
    /// above this after a deterministic emit is a V8 false-positive,
    /// not a real miss — trust the first shot rather than let the
    /// correction shove a good landing away.
    pub correct_max_px: Option<f64>,
    /// Per-axis curve scale for the current geometry. `curve_scale_x`
    /// defaults to 1 (X error negligible); `curve_scale_y` defaults to
    /// `DEFAULT_CURVE_SCALE_Y` (the point-in-time Y drift compensation).
    pub curve_scale_x: Option<f64>,
    pub curve_scale_y: Option<f64>,
    /// The caller's acceptance gate (`maxResidualPx`). The mover
    /// DERIVES its correction gate strictly below this (see
    /// `derive_correction_gate_px`) so a residual in the
    /// [correct_gate, accept) band is re-shot instead of silently
    /// skipped. Threaded from the click_at handler; defaults to
    /// `DEFAULT_ACCEPT_GATE_PX` when absent (move_to).
    pub accept_gate_px: Option<f64>,
}

/// Test-only injection seam for [`move_by_curve_one_shot`](super::mover::move_by_curve_one_shot):
/// a scriptable detector that keeps unit tests off onnxruntime. Defaults
/// to the real V8 detect.
#[derive(Default, Clone)]
pub struct CurveOneShotDeps {
    pub detect: Option<DetectFn>,
}
