//! `CursorLocator`: the per-profile detector-cascade state machine
//! that owns the `CursorBelief` instance.
//!
//! Split out of `cursor_locator.rs` (idiomatic Rust 2018+ module
//! layout — see this module's root file for why).

use crate::cursor_detect::{FindCursorOptions, LocateCursorOptions, Point};
use crate::cursor_ml_detect::{MlMultiHintOptions, V8FullFrameOptions};
use pikvm_mcp_cursor_belief::{Bounds, CursorBelief, Emit};

use super::types::{
    from_belief_point, to_belief_point, CursorFix, CursorFixSource, CursorLocatorDeps,
    LocateProfile, ProbeMeasurement,
};

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
                use_change_detection_prefilter: pikvm_mcp_foundation::settings::get_settings()
                    .ml
                    .change_detection_prefilter_enabled,
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
