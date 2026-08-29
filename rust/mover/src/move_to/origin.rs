//! Origin discovery (Phase 5: wakeup nudge before template-match).
//! Faithful port of `move-to.ts`'s `makeLocatorDeps`/`discoverOrigin`.

use std::sync::Arc;

use pikvm_mcp_detection_vision::cursor_detect::{
    decode_screenshot, CursorTemplate, DecodedScreenshot, FindCursorOptions, LocateCursorOptions,
    Point as DetPoint,
};
use pikvm_mcp_detection_vision::cursor_locator::{
    CursorLocator, CursorLocatorDeps, LocateProfile, MlMultiHintOptions, ProbeMeasurement,
    V8FullFrameOptions,
};
use pikvm_mcp_detection_vision::cursor_ml_detect::{
    find_cursor_by_ml_multi_hint, find_cursor_by_v8_full_frame,
};
use pikvm_mcp_foundation::settings::get_settings;
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::ballistics::take_raw_screenshot;
use crate::cursor_anchor::{anchor_cursor, AnchorGuard, AnchorRecoveryPosture, AnchorRequest};
use crate::locate_cursor::locate_cursor;
use crate::slam::{Corner, ScreenshotMode};

use super::types::{MoveStrategy, MoveToOptions, Point};

fn from_det(p: DetPoint) -> Point {
    Point { x: p.x, y: p.y }
}

/// Phase 317 tautology threshold — `move-to.ts:692` = 30.
const TAUTOLOGY_PROX_THRESHOLD: f64 = 30.0;

/// Build `CursorLocator` deps bound to the client (C1 P3). The origin
/// profile only touches origin deps; the `openLoopShape` wiggle-verify
/// closures live in `wiggle_verify.rs` (moveToPixel's own correction
/// loop), and the second-opinion predicates live in click-verify
/// (circular import in the TS source too) — so those are throwing stubs
/// here, never reached by the origin profile.
///
/// `get_cached_templates` is a STOPGAP inline empty-cache closure —
/// `template_cache.rs` (handed to nixos-dev) owns the real
/// get_cached_templates/maybe_persist_template pair; swap this for a
/// real call once that file lands. Harmless in the meantime: an empty
/// cache just means `locate_origin`'s template-set progressive-wake
/// stage (its 3rd and last fallback, after V8 and the motion-diff probe)
/// never has anything to match against, same as a fresh process with no
/// templates captured yet.
pub(super) fn make_locator_deps(client: Arc<PiKVMClient>) -> CursorLocatorDeps {
    fn not_wired<T: Send + 'static>(
        name: &'static str,
    ) -> pikvm_mcp_detection_vision::cursor_locator::BoxFuture<'static, anyhow::Result<T>> {
        Box::pin(async move {
            anyhow::bail!("cursor-locator: '{name}' dep not wired at this call site")
        })
    }

    let belief = *client.belief.lock().unwrap();
    let client_for_screenshot = client.clone();
    let client_for_mmr = client.clone();
    let client_for_locate = client.clone();

    CursorLocatorDeps {
        belief,
        screenshot: Arc::new(move || {
            let client = client_for_screenshot.clone();
            Box::pin(async move {
                let buf = take_raw_screenshot(&client).await?;
                decode_screenshot(&buf)
            })
        }),
        decode: Arc::new(|frame| Box::pin(async move { decode_screenshot(&frame) })),
        mouse_move_relative: Arc::new(move |dx, dy| {
            let client = client_for_mmr.clone();
            Box::pin(async move { Ok(client.mouse_move_relative(dx, dy).await?) })
        }),
        sleep: Arc::new(|ms| {
            Box::pin(async move { tokio::time::sleep(std::time::Duration::from_millis(ms)).await })
        }),
        get_cached_templates: Arc::new(|| Box::pin(async { Ok(Vec::<CursorTemplate>::new()) })),
        is_ml_disabled: Arc::new(|| get_settings().ml.disabled),
        find_cursor_by_v8_full_frame: Arc::new(|buf, w, h, options: V8FullFrameOptions| {
            Box::pin(async move { find_cursor_by_v8_full_frame(&buf, w, h, options) })
        }),
        locate_cursor: Arc::new(move |opts: LocateCursorOptions| {
            let client = client_for_locate.clone();
            Box::pin(async move { locate_cursor(&client, opts).await })
        }),
        find_cursor_by_template_set: Arc::new(
            |shot: &DecodedScreenshot, templates: &[CursorTemplate], opts: &FindCursorOptions| {
                pikvm_mcp_detection_vision::cursor_detect::find_cursor_by_template_set(
                    shot, templates, opts,
                )
            },
        ),
        find_cursor_by_ml_multi_hint: Arc::new(
            |buf, w, h, hints: Vec<DetPoint>, opts: MlMultiHintOptions| {
                Box::pin(async move { find_cursor_by_ml_multi_hint(&buf, w, h, &hints, opts) })
            },
        ),
        build_ml_hints: Arc::new(|predicted, w, h, belief_pos| {
            pikvm_mcp_detection_vision::cursor_ml_detect::build_ml_hints(
                predicted, w, h, belief_pos,
            )
        }),
        ml_wiggle_verify: Arc::new(|_| not_wired("mlWiggleVerify")),
        tautology_prox_threshold: TAUTOLOGY_PROX_THRESHOLD,
    }
}

/// Result of `discover_origin`: where the cursor is, how it was found,
/// and — when origin came from the `locate_cursor` probe path — the
/// observed offset/mickeys so `moveToPixel` can use them as the
/// calibration measurement and skip a redundant separate calibration
/// probe. `None` when origin came from template-match or `assume-at`.
#[derive(Debug)]
pub(super) struct DiscoveredOrigin {
    pub point: Point,
    pub method: MoveStrategy,
    pub probe_measurement: Option<ProbeMeasurement>,
}

pub(super) async fn discover_origin(
    client: &Arc<PiKVMClient>,
    options: &MoveToOptions,
) -> anyhow::Result<DiscoveredOrigin> {
    let requested = options
        .strategy
        .unwrap_or(if options.slam_first == Some(false) {
            MoveStrategy::AssumeAt
        } else {
            MoveStrategy::DetectThenMove
        });

    if requested == MoveStrategy::AssumeAt {
        let Some(point) = options.assume_cursor_at else {
            anyhow::bail!("strategy='assume-at' requires assumeCursorAt");
        };
        return Ok(DiscoveredOrigin {
            point,
            method: MoveStrategy::AssumeAt,
            probe_measurement: None,
        });
    }

    if requested == MoveStrategy::DetectThenMove {
        // 2026-05-25 / 2026-05-28 (TS source): the ML calibration path is
        // ENABLED BY DEFAULT (cascade). C1 P3 origin: the detection
        // cascade (V8 -> motion-diff probe -> template-set progressive
        // wake) runs through CursorLocator's 'origin' profile, which
        // reproduces it call-for-call. Slam/bounds/probe-calibration stay
        // below; the profile carries probe_measurement so the emit
        // calibration is unchanged.
        let locator = CursorLocator::new(make_locator_deps(client.clone()));
        let origin_fix = locator
            .locate(Vec::new(), 0, 0, LocateProfile::Origin, None, None)
            .await?;
        if let Some(fix) = origin_fix {
            return Ok(DiscoveredOrigin {
                point: from_det(fix.position),
                method: MoveStrategy::DetectThenMove,
                probe_measurement: fix.probe_measurement,
            });
        }
        if options.verbose {
            eprintln!("[move-to] locateCursor AND template-match both failed");
        }
        if options.forbid_slam_fallback {
            anyhow::bail!(
                "moveToPixel: detect-then-move failed (motion-diff and template-match both \
                 returned no cursor) and slam fallback forbidden (forbidSlamFallback=true, set \
                 when target is iPad to avoid hot-corner re-lock). \
                 COMMON CAUSE (Phase 70 finding): iPad is on the lock screen. \
                 Lock-screen wallpaper has no cursor for the algorithm to find. \
                 Run pikvm_ipad_unlock first, then retry. \
                 Other workarounds: pass strategy=\"assume-at\" with assumeCursorAt, \
                 or use a keyboard workflow (Phase 61/62 sidebar arrow-key navigation)."
            );
        }
        if options.verbose {
            eprintln!("[move-to] detect-then-move failed; falling back to slam");
        }
    }

    // Phase 32/32a safety guard (docs/troubleshooting/ipad-safety-guards.md,
    // Layers 1/2/3) + bounds-based slam-origin discovery, both now owned
    // by cursor-anchor.ts's bounds-guard branch. forbidSlamOnIpad:false
    // isn't a rare opt-out here — hid-mode.ts's policy() sets it for
    // every real desktop/absolute-mouse target — so it maps to
    // allow_on_undetermined rather than swapping guard kinds, which
    // keeps the cache-first origin computation identical either way.
    let result = anchor_cursor(AnchorRequest {
        client: client.clone(),
        corner: Some(Corner::TopLeft),
        guard: AnchorGuard::BoundsGuard {
            allow_on_undetermined: options.forbid_slam_on_ipad == Some(false),
        },
        // ADR 0001: the wake-nudging variant — matches this module's own
        // cursor-detection screenshots. capture_verification stays
        // false: this call has never verified the slam landed, and
        // preserving that (zero new screenshots, zero new throw paths)
        // is this migration's explicit non-goal-to-change.
        screenshot: ScreenshotMode::Nudging,
        capture_verification: false,
        // Inert here (capture_verification is false, nothing is ever
        // computed to gate on) — but REQUIRED, no default, same
        // discipline as `guard`.
        recovery: AnchorRecoveryPosture::InspectOnly,
        nudge: None,
        pace_ms: options.slam_pace_ms,
        slam_origin_px: options
            .slam_origin_px
            .map(|p| (p.x.round() as i64, p.y.round() as i64)),
        verbose: options.verbose,
    })
    .await?;
    if options.verbose {
        if let Some(bounds) = &result.bounds {
            eprintln!(
                "[move-to] anchorCursor origin ({:?} bounds) -> ({},{})",
                bounds.orientation, result.origin.0, result.origin.1
            );
        }
    }
    Ok(DiscoveredOrigin {
        point: Point {
            x: result.origin.0 as f64,
            y: result.origin.1 as f64,
        },
        method: MoveStrategy::SlamThenMove,
        probe_measurement: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // `discoverOrigin`'s `detect-then-move`/slam-fallback branches have no
    // dedicated TS unit test of their own — `move-to.forbidSlam.test.ts`
    // and `move-to.forbidSlamOnIpad.test.ts` both drive `moveToPixel`
    // end-to-end (checked their real imports: both call `moveToPixel`,
    // neither calls `discoverOrigin` directly), so that coverage properly
    // belongs to `legacy_move.rs`'s own eventual test suite once it
    // exists, not duplicated here against a function it doesn't actually
    // exercise in isolation. The `assume-at` branch is the one piece
    // genuinely testable standalone (no client I/O, no CursorLocator) —
    // new ground, not a faithful port of an existing TS test.

    fn opts_with(f: impl FnOnce(&mut MoveToOptions)) -> MoveToOptions {
        let mut o = MoveToOptions::default();
        f(&mut o);
        o
    }

    #[tokio::test]
    async fn assume_at_returns_the_caller_supplied_point_without_any_detection() {
        let client = Arc::new(PiKVMClient::with_request_fn(
            pikvm_mcp_kvmd_client::client::PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
            None,
            Arc::new(|_| {
                Box::pin(async { Ok(pikvm_mcp_kvmd_client::client::ResponseBody::Empty) })
            }),
        ));
        let options = opts_with(|o| {
            o.strategy = Some(MoveStrategy::AssumeAt);
            o.assume_cursor_at = Some(Point { x: 42.0, y: 99.0 });
        });
        let result = discover_origin(&client, &options).await.unwrap();
        assert_eq!(result.point, Point { x: 42.0, y: 99.0 });
        assert_eq!(result.method, MoveStrategy::AssumeAt);
        assert!(result.probe_measurement.is_none());
    }

    #[tokio::test]
    async fn assume_at_without_assume_cursor_at_errors() {
        let client = Arc::new(PiKVMClient::with_request_fn(
            pikvm_mcp_kvmd_client::client::PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
            None,
            Arc::new(|_| {
                Box::pin(async { Ok(pikvm_mcp_kvmd_client::client::ResponseBody::Empty) })
            }),
        ));
        let options = opts_with(|o| {
            o.strategy = Some(MoveStrategy::AssumeAt);
        });
        let err = discover_origin(&client, &options).await.unwrap_err();
        assert!(err.to_string().contains("assumeCursorAt"));
    }
}
