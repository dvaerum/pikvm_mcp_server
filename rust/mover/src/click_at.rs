//! `pikvm_mouse_click_at`'s core orchestration. Faithful port of
//! `src/pikvm/click-at.ts`'s `clickAt()`: move-then-verify-then-click,
//! with three safety gates (brightness, cursor-verified, correct-element
//! residual) that can each abort the click before it fires.
//!
//! `click_at()` returns a `ClickAtOutcome` — the caller (the MCP tool
//! handler, in `pikvm-mcp-server`) owns arg-parsing and rendering
//! `ClickAtOutcome` into a `CallToolResult`; this module owns the actual
//! decision logic and HID/screenshot orchestration. `outcome`'s message
//! field is the complete, final human-readable text for each outcome,
//! including capture-advisory lines (M8) — present on every outcome, not
//! just success (matching the TS source's own F12 fix, which closed the
//! one gap where `brightness-abort` used to omit them).

use std::sync::Arc;

use pikvm_mcp_detection_vision::brightness::{
    analyze_brightness, AnalyzeBrightnessOptions, Region as BrightnessRegion,
};
use pikvm_mcp_detection_vision::capture::{
    begin_capture, CaptureClient, CaptureConfig, CaptureSaved,
};
use pikvm_mcp_detection_vision::orientation::{ipad_content_region_from_buffer, DetectOptions};
use pikvm_mcp_ipad_hid::hid_mode::HidPolicy;
use pikvm_mcp_kvmd_client::client::{MouseButton, PiKVMClient};

use crate::ballistics::BallisticsProfile;
use crate::click_verify::{
    bias_corrected_aim_point, is_screen_too_dim_for_cursor_detection, residual_for_skip,
    verify_click_by_diff, ClickVerifyOptions, Region as VerifyRegion,
    RegionRect as VerifyRegionRect,
};
use crate::move_to::{move_to_pixel, MoveStrategy, MoveToOptions, MoveToResult, Point};
use crate::scale_learner::{record_move_sample, Axis, ScaleLearner};

pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// `move_to_pixel`'s call shape as an injectable dependency. TS's own
/// `click-at.test.ts` mocks `moveToPixel` entirely to test `clickAt`'s
/// gate logic (brightness/cursor-verified/residual/drift-bug-invariant)
/// in isolation from the mover's internals, which have their own
/// extensive coverage elsewhere — this port needs the same seam to test
/// the same way, matching the DI pattern already established for
/// `CursorLocatorDeps`/`CurveOneShotDeps`.
pub type MoveToPixelFn = Arc<
    dyn Fn(
            Arc<PiKVMClient>,
            Point,
            MoveToOptions,
        ) -> BoxFuture<'static, anyhow::Result<MoveToResult>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct ClickAtDeps {
    pub move_to_pixel: MoveToPixelFn,
}

impl Default for ClickAtDeps {
    fn default() -> Self {
        Self {
            move_to_pixel: Arc::new(|client, target, options| {
                Box::pin(async move { move_to_pixel(&client, target, options).await })
            }),
        }
    }
}

pub struct ClickAtRequest<'a> {
    pub client: Arc<PiKVMClient>,
    /// `None` means the dispatch preamble's mover gate would have refused
    /// this call already (unknown/settling HID mode) — `click_at` reports
    /// `ModeUnknown` rather than assuming a caller-side guarantee.
    pub policy: Option<HidPolicy>,
    pub target: Point,
    pub button: MouseButton,
    /// Explicit strategy override. `None` -> `policy.strategy`.
    pub strategy: Option<MoveStrategy>,
    pub assume_cursor_at: Option<Point>,
    pub profile: Option<BallisticsProfile>,
    pub verify_click: bool,
    pub verify_settle_ms: u64,
    pub verify_region_half_px: Option<f64>,
    pub verify_min_change_fraction: Option<f64>,
    pub expect_region: Option<VerifyRegionRect>,
    /// Retained only for its brightness-gate default + advisory note — the
    /// old "force maxRetries=0" effect is universal now (retry removed).
    pub single_tap: bool,
    /// Escape hatch: click at the predicted position even when the cursor
    /// can't be localized. Never a silent success — the outcome is always
    /// reported unverified.
    pub force: bool,
    /// Explicit override. `None` -> `policy.dim_threshold`-equivalent on
    /// iPad, 0 for `single_tap`, else the policy default.
    pub min_brightness: Option<f64>,
    /// Explicit override. `None` -> `policy.max_residual_px`.
    pub max_residual_px: Option<f64>,
    pub capture: Option<CaptureConfig>,
    /// The MCP server's shared learner instance (#41, opt-in). Not a
    /// process-wide singleton in this port (unlike TS's module-level
    /// `scaleLearner`) — the real shared-state wiring lives in
    /// `pikvm-mcp-server`'s `SharedState`, borrowed in here. A borrowed
    /// reference (not `Arc<Mutex<_>>`) so the caller's real, shared
    /// learner is read from and written back to directly — an owned
    /// clone would silently lose whatever `record_move_sample` does
    /// inside this call.
    pub scale_learner: &'a std::sync::Mutex<ScaleLearner>,
}

pub enum ClickAtOutcome {
    ModeUnknown {
        message: String,
    },
    /// Not one of TS's original discriminants — TS's `clickAt` has no
    /// explicit try/catch around `moveToPixel`/`client.mouseClick`, so an
    /// error there propagates as a thrown exception to `clickAt`'s own
    /// caller. This port's `click_at` returns a `ClickAtOutcome` rather
    /// than a `Result`, so those same failures surface here instead of
    /// panicking — rendered the same way as `ModeUnknown`/
    /// `BrightnessAbort` (text + isError:true), matching TS's own
    /// render-side handling for both of those.
    Error {
        message: String,
    },
    BrightnessAbort {
        message: String,
        mean: f64,
        threshold: f64,
    },
    CursorUnverified {
        message: String,
        screenshot: Vec<u8>,
        captured: Vec<Option<CaptureSaved>>,
    },
    ResidualSkip {
        message: String,
        residual_px: f64,
        max_residual_px: f64,
        screenshot: Vec<u8>,
        captured: Vec<Option<CaptureSaved>>,
    },
    Clicked {
        message: String,
        /// True when `force: true` fired the click at a predicted
        /// position the cursor could not be localized to confirm.
        forced_unverified: bool,
        screenshot: Vec<u8>,
        captured: Vec<Option<CaptureSaved>>,
    },
}

fn capture_client(client: &Arc<PiKVMClient>) -> CaptureClient {
    let screenshot_client = client.clone();
    let alive_client = client.clone();
    CaptureClient {
        screenshot: Arc::new(move || {
            let client = screenshot_client.clone();
            Box::pin(async move { Ok(client.screenshot(None).await?.buffer) })
        }),
        screenshot_keeping_cursor_alive: Some(Arc::new(move || {
            let client = alive_client.clone();
            Box::pin(async move { Ok(client.screenshot_keeping_cursor_alive(None).await?.buffer) })
        })),
    }
}

fn button_name(b: MouseButton) -> &'static str {
    match b {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
        MouseButton::Up => "up",
        MouseButton::Down => "down",
    }
}

/// Faithful port of `clickAt()`.
pub async fn click_at(req: ClickAtRequest<'_>, deps: ClickAtDeps) -> ClickAtOutcome {
    // ADR-0002 Phase 1: the dispatch preamble's mover gate already refuses
    // the call if the mode is unknown/settling before click_at is ever
    // reached in production — checked here too (not asserted) so a future
    // dispatch-gate change can't silently let a null policy reach the
    // mover.
    let Some(policy) = req.policy else {
        return ClickAtOutcome::ModeUnknown {
            message: "Error: HID mode unknown or settling — refusing to click.".to_string(),
        };
    };

    let client = req.client.clone();
    let target = req.target;
    let button = req.button;
    let mut session = begin_capture(capture_client(&client), req.capture.clone());
    session.before().await;

    let strategy = req
        .strategy
        .unwrap_or(move_strategy_from_policy(policy.strategy));
    let single_tap = req.single_tap;
    let force = req.force;
    // Phase 38/v0.5.26: explicit override mirrors the auto-policy:
    // policy.dim_threshold on iPad targets, 0 elsewhere. M6: single_tap
    // defaults to 0 too — a dimmed PIN-sheet modal must not false-abort a
    // deliberate keypad tap (still overridable explicitly).
    let min_brightness = req.min_brightness.unwrap_or(if single_tap {
        0.0
    } else {
        policy.dim_threshold
    });

    // Phase 136/156: iPad targets get chunkPaceMs=100ms open-loop default;
    // desktop uses the mover's own default.
    let chunk_pace = policy.chunk_pace_ms;
    // Computed ONCE, here, so the SAME value both (a) threads into the
    // mover — which derives its correction gate strictly below it — and
    // (b) drives the post-move skip check below. Computing it in two
    // places was the hole that let the mover's correction gate drift
    // above the clicker's acceptance gate, stranding residuals in the gap
    // (fixed by 95ec05f in curve-mover.ts; this single-computation
    // invariant is what keeps it fixed).
    let effective_max_residual_px = req.max_residual_px.or(policy.max_residual_px);
    // task #38: on iPad the tap lands ~5.9px ABOVE the detected pointer,
    // so aim the pointer that much LOWER to land the tap on the requested
    // target. The move AND the residual gate use this aim (cursor-near-
    // aim <=> tap-near-target); the verify region stays on the original
    // target, where the tap's UI effect actually appears. Desktop/
    // absolute clicks by coordinates -> no offset.
    let aim_point = if policy.apply_tap_bias {
        bias_corrected_aim_point(target)
    } else {
        target
    };
    // (#41) capture the scale actually in force so the post-move sample
    // is recorded against it.
    let (learn_scale_x, learn_scale_y) = {
        let learner = req.scale_learner.lock().unwrap();
        (
            learner.current_scale(Axis::X),
            learner.current_scale(Axis::Y),
        )
    };

    let move_opts = MoveToOptions {
        strategy: Some(strategy),
        assume_cursor_at: req.assume_cursor_at,
        profile: req.profile.clone(),
        accept_gate_px: effective_max_residual_px,
        curve_scale_x: Some(learn_scale_x),
        curve_scale_y: Some(learn_scale_y),
        forbid_slam_fallback: policy.forbid_slam_fallback,
        // Desktop full-frame degrade: the Phase-32 slam guard exists ONLY
        // to avoid the iPadOS hot-corner re-lock, so it must be disarmed
        // in absolute/desktop mode — otherwise a blank/uniform desktop
        // frame false-aborts with "target type undetermined".
        forbid_slam_on_ipad: Some(policy.forbid_slam_on_ipad),
        chunk_pace_ms: chunk_pace,
        ..Default::default()
    };
    let verify_opts = ClickVerifyOptions {
        region: req.verify_region_half_px.map(|half| VerifyRegion {
            x: target.x,
            y: target.y,
            half_width: half,
            half_height: half,
        }),
        // expect_region takes precedence over the target-centered
        // `region` — verify_click_by_diff honours region_rect first.
        region_rect: req.expect_region,
        min_changed_fraction: req.verify_min_change_fraction,
        ..Default::default()
    };

    // Phase 38 brightness precheck (single-attempt path — always runs).
    // Phase 38b: scope the brightness measurement to detected iPad bounds
    // so letterbox bars don't trigger false-positive dim verdicts on a
    // bright iPad-portrait screen.
    if min_brightness > 0.0 {
        if let Ok(shot0) = client.screenshot(None).await {
            let region = ipad_content_region_from_buffer(&shot0.buffer, DetectOptions::default())
                .map(|(x, y, width, height)| BrightnessRegion {
                    x,
                    y,
                    width,
                    height,
                });
            if let Ok(brightness) =
                analyze_brightness(&shot0.buffer, AnalyzeBrightnessOptions { region })
            {
                // Phase 48 severity gate: abort ONLY on a UNIFORMLY dim
                // frame, not on any low-mean frame — a dark-but-CONTRASTY
                // modal is perfectly clickable and must pass.
                if is_screen_too_dim_for_cursor_detection(
                    brightness.mean,
                    brightness.severity,
                    min_brightness,
                ) {
                    return ClickAtOutcome::BrightnessAbort {
                        mean: brightness.mean,
                        threshold: min_brightness,
                        message: format!(
                            "Click aborted: iPad display blocked (mean brightness={:.0}/255, threshold={min_brightness}). \
                             iPad auto-brightness does NOT affect HDMI — dim HDMI means an iOS modal/security prompt is \
                             dimming the screen. Try pikvm_key Escape, Enter, or Cmd+Period to dismiss blindly; if none \
                             work, a human must dismiss the prompt physically on the iPad.{}",
                            brightness.mean,
                            session.lines(),
                        ),
                    };
                }
            }
        }
        // Precheck failure (screenshot/region/analyze all best-effort) is
        // non-fatal — fall through to the click.
    }

    // Retry removed: clicks are single-attempt. Positioning is
    // deterministic (curve-one-shot ~2-3px), faded cursors are recovered
    // by the mover's own wake mechanism, and the retry loop's only
    // remaining effect was the keypad double-fire / dismiss-escape harm.
    let result = match (deps.move_to_pixel)(client.clone(), aim_point, move_opts).await {
        Ok(r) => r,
        Err(e) => {
            // TS's moveToPixel can throw (e.g. forbidSlamFallback); clickAt
            // has no explicit catch around this call either, so the error
            // propagates to clickAt's own caller in TS. This port's
            // click_at returns a ClickAtOutcome rather than a Result, so a
            // move failure is surfaced as a synthetic ModeUnknown-shaped
            // error text instead of a panic — the caller (the MCP tool
            // handler) still gets a clear message, matching the spirit of
            // "never a silent failure" even though the shape differs from
            // TS's throw/catch.
            return ClickAtOutcome::Error {
                message: format!("Error: move_to_pixel failed: {e}"),
            };
        }
    };
    if !policy.mouse_absolute {
        let mut learner = req.scale_learner.lock().unwrap();
        record_move_sample(
            &mut learner,
            result.learn_sample,
            learn_scale_x,
            learn_scale_y,
            force,
        );
    }

    // False-success safety fix: on a relative-mouse (iPad) target a null
    // final_detected_position means the mover could NOT verify where the
    // cursor is — e.g. a fully-faded cursor makes curve-one-shot's V8
    // start-detection fail. Clicking blind taps the stale faded position,
    // not the target — unacceptable for a PIN/payment. Report NOT-LANDED
    // instead of firing. (Desktop/absolute positions by coordinates, not
    // detection, so this gate is iPad-only.) force:true is the explicit
    // escape hatch — fires the click anyway at the predicted position and
    // flags the result UNVERIFIED.
    let forced_unverified =
        !policy.mouse_absolute && result.final_detected_position.is_none() && force;
    if !policy.mouse_absolute && result.final_detected_position.is_none() && !force {
        let lines = session.lines();
        return ClickAtOutcome::CursorUnverified {
            screenshot: result.screenshot,
            message: format!(
                "{}\nClick NOT performed: the cursor position could not be verified (the pointer is likely \
                 faded/off-screen), so no {} click was sent. Wake the cursor first (a small pikvm_mouse_move) or \
                 retry once the screen is active, or pass force:true to click anyway at the predicted position \
                 (returns an UNVERIFIED result — landing not confirmed).{lines}",
                result.message,
                button_name(button),
            ),
            captured: session.entries,
        };
    }

    // Phase 88 correct-element gate: even a VERIFIED cursor can sit too
    // far from target — motion-diff can lock onto an adjacent feature,
    // and a click 50-100px off registers on the wrong element. Skip
    // rather than click the wrong thing. iPad-only (desktop positions by
    // coordinates); max_residual_px<=0/None disables the gate.
    if !policy.mouse_absolute {
        if let Some(final_pos) = result.final_detected_position {
            if let Some(max_residual_px) = effective_max_residual_px.filter(|m| *m > 0.0) {
                if let Some(skip_residual) =
                    residual_for_skip(final_pos, aim_point, Some(max_residual_px))
                {
                    let lines = session.lines();
                    return ClickAtOutcome::ResidualSkip {
                        residual_px: skip_residual,
                        max_residual_px,
                        screenshot: result.screenshot,
                        message: format!(
                            "{}\nClick NOT performed: the cursor landed {skip_residual:.1}px from target (> \
                             maxResidualPx={max_residual_px}) — clicking would risk hitting an adjacent element, so \
                             no {} click was sent. Loosen maxResidualPx if a near-target click is acceptable; if a \
                             popup may be occluding the target, run pikvm_dismiss_popup then re-click.{lines}",
                            result.message,
                            button_name(button),
                        ),
                        captured: session.entries,
                    };
                }
            }
        }
    }

    // Brief pause so iPadOS registers the cursor as stationary before click.
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    // Pre-click screenshot AFTER cursor has settled at target, so the
    // pre->post diff isolates the click's UI effect from cursor motion.
    let pre_shot = if req.verify_click {
        client.screenshot(None).await.ok()
    } else {
        None
    };
    // M8: "during" = pre-button-down cursor-alive frame, same point as
    // the predown proof-shot.
    session.during().await;
    if let Err(e) = client.mouse_click(button, None, None).await {
        return ClickAtOutcome::Error {
            message: format!("Error: mouse click failed: {e}"),
        };
    }
    // Wait for the UI to render before capturing the post-click frame.
    tokio::time::sleep(std::time::Duration::from_millis(req.verify_settle_ms)).await;
    let shot = match client.screenshot(None).await {
        Ok(s) => s,
        Err(e) => {
            return ClickAtOutcome::Error {
                message: format!("Error: post-click screenshot failed: {e}"),
            };
        }
    };
    // M8: "after" reuses the post-click frame (no extra screenshot).
    session.after(Some(shot.buffer.clone())).await;

    let mut verification_text = String::new();
    if req.verify_click {
        if let Some(pre_shot) = pre_shot {
            match verify_click_by_diff(&pre_shot.buffer, &shot.buffer, verify_opts) {
                Ok(v) => {
                    verification_text = format!(
                        "\n{}",
                        v.message(
                            verify_opts_is_scoped(req.verify_region_half_px, req.expect_region),
                            req.verify_min_change_fraction.unwrap_or(0.005),
                        )
                    );
                }
                Err(e) => {
                    verification_text = format!("\nClick verification skipped: {e}.");
                }
            }
        }
    }

    let single_tap_note = if single_tap {
        "\n(singleTap: tapped ONCE, no retry — the verification below is ADVISORY only; the tap fired regardless \
         of the reported screen change. Use this for keypads/PIN pads so a sub-threshold effect never re-taps the \
         key.)"
            .to_string()
    } else {
        String::new()
    };
    let click_line = if forced_unverified {
        format!(
            "\n\u{26A0} Clicked {} UNVERIFIED at the predicted position (force:true): the cursor could NOT be \
             localized, so the LANDING IS NOT CONFIRMED — do not treat this as a successful tap. Inspect the \
             screenshot / screenChanged below to judge whether it landed; if it didn't, wake the cursor \
             (pikvm_mouse_move) or fix HID (pikvm_usb_reconnect) and retry.",
            button_name(button)
        )
    } else {
        format!(
            "\nClicked {} at approximate position. Post-click screenshot attached.",
            button_name(button)
        )
    };

    let lines = session.lines();
    ClickAtOutcome::Clicked {
        forced_unverified,
        screenshot: shot.buffer,
        message: format!(
            "{}{click_line}{single_tap_note}{verification_text}{lines}",
            result.message
        ),
        captured: session.entries,
    }
}

fn verify_opts_is_scoped(
    verify_region_half_px: Option<f64>,
    expect_region: Option<VerifyRegionRect>,
) -> bool {
    verify_region_half_px.is_some() || expect_region.is_some()
}

/// `HidPolicy.strategy` (`hid-mode.ts`'s own 2-value `Strategy`, the
/// policy-derived DEFAULT) -> `move_to::MoveStrategy` (the full 4-value
/// enum `moveToPixel`/`clickAt` actually accept). A caller-supplied
/// `strategy` override always takes precedence over this — see
/// `click_at`'s own `req.strategy.unwrap_or(...)`. `pub` (not just
/// crate-local) because `pikvm_mouse_move_to`'s own tool handler needs
/// the identical conversion for its own `strategy` argument default.
pub fn move_strategy_from_policy(s: pikvm_mcp_ipad_hid::hid_mode::Strategy) -> MoveStrategy {
    match s {
        pikvm_mcp_ipad_hid::hid_mode::Strategy::CurveOneShot => MoveStrategy::CurveOneShot,
        pikvm_mcp_ipad_hid::hid_mode::Strategy::DetectThenMove => MoveStrategy::DetectThenMove,
    }
}

#[cfg(test)]
mod tests;
