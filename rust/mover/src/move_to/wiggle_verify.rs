//! Wiggle-verify helpers — extracted from `moveToPixel` so they are
//! unit-testable and callable standalone. Behaviour is identical to the
//! original nested closures; `client` and the observed px/mickey ratios
//! are explicit params instead of closure captures.
//!
//! Faithful port of `mlWiggleVerify`/`wiggleVerifyCandidate`/
//! `tryOpenLoopShapeDetect` (`src/pikvm/move-to.ts` lines 1293-1461).
//! Wraps the detection primitives ported earlier this session
//! (`find_cursor_by_ml_multi_hint`, `find_cursor_by_shape`, `CursorLocator`).
//!
//! **`try_open_loop_shape_detect`'s DI deviation from the TS source**: TS
//! builds its `CursorLocatorDeps` inline via `{...makeLocatorDeps(client),
//! decode: ..., mlWiggleVerify: ...}` — `makeLocatorDeps` is `origin.rs`'s
//! (built in parallel on a separate branch; not available to compile
//! against yet, see docs/rust-port-plan.md's move-to.ts decomposition
//! note). This function instead takes the ALREADY-CONSTRUCTED base deps
//! as a parameter and applies the same two overrides (`decode`,
//! `ml_wiggle_verify`) itself — identical composition, just with the
//! base-deps construction moved to the caller (which, once assembled,
//! passes `origin::make_locator_deps(client)`). Independently
//! buildable/testable now with a stub base-deps object, same shape
//! `cursor_locator`'s own test suite already uses.

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_detection_vision::cursor_detect::{decode_screenshot, DecodedScreenshot, Point};
use pikvm_mcp_detection_vision::cursor_locator::{
    BoxFuture, CursorLocator, CursorLocatorDeps, LocateProfile, MlMultiHintOptions,
};
use pikvm_mcp_detection_vision::cursor_ml_detect::{find_cursor_by_ml_multi_hint, MlCursorResult};
use pikvm_mcp_detection_vision::cursor_shape_detect::{find_cursor_by_shape, ShapeOptions};
use pikvm_mcp_kvmd_client::client::PiKVMClient;

const WIGGLE_SETTLE_MS: u64 = 80;
/// ~1.4 px/mickey nominal iPad ratio (Phase 192 measurement) — used only
/// when no live-observed ratio is available.
const NOMINAL_PX_PER_MICKEY: f64 = 1.4;

fn clone_decoded(s: &DecodedScreenshot) -> DecodedScreenshot {
    DecodedScreenshot {
        buffer: s.buffer.clone(),
        rgb: s.rgb.clone(),
        width: s.width,
        height: s.height,
    }
}

/// Wiggle-verify an ML detection (Phase 319): emit a small diagonal
/// wiggle and accept only if the cursor (A) appears at the expected
/// post-wiggle position AND (B) vacated the initial position — a static
/// FP satisfies neither. Returns `Some(initial)` on accept, `None` on
/// reject; never propagates an error (returns `Some(initial)` on any
/// failure, matching the TS `catch { return initial; }`). Faithful port
/// of `mlWiggleVerify`.
pub async fn ml_wiggle_verify(
    client: Arc<PiKVMClient>,
    initial: MlCursorResult,
) -> Option<MlCursorResult> {
    async fn inner(
        client: &PiKVMClient,
        initial: MlCursorResult,
    ) -> anyhow::Result<Option<MlCursorResult>> {
        let dx_mickeys = 25.0;
        let dy_mickeys = -10.0;
        let expected_post_pos = Point {
            x: (initial.x + dx_mickeys * NOMINAL_PX_PER_MICKEY).round(),
            y: (initial.y + dy_mickeys * NOMINAL_PX_PER_MICKEY).round(),
        };

        client.mouse_move_relative(dx_mickeys, dy_mickeys).await?;
        tokio::time::sleep(Duration::from_millis(WIGGLE_SETTLE_MS)).await;
        let wiggle_shot = client.screenshot(None).await?;

        // Two checks (v0.5.246): real cursor satisfies both; static FP
        // neither. A: cursor at EXPECTED post-wiggle position. B: initial
        // position now EMPTY. Both via the multi-hint detector so
        // wiggle-verify uses the same model that produced `initial`.
        let cursor_at_expected = find_cursor_by_ml_multi_hint(
            &wiggle_shot.buffer,
            wiggle_shot.screenshot_width,
            wiggle_shot.screenshot_height,
            &[expected_post_pos],
            MlMultiHintOptions {
                min_confidence: Some(0.5),
            },
        )?;
        let still_at_initial = find_cursor_by_ml_multi_hint(
            &wiggle_shot.buffer,
            wiggle_shot.screenshot_width,
            wiggle_shot.screenshot_height,
            &[Point {
                x: initial.x,
                y: initial.y,
            }],
            MlMultiHintOptions {
                min_confidence: Some(0.5),
            },
        )?;

        // Always inverse-wiggle to restore cursor near initial pos.
        client.mouse_move_relative(-dx_mickeys, -dy_mickeys).await?;
        tokio::time::sleep(Duration::from_millis(WIGGLE_SETTLE_MS)).await;

        // Check B: was the initial position vacated?
        let initial_now_empty = match &still_at_initial {
            None => true,
            Some(s) => (s.x - initial.x).hypot(s.y - initial.y) > 20.0,
        };
        if !initial_now_empty {
            // Initial still occupied -> static FP (icon didn't move).
            return Ok(None);
        }
        // Check A: did the cursor appear at the expected post-wiggle position?
        let Some(cursor_at_expected) = cursor_at_expected else {
            return Ok(None);
        };
        let offset_from_expected = (cursor_at_expected.x - expected_post_pos.x)
            .hypot(cursor_at_expected.y - expected_post_pos.y);
        if offset_from_expected > 30.0 {
            return Ok(None);
        }
        // Both checks passed — real cursor.
        Ok(Some(initial))
    }
    inner(&client, initial).await.unwrap_or(Some(initial))
}

/// Faithful port of `wiggleVerifyCandidate`'s return shape (`{ pos: {x,y} }`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WiggleVerifyResult {
    pub pos: (f64, f64),
}

/// Wiggle-verify a heuristic shape candidate (Phase 297/299): emit a
/// small diagonal wiggle; if a cursor-shaped cluster is STILL at
/// `initial_pos` afterward it's a static UI-feature FP (label text / dock
/// char) → reject; else the real cursor moved with the emit → accept.
/// Always emits the inverse wiggle. Never propagates an error — any
/// failure returns `None` (matching the TS `catch { return null; }`).
/// Faithful port of `wiggleVerifyCandidate`.
pub async fn wiggle_verify_candidate(
    client: Arc<PiKVMClient>,
    observed_ratio_x: f64,
    observed_ratio_y: f64,
    initial_pos: (f64, f64),
    _initial_score: f64,
) -> Option<WiggleVerifyResult> {
    async fn inner(
        client: &PiKVMClient,
        observed_ratio_x: f64,
        observed_ratio_y: f64,
        initial_pos: (f64, f64),
    ) -> anyhow::Result<Option<WiggleVerifyResult>> {
        let ratio_x = if observed_ratio_x > 0.0 {
            observed_ratio_x
        } else {
            NOMINAL_PX_PER_MICKEY
        };
        let ratio_y = if observed_ratio_y > 0.0 {
            observed_ratio_y
        } else {
            NOMINAL_PX_PER_MICKEY
        };
        let dx_mickeys = 25.0;
        let dy_mickeys = -10.0;
        // Computed for parity with the TS source (`expectedAfter`), which
        // itself computes-then-discards it (`void expectedAfter`) — kept
        // only as a documented no-op, not wired into any check.
        let _expected_after = (
            initial_pos.0 + dx_mickeys * ratio_x,
            initial_pos.1 + dy_mickeys * ratio_y,
        );

        client.mouse_move_relative(dx_mickeys, dy_mickeys).await?;
        tokio::time::sleep(Duration::from_millis(WIGGLE_SETTLE_MS)).await;
        let wiggle_shot_raw = client.screenshot_keeping_cursor_alive(None).await?;
        let wiggle_shot = decode_screenshot(&wiggle_shot_raw.buffer)?;

        // Key discriminator: a cursor-shaped cluster STILL at initial_pos
        // after the wiggle → static UI feature (the real cursor would
        // have moved away).
        let near = Point {
            x: initial_pos.0,
            y: initial_pos.1,
        };
        let mut still_there = find_cursor_by_shape(
            &wiggle_shot.rgb,
            wiggle_shot.width,
            wiggle_shot.height,
            &ShapeOptions {
                expected_near: Some(near),
                expected_near_radius: Some(8.0),
                ..Default::default()
            },
        );
        if still_there.map(|s| s.shape_score).unwrap_or(0.0) < 0.05 {
            let bright_still = find_cursor_by_shape(
                &wiggle_shot.rgb,
                wiggle_shot.width,
                wiggle_shot.height,
                &ShapeOptions {
                    expected_near: Some(near),
                    expected_near_radius: Some(8.0),
                    bright_threshold: Some(120),
                    ..Default::default()
                },
            );
            if let Some(bright) = bright_still {
                if still_there
                    .map(|s| bright.shape_score > s.shape_score)
                    .unwrap_or(true)
                {
                    still_there = Some(bright);
                }
            }
        }
        // Always emit the inverse wiggle before returning, to keep the
        // cursor close to initial_pos — avoids polluting the correction
        // loop with the wiggle offset.
        client.mouse_move_relative(-dx_mickeys, -dy_mickeys).await?;
        tokio::time::sleep(Duration::from_millis(WIGGLE_SETTLE_MS)).await;

        if still_there.is_some() {
            return Ok(None);
        }
        // No static cluster at initial_pos -> the candidate moved with
        // the emit -> real.
        Ok(Some(WiggleVerifyResult { pos: initial_pos }))
    }
    inner(&client, observed_ratio_x, observed_ratio_y, initial_pos)
        .await
        .unwrap_or(None)
}

/// Faithful port of `tryOpenLoopShapeDetect`'s return shape.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpenLoopShapeResult {
    pub pos: (f64, f64),
    pub score: f64,
    pub prox: f64,
}

/// Open-loop shape/ML fallback (C1 P3 openLoopShape). Thin wrapper over
/// the single `CursorLocator` front door: ML-multihint → wiggle. Never
/// propagates an error — any failure (including the locator itself
/// failing) returns `None`, matching the TS `catch { return null; }`.
/// Faithful port of `tryOpenLoopShapeDetect`; see this file's header for
/// the DI deviation (`base_deps` supplied by the caller instead of built
/// inline via `origin::make_locator_deps`).
pub async fn try_open_loop_shape_detect(
    client: Arc<PiKVMClient>,
    mut base_deps: CursorLocatorDeps,
    shot: DecodedScreenshot,
    predicted: (f64, f64),
) -> Option<OpenLoopShapeResult> {
    let shot = Arc::new(shot);

    let decode_shot = shot.clone();
    base_deps.decode = Arc::new(move |_frame: Vec<u8>| {
        let shot = decode_shot.clone();
        Box::pin(async move { Ok(clone_decoded(&shot)) })
            as BoxFuture<'static, anyhow::Result<DecodedScreenshot>>
    });
    base_deps.ml_wiggle_verify = Arc::new(move |ml: MlCursorResult| {
        let client = client.clone();
        Box::pin(async move { Ok(ml_wiggle_verify(client, ml).await) })
    });

    let locator = CursorLocator::new(base_deps);
    let predicted_point = Point {
        x: predicted.0,
        y: predicted.1,
    };
    let fix = locator
        .locate(
            shot.buffer.clone(),
            shot.width,
            shot.height,
            LocateProfile::OpenLoopShape,
            Some(predicted_point),
            None,
        )
        .await
        .unwrap_or(None)?;
    let prox = (fix.position.x - predicted.0).hypot(fix.position.y - predicted.1);
    // `fix.source` is always `Ml` on this profile per
    // `locate_open_loop_shape`'s own cascade — not surfaced in the TS
    // return shape either, so dropped here too.
    Some(OpenLoopShapeResult {
        pos: (fix.position.x, fix.position.y),
        score: fix.raw_score,
        prox,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_cursor_belief::{CursorBelief, CursorBeliefOptions, Point as BeliefPoint};
    use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};
    use std::sync::atomic::{AtomicUsize, Ordering};

    // -- try_open_loop_shape_detect: stub CursorLocatorDeps, same shape
    // -- `cursor_locator`'s own test suite uses (its `make_deps()` helper
    // -- is private to that crate, so this is a local re-derivation, not
    // -- a duplicate of exported test infra).

    fn fake_shot() -> DecodedScreenshot {
        DecodedScreenshot {
            buffer: vec![0xff],
            rgb: vec![0u8; 3],
            width: 200,
            height: 100,
        }
    }

    fn stub_deps() -> CursorLocatorDeps {
        CursorLocatorDeps {
            belief: CursorBelief::new(CursorBeliefOptions::new(BeliefPoint { x: 0.0, y: 0.0 })),
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

    fn stub_client() -> Arc<PiKVMClient> {
        let request_fn: RequestFn =
            Arc::new(|_args: RequestArgs| Box::pin(async { Ok(ResponseBody::Empty) }));
        Arc::new(PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
            None,
            request_fn,
        ))
    }

    #[tokio::test]
    async fn try_open_loop_shape_detect_returns_a_result_when_ml_multi_hint_finds_the_cursor() {
        let mut deps = stub_deps();
        deps.find_cursor_by_ml_multi_hint = Arc::new(|_f, _w, _h, _hints, _opts| {
            Box::pin(async {
                Ok(Some(MlCursorResult {
                    x: 55.0,
                    y: 65.0,
                    confidence: 0.9,
                    crop_left: 0.0,
                    crop_top: 0.0,
                }))
            })
        });
        let client = stub_client();
        let r = try_open_loop_shape_detect(client, deps, fake_shot(), (50.0, 60.0)).await;
        let r = r.expect("expected a fix from the ML multi-hint stub");
        assert_eq!(r.pos, (55.0, 65.0));
        assert_eq!(r.score, 0.9);
    }

    #[tokio::test]
    async fn try_open_loop_shape_detect_returns_none_when_every_detector_fails() {
        let deps = stub_deps(); // every detector stub returns None
        let client = stub_client();
        let r = try_open_loop_shape_detect(client, deps, fake_shot(), (50.0, 60.0)).await;
        assert!(r.is_none());
    }

    #[tokio::test]
    async fn try_open_loop_shape_detect_overrides_decode_to_return_the_passed_in_shot_regardless_of_frame_arg(
    ) {
        let decode_calls = Arc::new(AtomicUsize::new(0));
        let mut deps = stub_deps();
        {
            let decode_calls = decode_calls.clone();
            // If this were ever called, the override in
            // try_open_loop_shape_detect should have replaced it — so it
            // must NEVER fire.
            deps.decode = Arc::new(move |_frame| {
                decode_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(fake_shot()) })
            });
        }
        deps.find_cursor_by_ml_multi_hint = Arc::new(|_f, _w, _h, _hints, _opts| {
            Box::pin(async {
                Ok(Some(MlCursorResult {
                    x: 1.0,
                    y: 2.0,
                    confidence: 0.9,
                    crop_left: 0.0,
                    crop_top: 0.0,
                }))
            })
        });
        let client = stub_client();
        let _ = try_open_loop_shape_detect(client, deps, fake_shot(), (50.0, 60.0)).await;
        assert_eq!(
            decode_calls.load(Ordering::SeqCst),
            0,
            "the caller-supplied decode stub must be overridden, not called"
        );
    }

    // -- ml_wiggle_verify / wiggle_verify_candidate: only the "the
    // -- underlying client call fails" catch-all path is exercised here
    // -- without a real PiKVM/kvmd endpoint (real-endpoint behavior is
    // -- exercised end-to-end against the live binary, not unit tests).

    fn failing_client() -> Arc<PiKVMClient> {
        let request_fn: RequestFn = Arc::new(|_args: RequestArgs| {
            Box::pin(async {
                Err(pikvm_mcp_kvmd_client::client::ClientError::Other(
                    "stub failure".to_string(),
                ))
            })
        });
        Arc::new(PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
            None,
            request_fn,
        ))
    }

    #[tokio::test]
    async fn ml_wiggle_verify_returns_initial_when_the_client_call_fails() {
        let initial = MlCursorResult {
            x: 10.0,
            y: 20.0,
            confidence: 0.8,
            crop_left: 0.0,
            crop_top: 0.0,
        };
        let r = ml_wiggle_verify(failing_client(), initial).await;
        let r = r.expect("a client failure must fall back to `initial`, not None");
        assert_eq!(r.x, initial.x);
        assert_eq!(r.y, initial.y);
    }

    #[tokio::test]
    async fn wiggle_verify_candidate_returns_none_when_the_client_call_fails() {
        let r = wiggle_verify_candidate(failing_client(), 1.4, 1.4, (10.0, 20.0), 0.9).await;
        assert!(r.is_none());
    }
}
