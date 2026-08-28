//! Shared `CursorLocator` types: the profile/fix/detection data
//! shapes, the DI closure contracts, and the `CursorLocatorDeps`
//! injection struct itself.
//!
//! Split out of `cursor_locator.rs` (idiomatic Rust 2018+ module
//! layout — see this module's root file for why).

use crate::cursor_detect::{
    CursorTemplate, DecodedScreenshot, FindCursorOptions, FindCursorSetResult, LocateCursorOptions,
    LocateCursorResult, Point,
};
use crate::cursor_ml_detect::{
    MlCursorResult, MlMultiHintOptions, V8Detection, V8FullFrameOptions,
};
use pikvm_mcp_cursor_belief::{CursorBelief, Point as BeliefPoint};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub(super) fn to_belief_point(p: Point) -> BeliefPoint {
    BeliefPoint { x: p.x, y: p.y }
}

pub(super) fn from_belief_point(p: BeliefPoint) -> Point {
    Point { x: p.x, y: p.y }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocateProfile {
    Origin,
    OpenLoopShape,
    Curve,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorFixSource {
    Cascade,
    MotionDiff,
    Template,
    #[allow(dead_code)]
    // no live producer — shape fallback was RETIRED (see locate_open_loop_shape); kept for parity with the TS union type.
    Shape,
    Ml,
}

#[derive(Clone, Copy, Debug)]
pub struct ProbeMeasurement {
    pub offset_px: Point,
    pub mickeys: Point,
}

#[derive(Clone, Copy, Debug)]
pub struct CursorFix {
    pub position: Point,
    pub source: CursorFixSource,
    /// Native per-source score; NEVER normalised across sources. Sources
    /// that emit no native score (motion-diff) report 0.
    pub raw_score: f64,
    /// ONLY where honestly calibrated: ML sigmoid = the real value;
    /// motion-diff / template / shape = None (do NOT fabricate one).
    pub confidence: Option<f64>,
    /// Optional source-specific provenance the caller may still need (e.g.
    /// the motion-diff probe's offset + mickeys that moveToPixel uses for
    /// calibration).
    pub probe_measurement: Option<ProbeMeasurement>,
}

type ScreenshotFn =
    Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<DecodedScreenshot>> + Send + Sync>;
type DecodeFn =
    Arc<dyn Fn(Vec<u8>) -> BoxFuture<'static, anyhow::Result<DecodedScreenshot>> + Send + Sync>;
type MouseMoveRelativeFn =
    Arc<dyn Fn(f64, f64) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync>;
type SleepFn = Arc<dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync>;
type GetCachedTemplatesFn =
    Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<CursorTemplate>>> + Send + Sync>;
type IsMlDisabledFn = Arc<dyn Fn() -> bool + Send + Sync>;
type FindCursorByV8FullFrameFn = Arc<
    dyn Fn(
            Vec<u8>,
            u32,
            u32,
            V8FullFrameOptions,
        ) -> BoxFuture<'static, anyhow::Result<Option<V8Detection>>>
        + Send
        + Sync,
>;
type LocateCursorFn = Arc<
    dyn Fn(LocateCursorOptions) -> BoxFuture<'static, anyhow::Result<Option<LocateCursorResult>>>
        + Send
        + Sync,
>;
type FindCursorByTemplateSetFn = Arc<
    dyn Fn(&DecodedScreenshot, &[CursorTemplate], &FindCursorOptions) -> Option<FindCursorSetResult>
        + Send
        + Sync,
>;
type FindCursorByMlMultiHintFn = Arc<
    dyn Fn(
            Vec<u8>,
            u32,
            u32,
            Vec<Point>,
            MlMultiHintOptions,
        ) -> BoxFuture<'static, anyhow::Result<Option<MlCursorResult>>>
        + Send
        + Sync,
>;
type BuildMlHintsFn = Arc<dyn Fn(Point, f64, f64, Option<Point>) -> Vec<Point> + Send + Sync>;
type MlWiggleVerifyFn = Arc<
    dyn Fn(MlCursorResult) -> BoxFuture<'static, anyhow::Result<Option<MlCursorResult>>>
        + Send
        + Sync,
>;

/// Every collaborator each profile touches, injected so tests can stub them
/// and so the real caller (module 4/6) can bind the real implementations +
/// the client they close over.
pub struct CursorLocatorDeps {
    /// The belief this locator OWNS (candidate 5: belief moves out of PiKVMClient).
    pub belief: CursorBelief,

    /// Fresh capture + decode. `Origin` takes its OWN screenshot (probe
    /// wake-nudges), matching the current code which re-decodes a fresh
    /// frame rather than reusing a passed-in one.
    pub screenshot: ScreenshotFn,
    /// Decode a passed-in frame (`OpenLoopShape` receives an already-captured frame).
    pub decode: DecodeFn,

    /// Device nudge + settle (origin progressive-wake).
    pub mouse_move_relative: MouseMoveRelativeFn,
    pub sleep: SleepFn,

    /// Cached NCC template set (origin fallback).
    pub get_cached_templates: GetCachedTemplatesFn,

    /// `Origin` skips V8 when ML is disabled (settings.ml.disabled).
    /// Evaluated per call so a mid-session settings flip is honoured.
    pub is_ml_disabled: IsMlDisabledFn,

    // --- detectors (injected; never called directly by this module) ---
    pub find_cursor_by_v8_full_frame: FindCursorByV8FullFrameFn,
    pub locate_cursor: LocateCursorFn,
    pub find_cursor_by_template_set: FindCursorByTemplateSetFn,
    pub find_cursor_by_ml_multi_hint: FindCursorByMlMultiHintFn,
    pub build_ml_hints: BuildMlHintsFn,

    // --- openLoopShape wiggle-verify helper ---
    pub ml_wiggle_verify: MlWiggleVerifyFn,

    /// Phase 317 tautology threshold — move-to.ts:671 = 30.
    pub tautology_prox_threshold: f64,
}
