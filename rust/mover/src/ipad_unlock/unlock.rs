//! iPad lock-screen unlock gesture for PiKVM targets in relative mouse mode.
//!
//! iPadOS unlocks from the lock screen via a bottom-to-top swipe originating
//! near the home indicator bar. With a USB HID mouse (which is what PiKVM
//! provides when `mouse.absolute=false`), this translates to:
//!
//!   1. Position the cursor near the home indicator (bottom center).
//!   2. Press the left mouse button.
//!   3. Rapid-fire relative-Y deltas upward (negative dy) covering enough
//!      distance to clear iPadOS's unlock threshold.
//!   4. Release the button.
//!
//! Empirically verified on the reference iPad (1920x1080 HDMI frame,
//! portrait content letterbox):
//!
//!   - Start at HDMI (955, 1035)
//!   - 800 px total drag distance
//!   - Chunked into 30-mickey calls (≈27 calls) emitted back-to-back
//!   - No pacing sleeps between calls
//!
//! A 400 px drag did NOT unlock; 800 px did. Speed mattered less than total
//! distance. The drag takes ~400 ms end-to-end including HTTP latency.
//!
//! Faithful port of `src/pikvm/ipad-unlock.ts`'s `unlockIpad`.

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_detection_vision::orientation::{
    detect_bounds_or_null, slam_origin_from_bounds, unlock_start_from_bounds, DetectOptions,
    IpadBounds, LEGACY_PORTRAIT_SLAM_ORIGIN, LEGACY_PORTRAIT_UNLOCK_START,
};
use pikvm_mcp_kvmd_client::client::{MouseButton, PiKVMClient};

use crate::cursor_anchor::{
    anchor_cursor, run_key_sequence, AnchorGuard, AnchorRecoveryPosture, AnchorRequest, KeySequence,
};
use crate::gesture::emit_chunked;
use crate::slam::{Corner, ScreenshotMode};

#[derive(Debug, Clone, Copy, Default)]
pub struct IpadUnlockOptions {
    /// Whether to slam to top-left first to establish a known cursor
    /// position before positioning at the unlock start. Useful when the
    /// cursor state is unknown. Default true.
    pub slam_first: Option<bool>,
    /// HDMI X of the unlock-swipe start. Default: auto-detected from the
    /// iPad's letterbox bounds (centre X). Override only if detection
    /// fails or you need a non-centre swipe origin.
    pub start_x: Option<i64>,
    /// HDMI Y of the unlock-swipe start. Default: auto-detected from the
    /// iPad's letterbox bounds (~45 px above the bottom edge, where the
    /// home indicator lives).
    pub start_y: Option<i64>,
    /// Total pixel distance to drag upward. Default 1500 (Phase 209,
    /// v0.5.198). Earlier default was 800 — found insufficient on some
    /// iPads where even 1200 didn't clear the unlock threshold.
    pub drag_px: Option<i64>,
    /// Try Esc + Enter + Space before the swipe. Default true. Enter is
    /// the actual unlock key on iPadOS 26 lock screens; Space was the
    /// working key on older iPadOS revisions and is kept as a fallback.
    /// Set false to skip and go straight to swipe.
    pub try_key_press_first: Option<bool>,
    /// When true (default), the swipe is SKIPPED if the key press ran
    /// successfully. Reason: a swipe-up from the bottom-center on an
    /// already-unlocked home screen is interpreted by iPadOS as a system
    /// gesture that LOCKS the iPad — verified live 2026-05-10. Set false
    /// to force the legacy keys-then-swipe sequence for back-compat or
    /// when keys alone don't unlock.
    pub swipe_on_key_press_failure: Option<bool>,
    /// Per-call mickey size for the drag. Smaller = higher call rate =
    /// faster apparent motion. Default 30.
    pub chunk_mickeys: Option<f64>,
    /// Slam-to-corner pace when slam_first is true (ms between calls).
    /// `None` falls through to slam_to_corner's own default (currently
    /// 60ms) via cursor_anchor's anchor_cursor — kept `None` rather than
    /// defaulted here so that default stays a single source of truth.
    pub slam_pace_ms: Option<u64>,
    /// px/mickey estimate used to position the cursor at (start_x,
    /// start_y) before the swipe. Default 1.0 (the iPad's approximate
    /// ratio at mag=127, pace=20 ms).
    pub position_px_per_mickey: Option<f64>,
    /// Settle after swipe before returning, so iPadOS has time to process
    /// the gesture and the home screen renders. Default 1000 ms.
    pub post_settle_ms: Option<u64>,
    pub verbose: bool,
}

#[derive(Debug, Clone)]
pub struct IpadUnlockResult {
    pub screenshot: Vec<u8>,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    pub drag_px: i64,
    pub chunk_count: u32,
    pub swipe_duration_ms: u64,
    /// iPad bounds used for swipe positioning. `None` if start_x/start_y
    /// were both passed explicitly (no detection performed).
    pub bounds: Option<IpadBounds>,
    /// Result of anchor_cursor's post-slam motion check
    /// (cursor_anchor.rs, capture_verification:true). `Some(true)` = the
    /// expected cursor motion registered near the corner; `Some(false)` =
    /// it didn't (the slam may have been reinterpreted as a system
    /// gesture) and key-sequence-retry recovery was attempted; `None` =
    /// slam_first was false, or the key-press-only path returned before
    /// reaching the slam step, so no check was performed.
    pub slam_verified: Option<bool>,
    pub message: String,
}

pub async fn unlock_ipad(
    client: &Arc<PiKVMClient>,
    options: IpadUnlockOptions,
) -> anyhow::Result<IpadUnlockResult> {
    // Esc → Enter → Space (see ipad_keys.rs's ipad_unlock_key_sequence for
    // the full per-key rationale). Swallowing the error is caller-specific
    // fallthrough logic — stays here, not in the extracted function.
    let mut key_press_attempted = false;
    if options.try_key_press_first != Some(false)
        && run_key_sequence(client, KeySequence::Unlock).await.is_ok()
    {
        key_press_attempted = true;
    }

    // Skip the swipe when keys ran: a swipe-from-bottom on an already-
    // unlocked home screen is interpreted by iPadOS as a system gesture
    // that LOCKS the iPad. swipe_on_key_press_failure:false forces the
    // legacy always-swipe path for callers that need it.
    let swipe_on_key_press_failure = options.swipe_on_key_press_failure.unwrap_or(true);
    if key_press_attempted && swipe_on_key_press_failure {
        // Skip the swipe — assume the keys did the work. Caller can
        // inspect the returned screenshot to confirm and call again with
        // try_key_press_first: false if the iPad is still locked.
        let shot = client.screenshot(None).await?;
        return Ok(IpadUnlockResult {
            screenshot: shot.buffer,
            screenshot_width: shot.screenshot_width,
            screenshot_height: shot.screenshot_height,
            drag_px: 0,
            chunk_count: 0,
            swipe_duration_ms: 0,
            bounds: None,
            slam_verified: None,
            message: "Sent Escape + Enter + Space (Phase 217). Swipe SKIPPED to avoid \
                      the home-screen-to-lock-screen gesture artifact (Phase 219). \
                      Inspect the screenshot to confirm the iPad is on the home screen \
                      (if still on the lock screen, call again with \
                      tryKeyPressFirst: false to force the swipe-based unlock)."
                .to_string(),
        });
    }
    let slam_first = options.slam_first.unwrap_or(true);
    // Phase 209 (v0.5.198): default bumped 800 → 1500. Live test
    // 2026-05-10 found dragPx=800 insufficient on this iPad — even 1200
    // didn't clear the unlock threshold. iPadOS unlock thresholds vary
    // across devices and iPadOS versions; a generous default is safer
    // than under-shooting. The cost of a too-large swipe is negligible
    // (extra ~400ms HID emission); under-shooting wastes a full unlock
    // attempt and confuses callers.
    let drag_px = options.drag_px.unwrap_or(1500);
    let chunk_mickeys = options.chunk_mickeys.unwrap_or(30.0);
    let ppm = options.position_px_per_mickey.unwrap_or(1.0);
    let post_settle_ms = options.post_settle_ms.unwrap_or(1000);

    // Auto-detect iPad bounds unless caller has fully overridden positioning.
    let mut bounds: Option<IpadBounds> = None;
    if options.start_x.is_none() || options.start_y.is_none() {
        bounds = detect_bounds_or_null(
            client,
            DetectOptions {
                verbose: options.verbose,
                ..Default::default()
            },
            "ipad-unlock",
        )
        .await;
        if options.verbose {
            if let Some(b) = &bounds {
                eprintln!(
                    "[ipad-unlock] detected {:?} bounds ({},{}) {}×{}",
                    b.orientation, b.x, b.y, b.width, b.height
                );
            }
        }
    }

    let detected_swipe_start = match &bounds {
        Some(b) => {
            let (x, y) = unlock_start_from_bounds(b);
            (x as i64, y as i64)
        }
        None => LEGACY_PORTRAIT_UNLOCK_START,
    };
    let start_x = options.start_x.unwrap_or(detected_swipe_start.0);
    let start_y = options.start_y.unwrap_or(detected_swipe_start.1);

    // 1. Optionally slam so we know the starting position (top-left of
    // iPad content).
    //
    // 2026-08-24: a controlled retest found the slam's lock-screen risk
    // present at a non-trivial rate regardless of pace — and this is the
    // one slam_to_corner call site that's unguarded and reachable with
    // zero special args (launch_ipad_app's default unlock_first=true
    // calls unlock_ipad() by default). Layer 5
    // (docs/troubleshooting/ipad-safety-guards.md): a locked screen has
    // no active hot corner, so slamming here is safe by design —
    // cursor_anchor's `CallerAsserted` guard never refuses, unlike
    // move-to.ts's bounds-guard. capture_verification checks whether the
    // slam's expected motion actually registered; if not,
    // key-sequence-retry recovery retries the key sequence once and
    // re-attempts the slam (we can't call unlock_ipad() again to
    // recover — that's this function, would recurse). If it still
    // doesn't verify, continue anyway: the swipe below is still our best
    // remaining attempt, and the caller inspects the returned screenshot
    // either way. slam_origin_px is passed explicitly from the bounds
    // already detected above so anchor_cursor doesn't re-detect (this
    // function needs that same detection for the swipe-start position
    // regardless).
    let mut slam_verified: Option<bool> = None;
    if slam_first {
        let slam_origin_px = match &bounds {
            Some(b) => {
                let (x, y) = slam_origin_from_bounds(b);
                (x as i64, y as i64)
            }
            None => LEGACY_PORTRAIT_SLAM_ORIGIN,
        };
        let slam_result = anchor_cursor(AnchorRequest {
            client: client.clone(),
            allow_keyboard_wake_after: false, // see docs/corner-control-allow-keyboard-wake-decision.md
            allow_keyboard_wake_before: false, // see docs/corner-control-allow-keyboard-wake-decision.md
            corner: Some(Corner::TopLeft),
            guard: AnchorGuard::CallerAsserted {
                reason: "Layer 5 — lock screen has no active hot corner".to_string(),
            },
            screenshot: ScreenshotMode::Raw,
            capture_verification: true,
            recovery: AnchorRecoveryPosture::KeySequenceRetry,
            nudge: None,
            pace_ms: options.slam_pace_ms,
            slam_origin_px: Some(slam_origin_px),
            slam_calls: None,
            verbose: options.verbose,
        })
        .await?;
        slam_verified = slam_result.verified;
    }

    // 2. Position the cursor at (start_x, start_y). Post-slam origin is
    // the top-left of the iPad content within the HDMI letterbox.
    let slam_origin = match &bounds {
        Some(b) => {
            let (x, y) = slam_origin_from_bounds(b);
            (x as i64, y as i64)
        }
        None => LEGACY_PORTRAIT_SLAM_ORIGIN,
    };
    let (origin_x, origin_y) = slam_origin;
    let dx = ((start_x - origin_x) as f64 / ppm).round();
    let dy = ((start_y - origin_y) as f64 / ppm).round();

    // Emit chunked deltas to reach start position. Use mag=127 chunks.
    // (trailing sleep(20) preserved to match the pre-refactor per-chunk
    // pacing — the old inline loop slept after every chunk, including
    // the last.)
    let pos_chunks = emit_chunked(client, dx, dy, 127.0, 20).await?;
    if pos_chunks > 0 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 3. Press button.
    client
        .mouse_click(MouseButton::Left, Some(true), None)
        .await?;

    // 4. Rapid-fire upward drag (no inter-chunk pacing).
    let swipe_start = std::time::Instant::now();
    let chunk_count = emit_chunked(client, 0.0, -(drag_px as f64), chunk_mickeys, 0).await?;
    let swipe_duration_ms = swipe_start.elapsed().as_millis() as u64;

    // 5. Release.
    client
        .mouse_click(MouseButton::Left, Some(false), None)
        .await?;

    if options.verbose {
        let px_per_s = if swipe_duration_ms > 0 {
            (drag_px as f64 / swipe_duration_ms as f64 * 1000.0).round() as i64
        } else {
            0
        };
        eprintln!(
            "[ipad-unlock] dragPx={drag_px} chunks={chunk_count} durationMs={swipe_duration_ms} (~{px_per_s} px/s)"
        );
    }

    // 6. Let iPadOS render the home screen.
    tokio::time::sleep(Duration::from_millis(post_settle_ms)).await;

    let shot = client.screenshot(None).await?;

    let slam_warning = if slam_verified == Some(false) {
        " WARNING: the pre-swipe slam-to-corner motion did not verify (even after a key-sequence retry) — \
         the cursor origin used for positioning may be wrong; inspect the screenshot carefully."
    } else {
        ""
    };
    let message = format!(
        "Unlock swipe: {drag_px} px upward in {chunk_count} chunks over {swipe_duration_ms} ms. \
         Inspect the returned screenshot to confirm the iPad is now on the home screen \
         (if still lock screen, the swipe did not clear iPadOS's unlock threshold — retry with larger dragPx).{slam_warning}"
    );

    Ok(IpadUnlockResult {
        screenshot: shot.buffer,
        screenshot_width: shot.screenshot_width,
        screenshot_height: shot.screenshot_height,
        drag_px,
        chunk_count,
        swipe_duration_ms,
        bounds,
        slam_verified,
        message,
    })
}
