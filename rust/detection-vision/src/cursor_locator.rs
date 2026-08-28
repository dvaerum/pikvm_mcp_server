//! `CursorLocator` — one front door for "where is the cursor?".
//!
//! Faithful port of `src/pikvm/cursor-locator.ts`. Each named profile
//! reproduces the target call site's detector cascade call-for-call, same
//! order, same thresholds:
//!   - `Origin` — move-to.ts's `discoverOrigin`.
//!   - `OpenLoopShape` — move-to.ts's `tryOpenLoopShapeDetect`.
//!   - `Curve` — curve-mover.ts's `detect`.
//!
//! Design decisions (already settled with the repo owner — see the TS
//! source's doc comment and docs/adr/0003-cursor-locator-is-the-front-door.md):
//!  - A: the locator OWNS the `CursorBelief` instance.
//!  - B: named profiles, NOT one merged cascade.
//!  - C: `CursorFix` carries provenance + HONEST confidence — never a
//!    normalised or fabricated score.
//!
//! Every detector / device / verify function each profile calls is INJECTED
//! via `CursorLocatorDeps` (closures, matching this port's established DI
//! convention — module 1's `HeaderAuthorizer`, module 5's
//! `HidRecoveryClient`, `SeedTemplateClient`, `CaptureClient`) so unit tests
//! can substitute stubs and assert exact call order, and so this crate
//! doesn't need a `PiKVMClient`/kvmd-client dependency to compile or test.

use crate::cursor_detect::{
    CursorTemplate, DecodedScreenshot, FindCursorOptions, FindCursorSetResult, LocateCursorOptions,
    LocateCursorResult, Point,
};
use crate::cursor_ml_detect::MlCursorResult;
use pikvm_mcp_cursor_belief::{Bounds, CursorBelief, Emit, Point as BeliefPoint};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

fn to_belief_point(p: Point) -> BeliefPoint {
    BeliefPoint { x: p.x, y: p.y }
}

fn from_belief_point(p: BeliefPoint) -> Point {
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

/// The native shape returned by `find_cursor_by_v8_full_frame` (the
/// dual-head cascade).
#[derive(Clone, Copy, Debug)]
pub struct V8Detection {
    pub x: f64,
    pub y: f64,
    pub presence: f64,
    pub heatmap_peak: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct V8FullFrameOptions {
    pub min_presence: Option<f64>,
    pub hint: Option<Point>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MlMultiHintOptions {
    pub min_confidence: Option<f64>,
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

/// curve-mover.ts:91 detect() V8 presence gate (moveByCurveOneShot default).
const CURVE_MIN_PRESENCE: f64 = 0.5;

pub struct CursorLocator {
    deps: CursorLocatorDeps,
}

impl CursorLocator {
    pub fn new(deps: CursorLocatorDeps) -> Self {
        Self { deps }
    }

    /// The owned belief (candidate 5).
    pub fn belief(&self) -> &CursorBelief {
        &self.deps.belief
    }

    /// Locate the cursor via the named profile. `frame`/`w`/`h` are the
    /// CURRENT frame the caller already holds; profiles that must probe or
    /// wake-nudge take their own fresh screenshots (via `deps.screenshot`)
    /// exactly as the current code does. Returns `None` when every stage in
    /// the profile's cascade fails — the caller keeps its own fallback
    /// (slam / skip); that is NOT the locator's job.
    pub async fn locate(
        &self,
        frame: Vec<u8>,
        w: u32,
        h: u32,
        profile: LocateProfile,
        hint: Option<Point>,
        min_presence: Option<f64>,
    ) -> anyhow::Result<Option<CursorFix>> {
        match profile {
            LocateProfile::Origin => self.locate_origin().await,
            LocateProfile::OpenLoopShape => self.locate_open_loop_shape(frame, hint).await,
            LocateProfile::Curve => self.locate_curve(frame, w, h, min_presence, hint).await,
        }
    }

    /// Feed a fix forward into the belief.
    pub fn observe(&mut self, fix: &CursorFix) {
        // motion-diff / template / shape have no calibrated confidence
        // (None); the belief needs a positive gain, so treat those as
        // full-weight (1.0). ML passes its real sigmoid through unchanged.
        self.deps.belief.observe(
            to_belief_point(fix.position),
            fix.confidence.unwrap_or(1.0),
            None,
        );
    }

    pub fn reset(&mut self, at: Point) {
        self.deps.belief.reset(to_belief_point(at), None);
    }

    pub fn set_bounds(&mut self, b: Option<Bounds>) {
        self.deps.belief.bounds = b;
    }

    /// Passthrough to belief.predict — candidate-5 belief eviction (Phase 2)
    /// needs the emit side-effect to still happen at the caller's chosen
    /// point.
    pub fn predict(&mut self, emit: Emit) {
        self.deps.belief.predict(emit, None);
    }

    // -------------------------------------------------------------------
    // Profiles — each mirrors its current site call-for-call, same thresholds.
    // -------------------------------------------------------------------

    /// discoverOrigin (move-to.ts:864): V8 (ML-gated) -> motion-diff probe ->
    /// template-set progressive wake. Slam/bounds are the caller's, not ours.
    async fn locate_origin(&self) -> anyhow::Result<Option<CursorFix>> {
        let d = &self.deps;

        // 1. V8 full-frame (dual-head cascade) — gated by settings.ml.disabled.
        if !(d.is_ml_disabled)() {
            let shot = (d.screenshot)().await?;
            let v8 = (d.find_cursor_by_v8_full_frame)(
                shot.buffer.clone(),
                shot.width,
                shot.height,
                V8FullFrameOptions::default(),
            )
            .await?;
            if let Some(v8) = v8 {
                return Ok(Some(CursorFix {
                    position: Point { x: v8.x, y: v8.y },
                    source: CursorFixSource::Cascade,
                    raw_score: v8.presence,
                    confidence: Some(v8.presence),
                    probe_measurement: None,
                }));
            }
        }

        // 2. motion-diff (probe-and-diff) — PRIMARY origin path when V8 declines.
        //    Carries probe_measurement so moveToPixel can skip a redundant calibration.
        let located = (d.locate_cursor)(LocateCursorOptions {
            max_attempts: Some(2),
            ..Default::default()
        })
        .await?;
        if let Some(located) = located {
            return Ok(Some(CursorFix {
                position: located.position,
                source: CursorFixSource::MotionDiff,
                raw_score: 0.0,
                confidence: None,
                probe_measurement: Some(ProbeMeasurement {
                    offset_px: located.probe_offset_px,
                    mickeys: located.probe_mickeys,
                }),
            }));
        }

        // 3. template-set progressive wake — 3 net-zero nudges (30/60/100)
        //    with the matching settle (300/400/500) and minScore 0.85.
        let templates = (d.get_cached_templates)().await?;
        if !templates.is_empty() {
            let wake_attempts: [(f64, u64); 3] = [(30.0, 300), (60.0, 400), (100.0, 500)];
            for (dx, settle_ms) in wake_attempts {
                (d.mouse_move_relative)(dx, 0.0).await?;
                (d.sleep)(80).await;
                (d.mouse_move_relative)(-dx, 0.0).await?;
                (d.sleep)(settle_ms).await;
                let shot = (d.screenshot)().await?;
                let opts = FindCursorOptions {
                    min_score: Some(0.85),
                    ..Default::default()
                };
                if let Some(found) = (d.find_cursor_by_template_set)(&shot, &templates, &opts) {
                    return Ok(Some(CursorFix {
                        position: found.position,
                        source: CursorFixSource::Template,
                        raw_score: found.score,
                        confidence: None,
                        probe_measurement: None,
                    }));
                }
            }
        }

        Ok(None)
    }

    /// tryOpenLoopShapeDetect (move-to.ts:2022): ML multi-hint
    /// (wiggle-verified when suspiciously close) — the shape fallback was
    /// RETIRED (2026-07-23, see TS source: bench-shape-vs-cascade-backgrounds
    /// proved it dead+harmful on this path). Whole thing swallows errors ->
    /// None, like the original's `try {...} catch { return null; }`.
    async fn locate_open_loop_shape(
        &self,
        frame: Vec<u8>,
        hint: Option<Point>,
    ) -> anyhow::Result<Option<CursorFix>> {
        let predicted = match hint {
            Some(h) => h,
            None => anyhow::bail!(
                "cursor-locator: 'openLoopShape' profile requires a hint (the predicted target)"
            ),
        };
        let d = &self.deps;

        let attempt: anyhow::Result<Option<CursorFix>> = async {
            let shot = (d.decode)(frame).await?;

            // ML PRIMARY: multi-hint crop detector at minConfidence 0.5.
            let belief_pos = Some(from_belief_point(d.belief.position));
            let hints =
                (d.build_ml_hints)(predicted, shot.width as f64, shot.height as f64, belief_pos);
            let ml = (d.find_cursor_by_ml_multi_hint)(
                shot.buffer.clone(),
                shot.width,
                shot.height,
                hints,
                MlMultiHintOptions {
                    min_confidence: Some(0.5),
                },
            )
            .await?;
            if let Some(ml) = ml {
                let ml_prox = ((ml.x - predicted.x).powi(2) + (ml.y - predicted.y).powi(2)).sqrt();
                // find_cursor_by_ml_multi_hint returns crop (0,0) when its
                // FULL-FRAME v9-bordered cascade fired (hint-INDEPENDENT); a
                // non-zero crop means the crop-near-hint fallback fired. The
                // tautology wiggle-verify exists to reject hint-echo FPs —
                // but a full-frame-cascade landing near the hint is a
                // GENUINE near-target hit, not an echo, so wiggle-verifying
                // it only risks false-rejecting a correct detection. Skip
                // the guard for full-frame-cascade detections; keep it for
                // crop-based ones, which genuinely can be tautologies.
                let from_full_frame_cascade = ml.crop_left == 0.0 && ml.crop_top == 0.0;
                let verified = if ml_prox <= d.tautology_prox_threshold && !from_full_frame_cascade
                {
                    (d.ml_wiggle_verify)(ml).await?
                } else {
                    Some(ml)
                };
                if let Some(verified) = verified {
                    return Ok(Some(CursorFix {
                        position: Point {
                            x: verified.x,
                            y: verified.y,
                        },
                        source: CursorFixSource::Ml,
                        raw_score: verified.confidence,
                        confidence: Some(verified.confidence),
                        probe_measurement: None,
                    }));
                }
                // wiggle rejected the ML detection -> no fix.
            }

            Ok(None)
        }
        .await;

        Ok(attempt.unwrap_or(None))
    }

    /// curve-mover.ts detect(): V8 full-frame on the given frame.
    /// curve-mover's detect() is parameterised by minPresence
    /// (caller-overridable via moveToPixel -> moveByCurveOneShot); the
    /// caller threads it so the reroute stays byte-identical. Defaults to
    /// `CURVE_MIN_PRESENCE` (0.5) when omitted. `hint` (task_484bed055820,
    /// optional) lets the cascade search a bounded window around a
    /// known/expected position first instead of scanning the whole region
    /// on every call; omit for genuine cold-start detects.
    async fn locate_curve(
        &self,
        frame: Vec<u8>,
        w: u32,
        h: u32,
        min_presence: Option<f64>,
        hint: Option<Point>,
    ) -> anyhow::Result<Option<CursorFix>> {
        let min_presence = min_presence.unwrap_or(CURVE_MIN_PRESENCE);
        let v8 = (self.deps.find_cursor_by_v8_full_frame)(
            frame,
            w,
            h,
            V8FullFrameOptions {
                min_presence: Some(min_presence),
                hint,
            },
        )
        .await?;
        Ok(v8.map(|v8| CursorFix {
            position: Point { x: v8.x, y: v8.y },
            source: CursorFixSource::Cascade,
            raw_score: v8.presence,
            confidence: Some(v8.presence),
            probe_measurement: None,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_cursor_belief::CursorBeliefOptions;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn fake_shot() -> DecodedScreenshot {
        DecodedScreenshot {
            buffer: vec![0xff],
            rgb: vec![0u8; 3],
            width: 200,
            height: 100,
        }
    }

    fn fake_belief() -> CursorBelief {
        CursorBelief::new(CursorBeliefOptions::new(BeliefPoint { x: 111.0, y: 222.0 }))
    }

    fn v8(x: f64, y: f64, presence: f64) -> V8Detection {
        V8Detection {
            x,
            y,
            presence,
            heatmap_peak: presence,
        }
    }

    fn frame() -> Vec<u8> {
        vec![0x01, 0x02]
    }

    /// A full deps object where everything is a stub; each stub is a no-op
    /// / null by default so a test overrides only the collaborators it
    /// cares about.
    fn make_deps() -> CursorLocatorDeps {
        CursorLocatorDeps {
            belief: fake_belief(),
            screenshot: Arc::new(|| Box::pin(async { Ok(fake_shot()) })),
            decode: Arc::new(|_frame| Box::pin(async { Ok(fake_shot()) })),
            mouse_move_relative: Arc::new(|_dx, _dy| Box::pin(async { Ok(()) })),
            sleep: Arc::new(|_ms| Box::pin(async {})),
            get_cached_templates: Arc::new(|| Box::pin(async { Ok(Vec::new()) })),
            is_ml_disabled: Arc::new(|| false),
            find_cursor_by_v8_full_frame: Arc::new(|_frame, _w, _h, _opts| {
                Box::pin(async { Ok(None) })
            }),
            locate_cursor: Arc::new(|_opts| Box::pin(async { Ok(None) })),
            find_cursor_by_template_set: Arc::new(|_shot, _templates, _opts| None),
            find_cursor_by_ml_multi_hint: Arc::new(|_frame, _w, _h, _hints, _opts| {
                Box::pin(async { Ok(None) })
            }),
            build_ml_hints: Arc::new(|predicted, _fw, _fh, _belief| vec![predicted]),
            ml_wiggle_verify: Arc::new(|_ml| Box::pin(async { Ok(None) })),
            tautology_prox_threshold: 30.0,
        }
    }

    // --- origin -------------------------------------------------------------

    #[tokio::test]
    async fn origin_returns_the_v8_cascade_fix_first_and_does_not_probe_motion_diff() {
        let mut deps = make_deps();
        let v8_calls = Arc::new(AtomicUsize::new(0));
        let locate_calls = Arc::new(AtomicUsize::new(0));
        let templates_calls = Arc::new(AtomicUsize::new(0));
        {
            let v8_calls = v8_calls.clone();
            deps.find_cursor_by_v8_full_frame = Arc::new(move |_f, _w, _h, _o| {
                v8_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Some(v8(50.0, 60.0, 0.87))) })
            });
        }
        {
            let locate_calls = locate_calls.clone();
            deps.locate_cursor = Arc::new(move |_o| {
                locate_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(None) })
            });
        }
        {
            let templates_calls = templates_calls.clone();
            deps.get_cached_templates = Arc::new(move || {
                templates_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Vec::new()) })
            });
        }
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(fix.position.x, 50.0);
        assert_eq!(fix.position.y, 60.0);
        assert_eq!(fix.source, CursorFixSource::Cascade);
        assert_eq!(fix.raw_score, 0.87);
        assert_eq!(fix.confidence, Some(0.87));
        assert_eq!(v8_calls.load(Ordering::SeqCst), 1);
        assert_eq!(locate_calls.load(Ordering::SeqCst), 0);
        assert_eq!(templates_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn origin_skips_v8_entirely_when_ml_is_disabled_and_falls_to_motion_diff() {
        let mut deps = make_deps();
        deps.is_ml_disabled = Arc::new(|| true);
        let v8_calls = Arc::new(AtomicUsize::new(0));
        {
            let v8_calls = v8_calls.clone();
            deps.find_cursor_by_v8_full_frame = Arc::new(move |_f, _w, _h, _o| {
                v8_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Some(v8(1.0, 2.0, 0.9))) })
            });
        }
        deps.locate_cursor = Arc::new(|_o| {
            Box::pin(async {
                Ok(Some(LocateCursorResult {
                    position: Point { x: 7.0, y: 8.0 },
                    pre_position: Point { x: 0.0, y: 0.0 },
                    probe_offset_px: Point { x: 42.0, y: 0.0 },
                    probe_mickeys: Point { x: 60.0, y: 0.0 },
                    cluster_count: 2,
                }))
            })
        });
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
            .await
            .unwrap();

        assert_eq!(v8_calls.load(Ordering::SeqCst), 0);
        assert_eq!(fix.unwrap().source, CursorFixSource::MotionDiff);
    }

    #[tokio::test]
    async fn origin_carries_probe_measurement_and_null_confidence_when_motion_diff_wins() {
        let mut deps = make_deps();
        deps.locate_cursor = Arc::new(|_o| {
            Box::pin(async {
                Ok(Some(LocateCursorResult {
                    position: Point { x: 7.0, y: 8.0 },
                    pre_position: Point { x: 0.0, y: 0.0 },
                    probe_offset_px: Point { x: 42.0, y: 0.0 },
                    probe_mickeys: Point { x: 60.0, y: 0.0 },
                    cluster_count: 3,
                }))
            })
        });
        let templates_calls = Arc::new(AtomicUsize::new(0));
        {
            let templates_calls = templates_calls.clone();
            deps.get_cached_templates = Arc::new(move || {
                templates_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Vec::new()) })
            });
        }
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(fix.position.x, 7.0);
        assert_eq!(fix.position.y, 8.0);
        assert_eq!(fix.source, CursorFixSource::MotionDiff);
        assert_eq!(fix.raw_score, 0.0);
        assert!(fix.confidence.is_none());
        let pm = fix.probe_measurement.unwrap();
        assert_eq!((pm.offset_px.x, pm.offset_px.y), (42.0, 0.0));
        assert_eq!((pm.mickeys.x, pm.mickeys.y), (60.0, 0.0));
        assert_eq!(templates_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn origin_falls_to_the_template_set_progressive_wake_and_wins_on_the_2nd_nudge() {
        let mut deps = make_deps();
        deps.get_cached_templates = Arc::new(|| {
            Box::pin(async {
                Ok(vec![CursorTemplate {
                    rgb: Vec::new(),
                    width: 1,
                    height: 1,
                    hotspot: None,
                }])
            })
        });
        let call_count = Arc::new(AtomicUsize::new(0));
        let min_scores = Arc::new(Mutex::new(Vec::new()));
        {
            let call_count = call_count.clone();
            let min_scores = min_scores.clone();
            deps.find_cursor_by_template_set = Arc::new(move |_shot, _templates, opts| {
                min_scores.lock().unwrap().push(opts.min_score);
                let n = call_count.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    None
                } else {
                    Some(FindCursorSetResult {
                        position: Point { x: 3.0, y: 4.0 },
                        score: 0.91,
                        template_index: 0,
                    })
                }
            });
        }
        let moves = Arc::new(Mutex::new(Vec::new()));
        {
            let moves = moves.clone();
            deps.mouse_move_relative = Arc::new(move |dx, dy| {
                moves.lock().unwrap().push((dx, dy));
                Box::pin(async { Ok(()) })
            });
        }
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(fix.position.x, 3.0);
        assert_eq!(fix.position.y, 4.0);
        assert_eq!(fix.source, CursorFixSource::Template);
        assert_eq!(fix.raw_score, 0.91);
        assert!(fix.confidence.is_none());
        // exactly two wake cycles ran (30 fwd/back, then 60 fwd/back) -> 4 nudges.
        assert_eq!(
            *moves.lock().unwrap(),
            vec![(30.0, 0.0), (-30.0, 0.0), (60.0, 0.0), (-60.0, 0.0)]
        );
        assert_eq!(call_count.load(Ordering::SeqCst), 2);
        for min_score in min_scores.lock().unwrap().iter() {
            assert_eq!(*min_score, Some(0.85));
        }
    }

    #[tokio::test]
    async fn origin_returns_none_when_all_three_origin_stages_fail() {
        let mut deps = make_deps();
        deps.get_cached_templates = Arc::new(|| {
            Box::pin(async {
                Ok(vec![CursorTemplate {
                    rgb: Vec::new(),
                    width: 1,
                    height: 1,
                    hotspot: None,
                }])
            })
        });
        let call_count = Arc::new(AtomicUsize::new(0));
        {
            let call_count = call_count.clone();
            deps.find_cursor_by_template_set = Arc::new(move |_shot, _templates, _opts| {
                call_count.fetch_add(1, Ordering::SeqCst);
                None
            });
        }
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(frame(), 200, 100, LocateProfile::Origin, None, None)
            .await
            .unwrap();

        assert!(fix.is_none());
        // all three nudge cycles exhausted.
        assert_eq!(call_count.load(Ordering::SeqCst), 3);
    }

    // --- openLoopShape --------------------------------------------------------

    fn hint() -> Point {
        Point { x: 500.0, y: 400.0 }
    }

    #[tokio::test]
    async fn open_loop_shape_returns_the_ml_fix_and_skips_shape_when_prox_is_far() {
        let mut deps = make_deps();
        let ml_calls = Arc::new(Mutex::new(Vec::new()));
        {
            let ml_calls = ml_calls.clone();
            deps.find_cursor_by_ml_multi_hint = Arc::new(move |_f, _w, _h, _hints, opts| {
                ml_calls.lock().unwrap().push(opts.min_confidence);
                Box::pin(async {
                    Ok(Some(MlCursorResult {
                        x: 700.0,
                        y: 600.0,
                        confidence: 0.97,
                        crop_left: 0.0,
                        crop_top: 0.0,
                    }))
                })
            });
        }
        let hints_calls = Arc::new(AtomicUsize::new(0));
        {
            let hints_calls = hints_calls.clone();
            deps.build_ml_hints = Arc::new(move |predicted, _fw, _fh, _belief| {
                hints_calls.fetch_add(1, Ordering::SeqCst);
                vec![predicted]
            });
        }
        let wiggle_calls = Arc::new(AtomicUsize::new(0));
        {
            let wiggle_calls = wiggle_calls.clone();
            deps.ml_wiggle_verify = Arc::new(move |_ml| {
                wiggle_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(None) })
            });
        }
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(
                frame(),
                200,
                100,
                LocateProfile::OpenLoopShape,
                Some(hint()),
                None,
            )
            .await
            .unwrap()
            .unwrap();

        assert_eq!((fix.position.x, fix.position.y), (700.0, 600.0));
        assert_eq!(fix.source, CursorFixSource::Ml);
        assert_eq!(fix.raw_score, 0.97);
        assert_eq!(fix.confidence, Some(0.97));
        assert_eq!(hints_calls.load(Ordering::SeqCst), 1);
        assert_eq!(wiggle_calls.load(Ordering::SeqCst), 0);
        assert_eq!(ml_calls.lock().unwrap()[0], Some(0.5));
    }

    #[tokio::test]
    async fn open_loop_shape_wiggle_verifies_a_suspiciously_close_crop_based_ml_detection_and_accepts_it(
    ) {
        let mut deps = make_deps();
        deps.find_cursor_by_ml_multi_hint = Arc::new(|_f, _w, _h, _hints, _opts| {
            Box::pin(async {
                Ok(Some(MlCursorResult {
                    x: 500.0,
                    y: 400.0,
                    confidence: 0.8,
                    crop_left: 120.0,
                    crop_top: 80.0,
                }))
            })
        });
        let wiggle_calls = Arc::new(AtomicUsize::new(0));
        {
            let wiggle_calls = wiggle_calls.clone();
            deps.ml_wiggle_verify = Arc::new(move |ml| {
                wiggle_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move { Ok(Some(ml)) })
            });
        }
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(
                frame(),
                200,
                100,
                LocateProfile::OpenLoopShape,
                Some(hint()),
                None,
            )
            .await
            .unwrap();

        assert_eq!(wiggle_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fix.unwrap().source, CursorFixSource::Ml);
    }

    #[tokio::test]
    async fn open_loop_shape_skips_wiggle_verify_for_a_full_frame_cascade_detection_near_the_hint()
    {
        // find_cursor_by_ml_multi_hint returns crop (0,0) when its hint-
        // INDEPENDENT full-frame cascade fired, so a near-hint landing is
        // genuine, not a tautology — accept it directly WITHOUT wiggle-verify.
        let mut deps = make_deps();
        deps.find_cursor_by_ml_multi_hint = Arc::new(|_f, _w, _h, _hints, _opts| {
            Box::pin(async {
                Ok(Some(MlCursorResult {
                    x: 500.0,
                    y: 400.0,
                    confidence: 0.8,
                    crop_left: 0.0,
                    crop_top: 0.0,
                }))
            })
        });
        // Would REJECT if called — must NOT be called.
        deps.ml_wiggle_verify = Arc::new(|_ml| Box::pin(async { Ok(None) }));
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(
                frame(),
                200,
                100,
                LocateProfile::OpenLoopShape,
                Some(hint()),
                None,
            )
            .await
            .unwrap()
            .unwrap();

        assert_eq!((fix.position.x, fix.position.y), (500.0, 400.0));
        assert_eq!(fix.source, CursorFixSource::Ml);
        assert_eq!(fix.raw_score, 0.8);
        assert_eq!(fix.confidence, Some(0.8));
    }

    #[tokio::test]
    async fn open_loop_shape_returns_none_when_a_crop_based_ml_detection_is_wiggle_rejected() {
        let mut deps = make_deps();
        deps.find_cursor_by_ml_multi_hint = Arc::new(|_f, _w, _h, _hints, _opts| {
            Box::pin(async {
                Ok(Some(MlCursorResult {
                    x: 500.0,
                    y: 400.0,
                    confidence: 0.7,
                    crop_left: 120.0,
                    crop_top: 80.0,
                }))
            })
        });
        deps.ml_wiggle_verify = Arc::new(|_ml| Box::pin(async { Ok(None) }));
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(
                frame(),
                200,
                100,
                LocateProfile::OpenLoopShape,
                Some(hint()),
                None,
            )
            .await
            .unwrap();

        assert!(fix.is_none());
    }

    #[tokio::test]
    async fn open_loop_shape_returns_none_when_ml_finds_nothing() {
        let deps = make_deps(); // find_cursor_by_ml_multi_hint defaults to None
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(
                frame(),
                200,
                100,
                LocateProfile::OpenLoopShape,
                Some(hint()),
                None,
            )
            .await
            .unwrap();

        assert!(fix.is_none());
    }

    #[tokio::test]
    async fn open_loop_shape_requires_a_hint() {
        let loc = CursorLocator::new(make_deps());
        let err = loc
            .locate(frame(), 200, 100, LocateProfile::OpenLoopShape, None, None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("hint"));
    }

    // --- curve ----------------------------------------------------------------

    #[tokio::test]
    async fn curve_returns_the_v8_cascade_fix_from_the_passed_frame_at_min_presence_0_5() {
        let mut deps = make_deps();
        let calls = Arc::new(Mutex::new(Vec::new()));
        {
            let calls = calls.clone();
            deps.find_cursor_by_v8_full_frame = Arc::new(move |f, w, h, opts| {
                calls.lock().unwrap().push((f, w, h, opts.min_presence));
                Box::pin(async { Ok(Some(v8(12.0, 34.0, 0.66))) })
            });
        }
        let loc = CursorLocator::new(deps);

        let fix = loc
            .locate(frame(), 640, 480, LocateProfile::Curve, None, None)
            .await
            .unwrap()
            .unwrap();

        assert_eq!((fix.position.x, fix.position.y), (12.0, 34.0));
        assert_eq!(fix.source, CursorFixSource::Cascade);
        assert_eq!(fix.raw_score, 0.66);
        assert_eq!(fix.confidence, Some(0.66));
        let call = &calls.lock().unwrap()[0];
        assert_eq!(call.0, frame());
        assert_eq!((call.1, call.2, call.3), (640, 480, Some(0.5)));
    }

    #[tokio::test]
    async fn curve_returns_none_when_v8_declines() {
        let loc = CursorLocator::new(make_deps());
        let fix = loc
            .locate(frame(), 640, 480, LocateProfile::Curve, None, None)
            .await
            .unwrap();
        assert!(fix.is_none());
    }

    // --- belief wiring ----------------------------------------------------------

    #[test]
    fn observe_forwards_position_to_belief_and_updates_real_state() {
        // Kalman-blends with the prior rather than snapping exactly to the
        // measurement (real CursorBelief math, not a mock) — assert it
        // moved decisively toward (5, 6) from the (111, 222) prior, not
        // that it landed exactly on the measurement.
        let mut loc = CursorLocator::new(make_deps());
        let before = loc.belief().position;
        loc.observe(&CursorFix {
            position: Point { x: 5.0, y: 6.0 },
            source: CursorFixSource::Ml,
            raw_score: 0.9,
            confidence: Some(0.9),
            probe_measurement: None,
        });
        let after = loc.belief().position;
        assert!(after.x < before.x);
        assert!(after.y < before.y);
    }

    #[test]
    fn observe_uses_full_weight_when_confidence_is_none() {
        // Full weight (confidence=1) should snap the belief close to the
        // measurement even from a far-off prior, unlike a low-confidence
        // observation which would only nudge it partway.
        let mut loc = CursorLocator::new(make_deps());
        loc.observe(&CursorFix {
            position: Point { x: 5.0, y: 6.0 },
            source: CursorFixSource::MotionDiff,
            raw_score: 0.0,
            confidence: None,
            probe_measurement: None,
        });
        // Started at (111, 222); a full-weight observe should move it
        // decisively toward (5, 6), not leave it near the prior.
        assert!(loc.belief().position.x < 60.0);
        assert!(loc.belief().position.y < 120.0);
    }

    #[test]
    fn reset_forwards_to_belief_reset() {
        let mut loc = CursorLocator::new(make_deps());
        loc.reset(Point { x: 9.0, y: 9.0 });
        assert_eq!(loc.belief().position, BeliefPoint { x: 9.0, y: 9.0 });
    }

    #[test]
    fn set_bounds_sets_belief_bounds() {
        let mut loc = CursorLocator::new(make_deps());
        let bounds = Bounds {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        };

        loc.set_bounds(Some(bounds));
        assert_eq!(loc.belief().bounds, Some(bounds));

        loc.set_bounds(None);
        assert!(loc.belief().bounds.is_none());
    }

    #[test]
    fn predict_passes_through_to_belief_predict() {
        let mut loc = CursorLocator::new(make_deps());
        let before = loc.belief().position;
        loc.predict(Emit { dx: 7.0, dy: -3.0 });
        // predict() moves the belief's position by emit * ratio (real
        // CursorBelief math, not a mock) — just assert it actually moved.
        assert_ne!(loc.belief().position, before);
    }
}
