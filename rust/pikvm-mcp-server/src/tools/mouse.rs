//! Faithful port of `index.ts`'s `handle_pikvm_mouse_move`/
//! `handle_pikvm_mouse_click`/`handle_pikvm_mouse_scroll`/
//! `handle_pikvm_mouse_move_to`/`handle_pikvm_mouse_click_at` +
//! `renderClickAtOutcome`.

use std::sync::Arc;

use pikvm_mcp_detection_vision::capture::{begin_capture, parse_capture_config, CaptureClient};
use pikvm_mcp_detection_vision::orientation::point_in_known_letterbox;
use pikvm_mcp_kvmd_client::client::MouseButton;
use pikvm_mcp_mover::click_at::{
    click_at, move_strategy_from_policy, ClickAtDeps, ClickAtOutcome, ClickAtRequest,
};
use pikvm_mcp_mover::click_verify::RegionRect;
use pikvm_mcp_mover::move_to::{move_to_pixel, MoveStrategy, MoveToOptions, Point};
use pikvm_mcp_mover::scale_learner::{record_move_sample, Axis};

use crate::server::SharedState;
use crate::tool_helpers::{
    require_number, validate_boolean, validate_enum, validate_number, VALID_BUTTONS,
    VALID_KEY_STATES,
};
use crate::tools::{b64, BoxFuture, ToolContent, ToolEntry, ToolOutcome};

const VALID_STRATEGIES: &[&str] = &[
    "detect-then-move",
    "slam-then-move",
    "assume-at",
    "curve-one-shot",
];

/// task_f04c3909db11 dead-zone guard: `point_in_known_letterbox`
/// (`detection-vision`'s `orientation.rs`, built on
/// `rust-port/module-3-cursor-locator-anchor`) reads the same last-good
/// bounds cache `pikvm_screenshot`'s auto-crop already maintains. A target
/// landing in the black letterbox is the near-certain signature of a
/// caller re-adding a `pikvm_screenshot` auto-crop offset that was never
/// applied (or double-applying one) — a forgotten offset is a ~600px miss
/// onto a different, possibly destructive icon, not a near-miss, and
/// nobody legitimately targets the black bar. Advisory only (prepended
/// text, never a refusal) — cache is fail-open (false) until a detection
/// has landed this process, so a cold cache never blocks a legitimate
/// first move/click.
fn dead_zone_warning(x: f64, y: f64) -> Option<&'static str> {
    point_in_known_letterbox(x, y).then_some(
        "\u{26A0} WARNING: this target falls inside the iPad's black letterbox bar, not its \
         visible content area. Nobody legitimately targets the letterbox — this usually means a \
         pikvm_screenshot autoCrop region offset was forgotten (or double-applied) when computing \
         these coordinates. pikvm_mouse_move_to/click_at always take raw HDMI-frame pixels, never \
         cropped ones.\n",
    )
}

/// Prepends `dead_zone_warning`'s text to the outcome's first content
/// block (always `Text`, per every `ToolOutcome` constructor above) when
/// present — leaves the outcome, including `is_error`, otherwise
/// unchanged.
fn with_dead_zone_warning(mut outcome: ToolOutcome, warning: Option<&'static str>) -> ToolOutcome {
    let Some(warning) = warning else {
        return outcome;
    };
    if let Some(ToolContent::Text(text)) = outcome.content.first_mut() {
        *text = format!("{warning}{text}");
    }
    outcome
}

fn strategy_from_str(s: &str) -> MoveStrategy {
    match s {
        "slam-then-move" => MoveStrategy::SlamThenMove,
        "assume-at" => MoveStrategy::AssumeAt,
        "curve-one-shot" => MoveStrategy::CurveOneShot,
        _ => MoveStrategy::DetectThenMove,
    }
}

/// M8: shared before/during/after capture schema, spread into
/// `pikvm_mouse_move`/`pikvm_mouse_move_to`/`pikvm_mouse_click_at`'s
/// input schemas.
fn capture_schema_props() -> serde_json::Value {
    serde_json::json!({
        "capture": {
            "type": "array",
            "items": {"type": "string", "enum": ["before", "during", "after"]},
            "description": "M8: advisory frame capture around this operation. Any subset of [\"before\",\"during\",\"after\"]. Omit or pass [] to disable."
        },
        "capturePrefix": {"type": "string", "description": "Path prefix for capture frames (REQUIRED when capture is non-empty)."},
        "captureRegion": {
            "type": "object",
            "description": "Optional crop { x, y, width, height } applied to every capture frame. Default = full frame.",
            "properties": {
                "x": {"type": "number"}, "y": {"type": "number"},
                "width": {"type": "number"}, "height": {"type": "number"}
            },
            "required": ["x", "y", "width", "height"]
        }
    })
}

/// Shared `strategy`/`assumeCursorAtX`/`assumeCursorAtY` schema, spread
/// into `pikvm_mouse_move_to`/`pikvm_mouse_click_at`'s input schemas.
fn strategy_schema_props() -> serde_json::Value {
    serde_json::json!({
        "strategy": {
            "type": "string",
            "enum": VALID_STRATEGIES,
            "description": "Origin-discovery + correction strategy. Default: the target's mode-derived default \
                (curve-one-shot on iPad/relative-mouse, detect-then-move on desktop/absolute)."
        },
        "assumeCursorAtX": {"type": "number", "description": "With assumeCursorAtY: strategy='assume-at' only — skip detection, trust this X."},
        "assumeCursorAtY": {"type": "number", "description": "With assumeCursorAtX: strategy='assume-at' only — skip detection, trust this Y."}
    })
}

fn merge_properties(base: serde_json::Value, extra: serde_json::Value) -> serde_json::Value {
    let mut base = base;
    if let (Some(base_props), Some(extra_props)) =
        (base["properties"].as_object_mut(), extra.as_object())
    {
        for (k, v) in extra_props {
            base_props.insert(k.clone(), v.clone());
        }
    }
    base
}

pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "pikvm_mouse_move",
            description: "Move the mouse absolute or relative, with optional M8 capture."
                .to_string(),
            input_schema: merge_properties(
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "x": {"type": "number", "description": "Target X (absolute px) or delta X (relative)."},
                        "y": {"type": "number", "description": "Target Y (absolute px) or delta Y (relative)."},
                        "relative": {"type": "boolean", "description": "When true, x/y are mickeys clamped to [-127, 127]."}
                    },
                    "required": ["x", "y"]
                }),
                capture_schema_props(),
            ),
            handler: Arc::new(|shared, args| Box::pin(mouse_move(shared, args))),
        },
        ToolEntry {
            name: "pikvm_mouse_click",
            description: "Click a mouse button, optionally moving to a position first.".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "button": {"type": "string", "enum": VALID_BUTTONS, "description": "Default left."},
                    "x": {"type": "number", "description": "Optional: move here (absolute px) before clicking."},
                    "y": {"type": "number", "description": "Optional: move here (absolute px) before clicking."},
                    "state": {"type": "string", "enum": ["press", "release", "click"], "description": "Default click."}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(mouse_click(shared, args))),
        },
        ToolEntry {
            name: "pikvm_mouse_scroll",
            description: "Scroll the mouse wheel, with optional pane-targeting pre-move."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "deltaX": {"type": "number", "description": "Horizontal scroll delta. Default 0."},
                    "deltaY": {"type": "number", "description": "Vertical scroll delta (required)."},
                    "x": {"type": "number", "description": "Optional pane-targeting X — must be given with y."},
                    "y": {"type": "number", "description": "Optional pane-targeting Y — must be given with x."}
                },
                "required": ["deltaY"]
            }),
            handler: Arc::new(|shared, args| Box::pin(mouse_scroll(shared, args))),
        },
        ToolEntry {
            name: "pikvm_mouse_move_to",
            description: "Move the pointer to a target HDMI pixel on a relative-mouse target (iPad). Default \
                strategy on iPad is curve-one-shot: one detect + one deterministic curve emit (~11px). Use \
                pikvm_mouse_click_at to move+click.".to_string(),
            input_schema: merge_properties(
                merge_properties(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "x": {"type": "number", "description": "Target X (HDMI px)."},
                            "y": {"type": "number", "description": "Target Y (HDMI px)."},
                            "slamOriginX": {"type": "number", "description": "Explicit slam-then-move origin X — opts out of the Layer-3 iPad-slam guard."},
                            "slamOriginY": {"type": "number", "description": "Explicit slam-then-move origin Y — opts out of the Layer-3 iPad-slam guard."},
                            "fallbackPxPerMickey": {"type": "number", "description": "Fallback ratio when no measured profile applies."},
                            "chunkMagnitude": {"type": "number", "description": "Per-call mickey magnitude for the open-loop emission."},
                            "chunkPaceMs": {"type": "number", "description": "Inter-call pace (ms) for the open-loop emission."},
                            "correct": {"type": "boolean", "description": "Enable closed-loop correction. Default true."},
                            "maxCorrectionPasses": {"type": "number", "description": "Max correction passes."},
                            "minResidualPx": {"type": "number", "description": "Early-exit tolerance (px)."},
                            "warmupMickeys": {"type": "number", "description": "Warmup move before screenshot A."}
                        },
                        "required": ["x", "y"]
                    }),
                    strategy_schema_props(),
                ),
                capture_schema_props(),
            ),
            handler: Arc::new(|shared, args| Box::pin(mouse_move_to(shared, args))),
        },
        ToolEntry {
            name: "pikvm_mouse_click_at",
            description: "Move to a target HDMI pixel via pikvm_mouse_move_to then click (single attempt — no \
                retry). verifyClick (default) reports whether the click changed the screen (advisory); the click \
                is skipped (reported not-landed) if the cursor cannot be verified or lands beyond maxResidualPx \
                of target; a brightness gate aborts on a dim iPad. If a click reports no change and you suspect \
                an occluding popup, run pikvm_dismiss_popup then re-click.".to_string(),
            input_schema: merge_properties(
                merge_properties(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "x": {"type": "number", "description": "Target X (HDMI px)."},
                            "y": {"type": "number", "description": "Target Y (HDMI px)."},
                            "button": {"type": "string", "enum": VALID_BUTTONS, "description": "Default left."},
                            "verifyClick": {"type": "boolean", "description": "Diff pre/post screenshots to report whether the click visibly changed the screen. Default true."},
                            "verifySettleMs": {"type": "number", "description": "Settle time (ms) before the post-click verification screenshot. Default 300."},
                            "verifyRegionHalfPx": {"type": "number", "description": "Scope click-verification to a square window around target."},
                            "verifyMinChangeFraction": {"type": "number", "description": "Minimum changed-pixel fraction for screenChanged=true."},
                            "expectRegion": {
                                "type": "object",
                                "description": "Explicit rectangular ROI (HDMI px) for click verification — takes precedence over verifyRegionHalfPx.",
                                "properties": {
                                    "x": {"type": "number"}, "y": {"type": "number"},
                                    "width": {"type": "number"}, "height": {"type": "number"}
                                },
                                "required": ["x", "y", "width", "height"]
                            },
                            "singleTap": {"type": "boolean", "description": "Tap once, no retry — use for keypads/PIN pads."},
                            "force": {"type": "boolean", "description": "Click anyway even if the cursor can't be localized. Always reported UNVERIFIED."},
                            "minBrightness": {"type": "number", "description": "Brightness-gate override (0-255). 0 disables."},
                            "maxResidualPx": {"type": "number", "description": "Correct-element gate: skip the click if the verified cursor lands farther than this from target."}
                        },
                        "required": ["x", "y"]
                    }),
                    strategy_schema_props(),
                ),
                capture_schema_props(),
            ),
            handler: Arc::new(|shared, args| Box::pin(mouse_click_at(shared, args))),
        },
    ]
}

fn capture_client(shared: &Arc<SharedState>) -> CaptureClient {
    let screenshot_client = shared.client.clone();
    let alive_client = shared.client.clone();
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

fn mouse_move(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let x = require_number(&args, "x", "x", None, None).map_err(anyhow::Error::msg)?;
        let y = require_number(&args, "y", "y", None, None).map_err(anyhow::Error::msg)?;
        let relative = validate_boolean(&args, "relative").unwrap_or(false);

        // M8: parse capture before any emit (errors on a bad request).
        let capture_config = parse_capture_config(&serde_json::Value::Object(args.clone()))?;
        let mut session = begin_capture(capture_client(&shared), capture_config);
        session.before().await;

        let mut calibration_warning = String::new();
        if relative {
            shared.client.mouse_move_relative(x, y).await?;
        } else {
            let clamped_x = x.round().max(0.0);
            let clamped_y = y.round().max(0.0);
            let calibration_invalidated = shared.client.mouse_move(clamped_x, clamped_y).await?;
            if calibration_invalidated {
                calibration_warning = "\n⚠️ Resolution changed - calibration has been cleared. Recalibrate with pikvm_auto_calibrate (preferred) or pikvm_calibrate.".to_string();
            }
        }
        session.during().await;
        session.after(None).await;

        let text = if relative {
            format!("Moved mouse by ({x}, {y})")
        } else {
            format!(
                "Moved mouse to pixel ({}, {})",
                x.round().max(0.0),
                y.round().max(0.0)
            )
        };
        Ok(ToolOutcome::text(format!(
            "{text}{calibration_warning}{}",
            session.lines()
        )))
    })
}

fn button_from_str(s: &str) -> MouseButton {
    match s {
        "right" => MouseButton::Right,
        "middle" => MouseButton::Middle,
        "up" => MouseButton::Up,
        "down" => MouseButton::Down,
        _ => MouseButton::Left,
    }
}

fn mouse_click(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let button_str = validate_enum(&args, "button", VALID_BUTTONS, "left").to_string();
        let button = button_from_str(&button_str);
        let click_x = validate_number(&args, "x", Some(0.0), None);
        let click_y = validate_number(&args, "y", Some(0.0), None);

        if let (Some(cx), Some(cy)) = (click_x, click_y) {
            shared.client.mouse_move(cx.round(), cy.round()).await?;
        }

        let state = validate_enum(&args, "state", VALID_KEY_STATES, "click");
        match state {
            "press" => shared.client.mouse_click(button, Some(true), None).await?,
            "release" => shared.client.mouse_click(button, Some(false), None).await?,
            _ => shared.client.mouse_click(button, None, None).await?,
        }

        Ok(ToolOutcome::text(format!("{button_str} click")))
    })
}

fn mouse_scroll(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let delta_y =
            require_number(&args, "deltaY", "deltaY", None, None).map_err(anyhow::Error::msg)?;
        let delta_x = validate_number(&args, "deltaX", None, None).unwrap_or(0.0);
        let tx = validate_number(&args, "x", None, None);
        let ty = validate_number(&args, "y", None, None);

        if tx.is_some() != ty.is_some() {
            return Ok(ToolOutcome::error_text(
                "Error: pass both x and y to target a pane, or neither to scroll in place.",
            ));
        }

        let mut moved_note = String::new();
        if let (Some(tx), Some(ty)) = (tx, ty) {
            // M1 fix (live-verified broken 2026-07-27): a raw absolute-
            // positioning move sent to /hid/events/send_mouse_move is
            // IGNORED by iPadOS — it treats the USB-OTG HID as a relative
            // trackpad, so the move was a no-op and the wheel fired
            // wherever the cursor already was. Route through the SAME
            // platform-aware positioning path click_at/move_to use.
            //
            // ADR-0002 Phase 1: this handler is in MODE_SENSITIVE_TOOLS,
            // so the dispatch preamble's mover gate already refused the
            // call if the mode were unknown/settling — checked here too,
            // not asserted.
            let policy = shared.hid_mode_resolver.lock().await.policy();
            let Some(policy) = policy else {
                return Ok(ToolOutcome::error_text(
                    "Error: HID mode unknown or settling — refusing to position the pointer.",
                ));
            };
            let cx = tx.round().max(0.0);
            let cy = ty.round().max(0.0);
            let cached_profile = shared.cached_profile.lock().unwrap().clone();
            move_to_pixel(
                &shared.client,
                Point { x: cx, y: cy },
                MoveToOptions {
                    strategy: Some(move_strategy_from_policy(policy.strategy)),
                    forbid_slam_fallback: policy.forbid_slam_fallback,
                    forbid_slam_on_ipad: Some(policy.forbid_slam_on_ipad),
                    mouse_absolute: policy.mouse_absolute,
                    profile: cached_profile,
                    chunk_pace_ms: policy.chunk_pace_ms,
                    ..Default::default()
                },
            )
            .await?;
            moved_note = format!(" at ({cx}, {cy})");
        }

        shared.client.mouse_scroll(delta_x, delta_y).await?;
        Ok(ToolOutcome::text(format!(
            "Scrolled ({delta_x}, {delta_y}){moved_note}"
        )))
    })
}

fn require_region(v: &serde_json::Value) -> anyhow::Result<RegionRect> {
    let obj = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("expectRegion must be an object"))?;
    let field = |name: &str| -> anyhow::Result<f64> {
        obj.get(name)
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(|| anyhow::anyhow!("expectRegion.{name} is required and must be a number"))
    };
    Ok(RegionRect {
        x: field("x")?,
        y: field("y")?,
        width: field("width")?,
        height: field("height")?,
    })
}

fn mouse_move_to(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        // ADR-0002 Phase 1: MODE_SENSITIVE_TOOLS' dispatch-level mover
        // gate already refused the call if the mode were unknown/
        // settling — policy() is non-null here in practice. Still
        // checked explicitly (not asserted) so a future gate change
        // can't silently let a null policy reach the mover.
        let policy = shared.hid_mode_resolver.lock().await.policy();
        let Some(policy) = policy else {
            return Ok(ToolOutcome::error_text(
                "Error: HID mode unknown or settling — refusing to move.",
            ));
        };

        let target_x = require_number(&args, "x", "x", None, None).map_err(anyhow::Error::msg)?;
        let target_y = require_number(&args, "y", "y", None, None).map_err(anyhow::Error::msg)?;
        let dead_zone = dead_zone_warning(target_x, target_y);

        // M8: parse+validate capture up front so a bad request errors
        // before any emit.
        let capture_config = parse_capture_config(&serde_json::Value::Object(args.clone()))?;
        let mut session = begin_capture(capture_client(&shared), capture_config);
        session.before().await;

        let strategy_str = validate_enum(
            &args,
            "strategy",
            VALID_STRATEGIES,
            match policy.strategy {
                pikvm_mcp_ipad_hid::hid_mode::Strategy::CurveOneShot => "curve-one-shot",
                pikvm_mcp_ipad_hid::hid_mode::Strategy::DetectThenMove => "detect-then-move",
            },
        );
        let strategy = strategy_from_str(strategy_str);
        let assume_x = validate_number(&args, "assumeCursorAtX", None, None);
        let assume_y = validate_number(&args, "assumeCursorAtY", None, None);
        let assume_cursor_at = match (assume_x, assume_y) {
            (Some(x), Some(y)) => Some(Point { x, y }),
            _ => None,
        };

        // (#41) apply + record the passive learner's scale (bare moves
        // are valid samples too). Captured so the sample is recorded
        // against the scale in force.
        let (learn_scale_x, learn_scale_y) = {
            let learner = shared.scale_learner.lock().unwrap();
            (
                learner.current_scale(Axis::X),
                learner.current_scale(Axis::Y),
            )
        };

        // F8 (Round 2 Phase 1): only construct slam_origin_px when the
        // caller actually supplied at least one coordinate — Layer 3
        // refuses an ambiguous slam UNLESS the caller explicitly passed
        // an origin.
        let slam_x = validate_number(&args, "slamOriginX", None, None);
        let slam_y = validate_number(&args, "slamOriginY", None, None);
        let slam_origin_px = if slam_x.is_some() || slam_y.is_some() {
            Some(Point {
                x: slam_x.unwrap_or(625.0),
                y: slam_y.unwrap_or(65.0),
            })
        } else {
            None
        };

        let cached_profile = shared.cached_profile.lock().unwrap().clone();
        let result = move_to_pixel(
            &shared.client,
            Point {
                x: target_x,
                y: target_y,
            },
            MoveToOptions {
                strategy: Some(strategy),
                assume_cursor_at,
                curve_scale_x: Some(learn_scale_x),
                curve_scale_y: Some(learn_scale_y),
                slam_origin_px,
                mouse_absolute: policy.mouse_absolute,
                fallback_px_per_mickey: validate_number(
                    &args,
                    "fallbackPxPerMickey",
                    Some(0.01),
                    Some(10.0),
                ),
                chunk_magnitude: validate_number(&args, "chunkMagnitude", Some(1.0), Some(127.0)),
                chunk_pace_ms: validate_number(&args, "chunkPaceMs", Some(0.0), Some(500.0))
                    .map(|v| v as u64),
                correct: validate_boolean(&args, "correct"),
                max_correction_passes: validate_number(
                    &args,
                    "maxCorrectionPasses",
                    Some(0.0),
                    Some(5.0),
                )
                .map(|v| v as u32),
                min_residual_px: validate_number(&args, "minResidualPx", Some(1.0), Some(200.0)),
                profile: cached_profile,
                // On iPad (mouse.absolute=false), slam-to-corner triggers
                // the hot-corner gesture and re-locks the screen. Refuse
                // the silent slam fallback; force the caller to handle
                // detection failure explicitly.
                forbid_slam_fallback: policy.forbid_slam_fallback,
                forbid_slam_on_ipad: Some(policy.forbid_slam_on_ipad),
                ..Default::default()
            },
        )
        .await?;
        if !policy.mouse_absolute {
            let mut learner = shared.scale_learner.lock().unwrap();
            record_move_sample(
                &mut learner,
                result.learn_sample,
                learn_scale_x,
                learn_scale_y,
                false,
            );
        }

        // "during" = end-of-move cursor-alive frame (before the ~1-2s
        // fade); "after" = a post-move frame confirming the landed state
        // — reuse result.screenshot (move_to_pixel's own already-fetched
        // final frame) instead of paying a second screenshot.
        session.during().await;
        session.after(Some(result.screenshot.clone())).await;

        Ok(with_dead_zone_warning(
            ToolOutcome::text_and_image(
                format!("{}{}", result.message, session.lines()),
                b64(&result.screenshot),
                "image/jpeg",
            ),
            dead_zone,
        ))
    })
}

fn mouse_click_at(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        // ADR-0002 Phase 1: MODE_SENSITIVE_TOOLS' dispatch-level mover
        // gate already refused the call if the mode were unknown/
        // settling in practice — click_at() checks its own
        // Option<HidPolicy> explicitly regardless (not asserted), so a
        // future dispatch-gate change can't silently let a null policy
        // reach the mover.
        let policy = shared.hid_mode_resolver.lock().await.policy();

        let target_x = require_number(&args, "x", "x", None, None).map_err(anyhow::Error::msg)?;
        let target_y = require_number(&args, "y", "y", None, None).map_err(anyhow::Error::msg)?;
        let dead_zone = dead_zone_warning(target_x, target_y);
        let button_str = validate_enum(&args, "button", VALID_BUTTONS, "left").to_string();
        let button = button_from_str(&button_str);

        // M8: parse capture up front (errors on a bad request, before
        // any emit).
        let capture = parse_capture_config(&serde_json::Value::Object(args.clone()))?;

        let strategy = match args.get("strategy").and_then(serde_json::Value::as_str) {
            Some(s) if VALID_STRATEGIES.contains(&s) => Some(strategy_from_str(s)),
            _ => None,
        };
        let assume_x = validate_number(&args, "assumeCursorAtX", None, None);
        let assume_y = validate_number(&args, "assumeCursorAtY", None, None);
        let assume_cursor_at = match (assume_x, assume_y) {
            (Some(x), Some(y)) => Some(Point { x, y }),
            _ => None,
        };
        let verify_click = validate_boolean(&args, "verifyClick").unwrap_or(true);
        let verify_settle_ms = validate_number(&args, "verifySettleMs", Some(0.0), Some(5000.0))
            .unwrap_or(300.0) as u64;
        let verify_region_half_px =
            validate_number(&args, "verifyRegionHalfPx", Some(1.0), Some(1920.0));
        let verify_min_change_fraction =
            validate_number(&args, "verifyMinChangeFraction", Some(0.0001), Some(1.0));
        // M6 expectRegion: caller-supplied rectangular verify box (HDMI
        // px). Takes precedence over verify_region_half_px at the verify
        // layer.
        let expect_region = match args.get("expectRegion") {
            Some(v) if !v.is_null() => Some(require_region(v)?),
            _ => None,
        };
        // Retry removed (2026-07-28): every click is single-attempt.
        // single_tap is retained only for its brightness default +
        // advisory note.
        let single_tap = validate_boolean(&args, "singleTap").unwrap_or(false);
        // Escape hatch (2026-07-30): explicit opt-in to click at the
        // predicted position even when the cursor can't be localized.
        // Restores the capability #34 removed with requireVerifiedCursor
        // — LOUD-and-honest, never a silent phantom success.
        let force = validate_boolean(&args, "force").unwrap_or(false);
        let min_brightness = validate_number(&args, "minBrightness", Some(0.0), Some(255.0));
        // Preserved exactly as pre-extraction: NOT range-validated, just
        // coerced — a malformed maxResidualPx becomes NaN rather than
        // being rejected.
        let max_residual_px = args.get("maxResidualPx").and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        });

        let profile = shared.cached_profile.lock().unwrap().clone();

        let outcome = click_at(
            ClickAtRequest {
                client: shared.client.clone(),
                policy,
                target: Point {
                    x: target_x,
                    y: target_y,
                },
                button,
                strategy,
                assume_cursor_at,
                profile,
                verify_click,
                verify_settle_ms,
                verify_region_half_px,
                verify_min_change_fraction,
                expect_region,
                single_tap,
                force,
                min_brightness,
                max_residual_px,
                capture,
                scale_learner: &shared.scale_learner,
            },
            ClickAtDeps::default(),
        )
        .await;

        Ok(with_dead_zone_warning(
            render_click_at_outcome(outcome),
            dead_zone,
        ))
    })
}

/// `ClickAtOutcome` -> `ToolOutcome`. Pure protocol shaping — the human-
/// readable message text (including whether capture-advisory lines are
/// appended) is assembled inside `click_at` itself. Faithful port of
/// `renderClickAtOutcome`; the `Error` arm is this port's own addition
/// (see `ClickAtOutcome::Error`'s doc comment) rendered the same way as
/// `ModeUnknown`/`BrightnessAbort`.
fn render_click_at_outcome(outcome: ClickAtOutcome) -> ToolOutcome {
    match outcome {
        ClickAtOutcome::ModeUnknown { message } | ClickAtOutcome::Error { message } => {
            ToolOutcome::error_text(message)
        }
        ClickAtOutcome::BrightnessAbort { message, .. } => ToolOutcome::error_text(message),
        ClickAtOutcome::CursorUnverified {
            message,
            screenshot,
            ..
        } => {
            let mut outcome = ToolOutcome::text_and_image(message, b64(&screenshot), "image/jpeg");
            outcome.is_error = true;
            outcome
        }
        ClickAtOutcome::ResidualSkip {
            message,
            screenshot,
            ..
        } => {
            let mut outcome = ToolOutcome::text_and_image(message, b64(&screenshot), "image/jpeg");
            outcome.is_error = true;
            outcome
        }
        ClickAtOutcome::Clicked {
            message,
            screenshot,
            ..
        } => ToolOutcome::text_and_image(message, b64(&screenshot), "image/jpeg"),
    }
}

#[cfg(test)]
mod dead_zone_tests {
    // `point_in_known_letterbox` itself (cache semantics, in/out-of-frame
    // edges) is already covered by detection-vision's own orientation.rs
    // tests — these cover only `with_dead_zone_warning`'s pure wrapping
    // contract, which is this file's own responsibility.
    use super::{with_dead_zone_warning, ToolContent, ToolOutcome};

    const WARNING: &str = "WARN ";

    #[test]
    fn none_leaves_the_outcome_untouched() {
        let outcome = ToolOutcome::text("hello");
        let result = with_dead_zone_warning(outcome, None);
        match &result.content[0] {
            ToolContent::Text(t) => assert_eq!(t, "hello"),
            _ => panic!("expected Text content"),
        }
        assert!(!result.is_error);
    }

    #[test]
    fn some_prepends_to_the_first_text_block_only() {
        let outcome = ToolOutcome::text_and_image("clicked", "b64data", "image/jpeg");
        let result = with_dead_zone_warning(outcome, Some(WARNING));
        match &result.content[0] {
            ToolContent::Text(t) => assert_eq!(t, "WARN clicked"),
            _ => panic!("expected Text content first"),
        }
        match &result.content[1] {
            ToolContent::Image { data, .. } => assert_eq!(data, "b64data"),
            _ => panic!("image block must be untouched"),
        }
    }

    #[test]
    fn preserves_is_error_in_both_directions() {
        let err_outcome = with_dead_zone_warning(ToolOutcome::error_text("bad"), Some(WARNING));
        assert!(err_outcome.is_error);
        let ok_outcome = with_dead_zone_warning(ToolOutcome::text("ok"), Some(WARNING));
        assert!(!ok_outcome.is_error);
    }
}
