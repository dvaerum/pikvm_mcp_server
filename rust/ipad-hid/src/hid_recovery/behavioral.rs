//! The default behavioral `HidVerifier`: emit a mouse move and check the
//! POINTER actually responded — the cursor must be LOCALIZABLE and have
//! MOVED with the emit, not just "the screen changed somehow" (a clock
//! tick or app animation false-positived the old check while HID was
//! stone dead — fix-(c), 2026-07-30).
//!
//! Faithful port of `src/pikvm/hid-recovery.ts`'s `makeBehavioralVerifier`.
//! Split out of `hid_recovery.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).
//!
//! This is the POINTER layer; a recovery trigger's own UDC-`configured`
//! check is the HID layer — the two compose, they do not replace each
//! other (a box can be `configured` yet have an unlocalizable pointer).

use std::time::Duration;

use pikvm_mcp_detection_vision::cursor_ml_detect::{
    find_cursor_by_v8_full_frame, V8FullFrameOptions,
};
use pikvm_mcp_detection_vision::decode::decode_to_rgb;

use super::types::{HidRecoveryClient, HidVerifier, VerifyResult};

#[derive(Clone, Copy, Debug)]
pub struct BehavioralVerifierOptions {
    pub emit_dx: i32,
    pub settle_ms: u64,
    pub min_move_px: f64,
    pub min_presence: f64,
}

impl Default for BehavioralVerifierOptions {
    fn default() -> Self {
        Self {
            emit_dx: 40,
            settle_ms: 300,
            min_move_px: 8.0,
            min_presence: 0.5,
        }
    }
}

/// Faithful port of `makeBehavioralVerifier` (default `locate`, wired to
/// the real `find_cursor_by_v8_full_frame` detector — the same one the
/// mover/click paths use, per the TS source's own doc comment. The TS
/// `deps.locate` injection point for tests is NOT ported: this crate's
/// own test convention stubs `HidVerifier::new`'s `verify_fn` directly
/// instead (see `hid_recovery/tests.rs`), so there's no real caller for a
/// second injection layer here.
pub fn make_behavioral_verifier(
    client: HidRecoveryClient,
    opts: BehavioralVerifierOptions,
) -> HidVerifier {
    HidVerifier::new(move || {
        let client = client.clone();
        Box::pin(async move {
            let locate = |buffer: &[u8]| -> Option<(f64, f64)> {
                let Ok(dec) = decode_to_rgb(buffer) else {
                    return None;
                };
                let hit = find_cursor_by_v8_full_frame(
                    buffer,
                    dec.width,
                    dec.height,
                    V8FullFrameOptions {
                        min_presence: Some(opts.min_presence),
                        hint: None,
                    },
                )
                .ok()
                .flatten();
                hit.map(|h| (h.x, h.y))
            };

            let before_shot = match client.screenshot().await {
                Ok(s) => s,
                Err(e) => {
                    return VerifyResult {
                        healthy: false,
                        detail: format!("behavioral verify failed: {e}"),
                    }
                }
            };
            let before = locate(&before_shot);

            if let Err(e) = client.mouse_move_relative(opts.emit_dx, 0).await {
                return VerifyResult {
                    healthy: false,
                    detail: format!("behavioral verify failed: {e}"),
                };
            }
            tokio::time::sleep(Duration::from_millis(opts.settle_ms)).await;

            let after_shot = match client.screenshot().await {
                Ok(s) => s,
                Err(e) => {
                    return VerifyResult {
                        healthy: false,
                        detail: format!("behavioral verify failed: {e}"),
                    }
                }
            };
            let after = locate(&after_shot);
            // There-and-back emit: a working HID visibly moves the cursor
            // without permanently displacing it. Best-effort — a failure
            // here doesn't change the verdict already computed above.
            let _ = client.mouse_move_relative(-opts.emit_dx, 0).await;

            let Some(after) = after else {
                return VerifyResult {
                    healthy: false,
                    detail: "mouse emit produced NO localizable cursor — the pointer is not rendering. HID is not \
                             driving input, OR HID is up but the pointer is faded/off-screen (not localizable)."
                        .to_string(),
                };
            };
            if let Some(before) = before {
                let moved = ((after.0 - before.0).powi(2) + (after.1 - before.1).powi(2)).sqrt();
                if moved < opts.min_move_px {
                    return VerifyResult {
                        healthy: false,
                        detail: format!(
                            "cursor is localizable but did NOT move on the mouse emit ({moved:.0}px < \
                             {}px) — HID is not driving input (a bare screen change, e.g. a clock tick, would \
                             have FALSELY passed the old check).",
                            opts.min_move_px
                        ),
                    };
                }
                return VerifyResult {
                    healthy: true,
                    detail: format!("mouse emit moved the cursor {moved:.0}px to a localizable position — HID is driving input."),
                };
            }
            // Not localizable before, localizable after: the emit rendered
            // a previously-unfindable cursor — HID is driving input.
            VerifyResult {
                healthy: true,
                detail: "mouse emit produced a localizable cursor (not visible before) — HID is driving input."
                    .to_string(),
            }
        })
    })
}
