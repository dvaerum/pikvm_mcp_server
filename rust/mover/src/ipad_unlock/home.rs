//! Return to the iPad home screen from any foreground app via Cmd+H.
//!
//! Background: mouse swipe-up gestures from the bottom edge consistently
//! open the App Switcher on iPadOS (regardless of distance or speed), not
//! the home screen. Apple seems to reserve the true "go home" gesture for
//! finger touch. The keyboard shortcut Cmd+H ("Hide app") works reliably
//! from any foreground app and is what we use here.
//!
//! Idempotent on the home screen. Does NOT unlock from the lock screen —
//! use `unlock_ipad` for that.
//!
//! Faithful port of `src/pikvm/ipad-unlock.ts`'s `ipadGoHome`.

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_detection_vision::orientation::{
    unlock_start_from_bounds, LEGACY_PORTRAIT_UNLOCK_START,
};
use pikvm_mcp_kvmd_client::client::{MouseButton, PiKVMClient};

use crate::cursor_anchor::{
    anchor_cursor, run_key_sequence, AnchorGuard, AnchorRecoveryPosture, AnchorRequest, KeySequence,
};
use crate::gesture::emit_chunked;
use crate::slam::{Corner, ScreenshotMode};

#[derive(Debug, Clone, Copy, Default)]
pub struct IpadHomeOptions {
    /// Settle delay after the gesture before screenshotting. Default 800 ms.
    pub settle_ms: Option<u64>,
    /// Phase 214 (v0.5.202): also do a slam-to-corner + swipe-up after
    /// Cmd+H. Cmd+H alone DOES NOT dismiss the App Switcher (only
    /// foreground apps); the swipe-up gesture does both. Default false to
    /// preserve backward compatibility. Bench scripts and any caller that
    /// needs a guaranteed home-screen state should pass `true`.
    pub force_home_via_swipe: bool,
    /// Pixels to drag upward on the swipe path. Default 1500 (matches
    /// unlock_ipad's tested-good value). Only used when
    /// `force_home_via_swipe` is true.
    pub swipe_drag_px: Option<i64>,
    pub verbose: bool,
}

#[derive(Debug, Clone)]
pub struct IpadHomeResult {
    pub screenshot: Vec<u8>,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    pub message: String,
}

pub async fn ipad_go_home(
    client: &Arc<PiKVMClient>,
    options: IpadHomeOptions,
) -> anyhow::Result<IpadHomeResult> {
    let settle_ms = options.settle_ms.unwrap_or(800);

    if options.verbose {
        eprintln!("[ipad-home] Cmd+H");
    }
    client.send_shortcut(&["MetaLeft", "KeyH"]).await?;
    tokio::time::sleep(Duration::from_millis(settle_ms)).await;

    // Phase 214 (v0.5.202): Cmd+H dismisses foreground apps but NOT the
    // App Switcher. A slam-to-corner + upward swipe does both (and is
    // also safe on lock screen / home screen — idempotent). Live finding
    // 2026-05-10: bench had been measuring against the App Switcher view
    // for hours because Cmd+H couldn't exit it.
    let mut message_part = "Sent Cmd+H to dismiss the foreground app.".to_string();
    if options.force_home_via_swipe {
        if options.verbose {
            eprintln!("[ipad-home] swipe-up to force dismiss App Switcher");
        }
        let drag_px = options.swipe_drag_px.unwrap_or(1500);
        // 2026-08-24: the ONE intentional behavior change in the
        // cursor-anchor.ts migration. Before: hardcoded slam_to_corner
        // call, no verification, no recovery — ipad_keys.rs's
        // ipad_defensive_keys doc documents this exact slam occasionally
        // re-locking an unlocked iPad, with nothing to catch it until the
        // unconditional defensive Esc+Enter after the swipe. Now:
        // capture_verification checks whether the slam's motion actually
        // registered near the corner; on failure, defensive-keys recovery
        // (Esc+Enter, matching Phase 231's own sequence) runs
        // immediately, closing a real, previously-unguarded gap rather
        // than relying solely on the post-swipe belt-and-suspenders
        // below.
        // F3 (Round 2 Phase 4): anchor_cursor already ran a full bounds
        // detection internally to resolve the slam origin
        // (resolve_caller_asserted_origin) and returns it as
        // `.origin`/`.bounds` — destructure those instead of
        // re-detecting + recomputing slam_origin_from_bounds(bounds) a
        // second time, which is what this code used to do.
        let anchor_result = anchor_cursor(AnchorRequest {
            client: client.clone(),
            corner: Some(Corner::TopLeft),
            guard: AnchorGuard::CallerAsserted {
                reason: "Layer 5 — safe on lock screen and home screen, idempotent".to_string(),
            },
            screenshot: ScreenshotMode::Raw,
            capture_verification: true,
            recovery: AnchorRecoveryPosture::DefensiveKeys,
            nudge: None,
            pace_ms: None,
            slam_origin_px: None,
            slam_calls: None,
            verbose: options.verbose,
        })
        .await?;
        let (verified, slam_origin, bounds) = (
            anchor_result.verified,
            anchor_result.origin,
            anchor_result.bounds,
        );
        if verified == Some(false) {
            message_part.push_str(
                " WARNING: the pre-swipe slam-to-corner motion did not verify (defensive Esc+Enter sent) — inspect the screenshot carefully.",
            );
        }
        // Move down to the bottom-centre area so the swipe starts from a
        // region where iPadOS expects the home gesture. `bounds`/
        // `slam_origin` came from anchor_cursor above — no second
        // detection round trip.
        let start = match &bounds {
            Some(b) => {
                let (x, y) = unlock_start_from_bounds(b);
                (x as i64, y as i64)
            }
            None => LEGACY_PORTRAIT_UNLOCK_START,
        };
        let pos_x = (start.0 - slam_origin.0) as f64;
        let pos_y = (start.1 - slam_origin.1) as f64;
        let pos_chunks = emit_chunked(client, pos_x, pos_y, 127.0, 20).await?;
        if pos_chunks > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        client
            .mouse_click(MouseButton::Left, Some(true), None)
            .await?;
        emit_chunked(client, 0.0, -(drag_px as f64), 30.0, 0).await?;
        client
            .mouse_click(MouseButton::Left, Some(false), None)
            .await?;
        tokio::time::sleep(Duration::from_millis(1000)).await;
        // Phase 231 (v0.5.207) defensive pair — see ipad_keys.rs's
        // ipad_defensive_keys for the full rationale.
        run_key_sequence(client, KeySequence::Defensive).await?;
        // Phase 235 (v0.5.208): the swipe leaves cursor pinned at the top
        // edge (drag terminates at y≈0). Live N=5 diagnostic 2026-05-10:
        // target-region clicks fail (residual 438 px) when cursor starts
        // at top edge but succeed (residual 33 px) when cursor starts
        // mid-screen. Per-call cap means moveToPixel can't recover from
        // the top-edge pinning in one call. Deposit cursor at mid-screen
        // here using chunked Y emits — pure downward motion (~540 px)
        // split into 6 chunks of 100 px so iPadOS registers each
        // separately rather than clamping. Trailing sleep(40) preserved:
        // the old inline loops slept after every chunk, including the
        // last.
        if let Some(b) = &bounds {
            let target_y = (b.y as i64 + b.height as i64 / 2).max(0);
            let deposit_chunks = emit_chunked(client, 0.0, target_y as f64, 100.0, 40).await?;
            if deposit_chunks > 0 {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        } else {
            // No detected iPad bounds — fall back to a fixed descent
            // that works for the reference iPad portrait layout (~1050 px
            // tall in 1680x1050 HDMI capture or ~1080 px in 1920x1080).
            // 600 px overshoots mid-screen on shorter frames but iPadOS
            // clamps benign movement at the bottom edge — the deposit's
            // goal is "not at top edge anymore", not pixel-perfect
            // centering.
            emit_chunked(client, 0.0, 600.0, 100.0, 40).await?;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        message_part.push_str(
            " Followed by slam-corner + swipe-up + defensive Esc+Enter (Phase 231) + mid-screen cursor deposit (Phase 235).",
        );
    }

    let shot = client.screenshot(None).await?;
    Ok(IpadHomeResult {
        screenshot: shot.buffer,
        screenshot_width: shot.screenshot_width,
        screenshot_height: shot.screenshot_height,
        message: format!(
            "{message_part} Inspect the screenshot to confirm the iPad is on the home screen. \
             (Cmd+H does not unlock the iPad — call pikvm_ipad_unlock from the lock screen instead.)"
        ),
    })
}
