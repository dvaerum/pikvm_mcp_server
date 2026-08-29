//! Unified cursor-anchoring primitive: slam-to-corner + safety guard +
//! optional verification + optional recovery.
//!
//! Consolidates what used to be 3 independently-evolving copies of this
//! logic: move-to.ts's `discoverOrigin` (Layers 1/2/3 iPad-lock guard),
//! ipad-unlock.ts's `unlockIpad` + `ipadGoHome` (verify + key-sequence
//! recovery), and ballistics.ts's `measureCell` (no guard, synthetic-scene
//! calibration slam). See docs/troubleshooting/ipad-safety-guards.md for
//! the hot-corner-lock failure mode the guard exists to prevent.
//!
//! Faithful port of `src/pikvm/cursor-anchor.ts`.
//!
//! Crate placement (2026-08-28 finding, see docs/rust-port-plan.md §7):
//! the original task list filed this file under module 3
//! (detection-vision), but the TS source imports `slam.ts` directly —
//! `slam.ts` is module 4 (mover). Per the plan's own dependency ordering
//! (mover depends on detection-vision, never the reverse), this file lives
//! in `rust/mover` alongside `slam.rs`, not in detection-vision.
//!
//! `AnchorRequest.client` is `Arc<PiKVMClient>`, not the plain `&PiKVMClient`
//! every other function in this crate takes: the key-sequence recovery
//! branches need to hand `client` into `ipad_unlock_key_sequence`/
//! `ipad_defensive_keys`'s closure-DI signatures, whose returned futures
//! must be `'static` (they're built for callers with no borrow to anchor a
//! shorter lifetime to). An `Arc` gives a cheap `.clone()` for those
//! closures while still `Deref`ing to `&PiKVMClient` everywhere else
//! (`slam_to_corner`, `nudge_from_edge`, `detect_bounds_or_null`, ...), so
//! every other call site in this file is unaffected.
//!
//! `AnchorRequest.screenshot` is `ScreenshotMode`, not TS's injected
//! `(client) => Promise<Buffer>` closure — same adaptation `slam.rs`'s own
//! `SlamOptions.screenshot` already made (see its doc comment): ADR-0001's
//! two real behaviors are exhaustive, and `PiKVMClient` already exposes
//! both as public methods, so there's nothing left for a closure to inject.

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_detection_vision::orientation::{
    detect_bounds_or_null, get_last_good_bounds, slam_origin_from_bounds, DetectOptions,
    IpadBounds, IpadOrientation, LEGACY_PORTRAIT_SLAM_ORIGIN,
};
use pikvm_mcp_ipad_primitives::ipad_keys::{
    ipad_defensive_keys, ipad_unlock_key_sequence, BoxFuture,
};
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::slam::{
    nudge_from_edge, slam_to_corner, NudgeOptions, ScreenshotMode, SlamMotionCheck, SlamOptions,
};
// Re-exported so call sites migrating to anchorCursor don't need a second
// import from slam.rs just for the shared Corner/Axis types.
pub use crate::slam::{Axis, Corner};

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone)]
pub enum AnchorGuard {
    /// Layers 1/2/3 (docs/troubleshooting/ipad-safety-guards.md): refuses
    /// to slam when the target looks like (or might be) an iPad-portrait
    /// letterbox, unless the caller passed an explicit `slam_origin_px`.
    /// Errors on refusal — this is move-to.ts's `discoverOrigin` behavior
    /// today.
    BoundsGuard {
        /// move-to.ts's `forbidSlamOnIpad=false` opt-out. Gates ONLY the
        /// refusal-error — origin computation (cache-first via
        /// `get_last_good_bounds()`, else fresh detection, else
        /// `LEGACY_PORTRAIT` fallback) is identical either way. This
        /// matters because `forbidSlamOnIpad:false` isn't a rare test
        /// escape hatch: hid-mode.ts's `policy()` sets it for every real
        /// desktop/absolute-mouse target, so silently dropping the cache
        /// path here would be a live perf regression, not just a
        /// guard-semantics change. Default false (today's
        /// always-refuse-on-undetermined behavior).
        allow_on_undetermined: bool,
    },
    /// Layer 5: caller has already established slamming is safe (e.g. a
    /// lock screen has no active hot corner) and takes responsibility.
    /// Never errors on the safety question — `unlockIpad`, `ipadGoHome`.
    CallerAsserted { reason: String },
    /// `measureCell`: synthetic calibration scene, no iPad-lock risk, no
    /// guard.
    NoneCalibration,
}

/// F6 (Round 2 Phase 5c): collapses what used to be two separate fields
/// (`selfGate: bool` + `recovery: {kind: 'none'|'key-sequence-retry'|
/// 'defensive-keys'}`) into one enum — 1:1 with the four behaviors the four
/// real call sites actually use today (move-to.ts, ipad-unlock.ts's
/// `unlockIpad`/`ipadGoHome`, ballistics.ts's `measureCell`). Only
/// meaningful when `capture_verification` is true — irrelevant otherwise
/// (nothing computed to gate on), same as the old selfGate/recovery pair.
///
///  - `InspectOnly` — was `selfGate:false`: verified is still computed and
///    returned, but `anchor_cursor` never errors or acts on failure; the
///    caller reads `AnchorResult.verified` itself (`measureCell`'s exact
///    combo: reject the cell, no retry — ballistics already resamples via
///    `reps`).
///  - `Throw` — was the old default (`selfGate:true` + `recovery:{kind:
///    'none'}`): a failed verification errors. `recovery` itself has NO
///    default now (same discipline as `guard`: a new call site must name
///    its posture explicitly), so this is just an ordinary variant, not a
///    fallback. Not exercised by any of the four real call sites today.
///  - `KeySequenceRetry` — `unlockIpad`'s Esc→Enter→Space, then re-attempt
///    the slam+verify once.
///  - `DefensiveKeys` — `ipadGoHome`'s Phase-231 Esc+Enter. No re-attempt —
///    caller inspects the returned screenshot itself, matching
///    `ipadGoHome`'s existing messaging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorRecoveryPosture {
    InspectOnly,
    Throw,
    KeySequenceRetry,
    DefensiveKeys,
}

/// Post-slam nudge away from the slammed corner. `None` (the TS `false` /
/// omitted case) skips the nudge entirely.
#[derive(Debug, Clone, Copy, Default)]
pub struct AnchorNudge {
    pub away: Option<Corner>,
    pub only_axis: Option<Axis>,
}

pub struct AnchorRequest {
    pub client: Arc<PiKVMClient>,
    /// Corner to slam to. Default top-left — the only corner any current
    /// call site uses, but kept general rather than hardcoded.
    pub corner: Option<Corner>,
    /// REQUIRED, no default — a new call site can't compile without naming
    /// its safety posture.
    pub guard: AnchorGuard,
    /// ADR 0001 (docs/adr/0001-do-not-merge-cursor-detection-and-
    /// calibration-sampling-lookalikes.md): three real `takeRawScreenshot`
    /// variants exist on purpose and must not be merged. REQUIRED, no
    /// default: silently picking one would risk a numeric regression no
    /// test catches — pass the non-nudging capture for calibration-adjacent
    /// call sites; read ADR 0001 before relaxing this.
    pub screenshot: ScreenshotMode,
    /// Whether `anchor_cursor` takes a before/after screenshot pair to
    /// compute `verified` at all. Default false: `verified` stays `None`,
    /// `screenshot` is never called for this purpose, `recovery` is
    /// irrelevant (nothing to gate on). This is the zero-cost path —
    /// move-to.ts's bounds-guard migration relies on the default to stay
    /// byte-for-byte behavior-identical to today (no new round trips).
    pub capture_verification: bool,
    /// What `anchor_cursor` does when `capture_verification` is true and
    /// the slam fails to verify. Irrelevant when `capture_verification` is
    /// false — but still REQUIRED, no default, same discipline as `guard`.
    /// Pass `InspectOnly` for the inert case.
    pub recovery: AnchorRecoveryPosture,
    /// Post-slam nudge away from the slammed corner, past iPadOS's edge
    /// dead zone, so the cursor sits in open space (`measureCell`'s use
    /// case — the ballistics sweep needs room to travel). Runs after
    /// verification/recovery, using `nudge_from_edge`'s own built-in
    /// call-count/pace. `None` skips it.
    pub nudge: Option<AnchorNudge>,
    pub pace_ms: Option<u64>,
    /// Caller-supplied slam origin. Also the bounds-guard escape hatch: an
    /// explicit `slam_origin_px` means the caller has taken responsibility
    /// for where the slam lands, so the iPad-letterbox refusal doesn't
    /// apply.
    pub slam_origin_px: Option<(i64, i64)>,
    /// **NEW — not a port of any TS source.** Overrides `slam_to_corner`'s
    /// own `calls` default (which always guarantees reaching the corner).
    /// `None` (every real production call site) keeps that guarantee.
    /// Added post-incident (2026-08-29,
    /// `cursor_anchor_corner_control_smoke.rs`'s E2E category-2 gate):
    /// before this field existed, there was no way to exercise a
    /// deliberately-incomplete slam through the GUARDED `anchor_cursor`
    /// path, so the gate called `slam_to_corner` directly — bypassing the
    /// guard entirely and locking the iPad on a target the guard would
    /// likely have protected. The fix is this field, not a workaround: a
    /// test that needs an incomplete slam now still goes through
    /// `AnchorGuard::CallerAsserted`, the same safety contract every real
    /// caller uses, rather than the raw unguarded primitive.
    pub slam_calls: Option<u32>,
    pub verbose: bool,
}

#[derive(Debug, Clone)]
pub struct AnchorResult {
    /// Post-slam origin in HDMI pixel coordinates.
    pub origin: (i64, i64),
    /// Result of the post-slam "landed near corner" check. `None` when
    /// `capture_verification` was false (or defaulted false) — no check
    /// ran.
    pub verified: Option<bool>,
    /// Whether recovery ran (verification failed and recovery wasn't
    /// `InspectOnly`).
    pub recovery_attempted: bool,
    /// iPad bounds used to compute `origin`, when detection ran. `None`
    /// for `guard: NoneCalibration` (no detection) or when the caller
    /// supplied `slam_origin_px` directly (detection skipped).
    pub bounds: Option<IpadBounds>,
}

fn guard_kind_label(guard: &AnchorGuard) -> &'static str {
    match guard {
        AnchorGuard::BoundsGuard { .. } => "bounds-guard",
        AnchorGuard::CallerAsserted { .. } => "caller-asserted",
        AnchorGuard::NoneCalibration => "none-calibration",
    }
}

async fn anchor_detect_bounds_or_null(req: &AnchorRequest) -> Option<IpadBounds> {
    detect_bounds_or_null(
        &req.client,
        DetectOptions {
            verbose: req.verbose,
            ..Default::default()
        },
        "cursor-anchor",
    )
    .await
}

/// Layers 1/2/3 (docs/troubleshooting/ipad-safety-guards.md), moved
/// verbatim from move-to.ts's `discoverOrigin`. The error message is
/// intentionally unchanged (including its "moveToPixel:" prefix) —
/// callers pattern-match on it; see the test module's byte-identical
/// assertion.
async fn resolve_bounds_guard_origin(
    req: &AnchorRequest,
    allow_on_undetermined: bool,
) -> anyhow::Result<((i64, i64), Option<IpadBounds>)> {
    let mut slam_origin = req.slam_origin_px;
    let mut detected_bounds: Option<IpadBounds> = None;
    if slam_origin.is_none() {
        detected_bounds = get_last_good_bounds();
        if let Some(b) = &detected_bounds {
            if req.verbose {
                eprintln!(
                    "[cursor-anchor] using cached {:?} bounds {}×{} (no re-detection)",
                    b.orientation, b.width, b.height
                );
            }
        } else {
            detected_bounds = anchor_detect_bounds_or_null(req).await;
        }
        slam_origin = Some(if let Some(b) = &detected_bounds {
            let (ox, oy) = slam_origin_from_bounds(b);
            if req.verbose {
                eprintln!(
                    "[cursor-anchor] auto-detected {:?} slam-origin ({ox},{oy})",
                    b.orientation
                );
            }
            (ox as i64, oy as i64)
        } else {
            LEGACY_PORTRAIT_SLAM_ORIGIN
        });
    }
    let slam_origin = slam_origin.expect("slam_origin resolved above");

    let caller_provided_origin = req.slam_origin_px.is_some();
    let known_non_ipad =
        matches!(&detected_bounds, Some(b) if b.orientation == IpadOrientation::Landscape);
    if !allow_on_undetermined && !known_non_ipad && !caller_provided_origin {
        let reason = match &detected_bounds {
            Some(b) => format!(
                "iPad-portrait letterbox detected (bounds {}×{})",
                b.width, b.height
            ),
            None => "target type undetermined (bounds detection failed — frame too dark or unrecognised) \
                      and slam-origin defaulted to LEGACY_PORTRAIT, which presumes iPad"
                .to_string(),
        };
        anyhow::bail!(
            "moveToPixel: refusing slam-then-move — {reason}. \
             Slam-to-corner on an iPad triggers the iPadOS hot-corner gesture and \
             re-locks the screen mid-session. Options: \
             (1) use strategy='detect-then-move' (recommended for iPad), \
             (2) pass slamOriginPx explicitly if you know the target is non-iPad, \
             (3) pass forbidSlamOnIpad=false to opt out (only safe if iPad \
             hot-corners are disabled)."
        );
    }

    Ok((slam_origin, detected_bounds))
}

/// Layer 5: caller has already decided slamming is safe. Best-effort
/// bounds detection purely to compute a sane origin — never errors.
///
/// F3 (Round 2 Phase 4): cache-first, matching `resolve_bounds_guard_origin`'s
/// own pattern. REAL BEHAVIOR CHANGE vs. this guard's pre-migration TS
/// history, called out explicitly: a stale cached bounds reading can be
/// returned here instead of a fresh detect. Both this guard's real call
/// sites (`unlockIpad`, `ipadGoHome`) run once per user-initiated action,
/// not in a tight loop, so the staleness window in practice is short.
async fn resolve_caller_asserted_origin(req: &AnchorRequest) -> ((i64, i64), Option<IpadBounds>) {
    if let Some(origin) = req.slam_origin_px {
        return (origin, None);
    }
    let bounds = match get_last_good_bounds() {
        Some(b) => Some(b),
        None => anchor_detect_bounds_or_null(req).await,
    };
    let origin = match &bounds {
        Some(b) => {
            let (x, y) = slam_origin_from_bounds(b);
            (x as i64, y as i64)
        }
        None => LEGACY_PORTRAIT_SLAM_ORIGIN,
    };
    (origin, bounds)
}

/// `measureCell`: synthetic scene, no guard, no detection.
fn resolve_calibration_origin(req: &AnchorRequest) -> ((i64, i64), Option<IpadBounds>) {
    (
        req.slam_origin_px.unwrap_or(LEGACY_PORTRAIT_SLAM_ORIGIN),
        None,
    )
}

/// F1 (Round 2 Phase 3): the single call into `slam_to_corner`'s own
/// `verify_motion` — nothing left for `anchor_cursor` to reimplement.
async fn run_slam(
    req: &AnchorRequest,
    corner: Corner,
    verify_motion: bool,
    bounds_hint: Option<IpadBounds>,
) -> anyhow::Result<Option<SlamMotionCheck>> {
    Ok(slam_to_corner(
        &req.client,
        SlamOptions {
            calls: req.slam_calls,
            pace_ms: req.pace_ms,
            corner: Some(corner),
            verbose: req.verbose,
            verify_motion,
            screenshot: Some(req.screenshot),
            bounds_hint: Some(bounds_hint),
            ..Default::default()
        },
    )
    .await?)
}

pub(crate) enum KeySequence {
    Unlock,
    Defensive,
}

/// Adapts `Arc<PiKVMClient>` into `ipad_keys.rs`'s closure-DI shape. See
/// this file's header doc for why `AnchorRequest.client` is an `Arc` in the
/// first place. `pub(crate)`: `ipad_unlock.rs` (this crate) needs the exact
/// same adaptation for its own key-sequence recovery calls — reused rather
/// than duplicated.
pub(crate) async fn run_key_sequence(
    client: &Arc<PiKVMClient>,
    which: KeySequence,
) -> anyhow::Result<()> {
    let client_for_key = client.clone();
    let send_key = move |k: &'static str| -> BoxFuture<'static, anyhow::Result<()>> {
        let client = client_for_key.clone();
        Box::pin(async move { client.send_key(k, None).await.map_err(anyhow::Error::from) })
    };
    let sleep = |ms: u64| -> BoxFuture<'static, ()> {
        Box::pin(async move { tokio::time::sleep(Duration::from_millis(ms)).await })
    };
    match which {
        KeySequence::Unlock => ipad_unlock_key_sequence(&send_key, &sleep).await,
        KeySequence::Defensive => ipad_defensive_keys(&send_key, &sleep).await,
    }
}

pub async fn anchor_cursor(req: AnchorRequest) -> anyhow::Result<AnchorResult> {
    let corner = req.corner.unwrap_or(Corner::TopLeft);
    let capture_verification = req.capture_verification;
    // F6 (Round 2 Phase 5c): selfGate + the old {kind:...} recovery object
    // collapsed into one posture enum. REQUIRED, no default, same
    // discipline as `guard`.
    let recovery = req.recovery;

    let (origin, bounds) = match &req.guard {
        AnchorGuard::BoundsGuard {
            allow_on_undetermined,
        } => resolve_bounds_guard_origin(&req, *allow_on_undetermined).await?,
        AnchorGuard::CallerAsserted { .. } => resolve_caller_asserted_origin(&req).await,
        AnchorGuard::NoneCalibration => resolve_calibration_origin(&req),
    };

    let mut verified: Option<bool> = None;
    let mut recovery_attempted = false;

    if !capture_verification {
        run_slam(&req, corner, false, None).await?;
    } else {
        // Bounds for the verification corner target: reuse whatever the
        // guard resolution already detected (zero extra cost for
        // bounds-guard/caller-asserted callers that didn't supply an
        // explicit slam_origin_px). Otherwise best-effort cache-first/
        // fresh-detect — `measureCell`'s none-calibration guard never
        // detects for origin purposes, but verification still needs real
        // bounds when the target IS a real letterboxed iPad (see
        // `corner_target_from_bounds`'s doc: the P0 bug this fixes was
        // found via exactly this call path). Never errors.
        let verification_bounds = match bounds {
            Some(b) => Some(b),
            None => match get_last_good_bounds() {
                Some(b) => Some(b),
                None => anchor_detect_bounds_or_null(&req).await,
            },
        };
        let check = run_slam(&req, corner, true, verification_bounds).await?;
        verified = Some(check.map(|c| c.verified).unwrap_or(false));

        if verified == Some(false) && recovery != AnchorRecoveryPosture::InspectOnly {
            match recovery {
                AnchorRecoveryPosture::Throw => {
                    anyhow::bail!(
                        "anchorCursor: slam motion did not verify (guard={}) and recovery:'throw' \
                         (the default). Pass recovery:'key-sequence-retry' / 'defensive-keys', or 'inspect-only' \
                         to handle this yourself.",
                        guard_kind_label(&req.guard)
                    );
                }
                AnchorRecoveryPosture::KeySequenceRetry => {
                    recovery_attempted = true;
                    // unlockIpad's existing retry (see ipad_keys.rs's
                    // ipad_unlock_key_sequence for the full rationale),
                    // then re-attempt the slam+verify once.
                    if req.verbose {
                        eprintln!(
                            "[cursor-anchor] slam motion not verified — retrying via key sequence before re-slamming"
                        );
                    }
                    run_key_sequence(&req.client, KeySequence::Unlock).await?;
                    let retry_check = run_slam(&req, corner, true, verification_bounds).await?;
                    verified = Some(retry_check.map(|c| c.verified).unwrap_or(false));
                }
                AnchorRecoveryPosture::DefensiveKeys => {
                    recovery_attempted = true;
                    // ipadGoHome's Phase-231 belt-and-suspenders (see
                    // ipad_keys.rs's ipad_defensive_keys for the full
                    // rationale) — no re-attempt, caller inspects the
                    // returned screenshot itself.
                    if req.verbose {
                        eprintln!(
                            "[cursor-anchor] slam motion not verified — sending defensive Esc+Enter"
                        );
                    }
                    run_key_sequence(&req.client, KeySequence::Defensive).await?;
                }
                AnchorRecoveryPosture::InspectOnly => {
                    unreachable!("gated above by `recovery != AnchorRecoveryPosture::InspectOnly`")
                }
            }
        }
    }

    // Skip the nudge when verification was attempted and ultimately failed
    // (even after recovery, if any ran) — nudging the cursor away from an
    // already-failed slam wastes real HID calls on a measurement/position
    // the caller is about to reject anyway. `measureCell` relies on this:
    // its pre-migration code only ever called `nudgeFromEdge` after its
    // own early-return check passed.
    if let Some(nudge) = req.nudge {
        if verified != Some(false) {
            nudge_from_edge(
                &req.client,
                NudgeOptions {
                    away: nudge.away,
                    only_axis: nudge.only_axis,
                    verbose: req.verbose,
                    ..Default::default()
                },
            )
            .await?;
        }
    }

    Ok(AnchorResult {
        origin,
        verified,
        recovery_attempted,
        bounds,
    })
}

#[cfg(test)]
mod tests;
