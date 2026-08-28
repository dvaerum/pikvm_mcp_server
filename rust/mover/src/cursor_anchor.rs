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

enum KeySequence {
    Unlock,
    Defensive,
}

/// Adapts `Arc<PiKVMClient>` into `ipad_keys.rs`'s closure-DI shape. See
/// this file's header doc for why `AnchorRequest.client` is an `Arc` in the
/// first place.
async fn run_key_sequence(client: &Arc<PiKVMClient>, which: KeySequence) -> anyhow::Result<()> {
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
mod tests {
    use super::*;
    use pikvm_mcp_detection_vision::orientation::{
        clear_orientation_cache, detect_ipad_bounds_from_buffer,
    };
    use pikvm_mcp_kvmd_client::client::{
        ClientError, PiKVMConfig, RequestArgs, RequestFn, ResponseBody,
    };
    use std::sync::Mutex as StdMutex;

    // slam_to_corner (called by every test here) touches the same
    // process-global emit_clock and orientation bounds cache slam.rs's and
    // cursor_keepalive.rs's own tests touch — serialize against the
    // crate-wide lock, not a file-local one. See
    // `crate::test_support::GLOBAL_STATE_LOCK`'s doc for why a per-file
    // lock silently fails to do this.
    use crate::test_support::GLOBAL_STATE_LOCK as TEST_LOCK;

    type Moves = Arc<StdMutex<Vec<(f64, f64)>>>;
    type Keys = Arc<StdMutex<Vec<String>>>;
    type ShotCalls = Arc<StdMutex<usize>>;

    fn parse_delta(path: &str) -> (f64, f64) {
        let mut dx = 0.0;
        let mut dy = 0.0;
        for pair in path.split('?').nth(1).unwrap_or("").split('&') {
            if let Some(v) = pair.strip_prefix("delta_x=") {
                dx = v.parse().unwrap();
            } else if let Some(v) = pair.strip_prefix("delta_y=") {
                dy = v.parse().unwrap();
            }
        }
        (dx, dy)
    }

    fn parse_key(path: &str) -> String {
        path.split('?')
            .nth(1)
            .unwrap_or("")
            .split('&')
            .find_map(|p| p.strip_prefix("key="))
            .unwrap_or("")
            .to_string()
    }

    /// Unlike cursor-anchor.test.ts's `mockClientAndScreenshot` (which mocks
    /// bounds-detection's `client.screenshot()` and the verification
    /// `req.screenshot` closure as two INDEPENDENT frame streams/counters),
    /// this port's `AnchorRequest.screenshot` is a `ScreenshotMode` that
    /// resolves to the SAME `PiKVMClient::screenshot`/
    /// `screenshot_keeping_cursor_alive` calls bounds detection also uses —
    /// there's only one real HTTP endpoint either way. So `screenshots`
    /// here is a SINGLE ordered sequence covering every real
    /// `client.screenshot()`-family call in a test, bounds-detection and
    /// verification alike, traced call-by-call against `anchor_cursor`'s
    /// and `slam_to_corner`'s actual code paths (see each test's own
    /// comment for its trace). An empty `screenshots` list makes the
    /// `/streamer/snapshot` stub error instead of panicking, matching the
    /// TS mock's own behavior when its `boundsFrames` defaults to `[]`
    /// (indexing `undefined`, caught by `detectBoundsOrNull`'s try/catch).
    fn stub_client(
        resolution: (u32, u32),
        screenshots: Vec<Vec<u8>>,
    ) -> (Arc<PiKVMClient>, Moves, Keys, ShotCalls) {
        let (w, h) = resolution;
        let moves: Moves = Arc::new(StdMutex::new(Vec::new()));
        let moves_bg = moves.clone();
        let keys: Keys = Arc::new(StdMutex::new(Vec::new()));
        let keys_bg = keys.clone();
        let shot_calls: ShotCalls = Arc::new(StdMutex::new(0));
        let shot_calls_bg = shot_calls.clone();
        let screenshots = Arc::new(screenshots);
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let moves = moves_bg.clone();
            let keys = keys_bg.clone();
            let shot_calls = shot_calls_bg.clone();
            let screenshots = screenshots.clone();
            Box::pin(async move {
                if args.path.starts_with("/hid/events/send_mouse_relative") {
                    moves.lock().unwrap().push(parse_delta(&args.path));
                    return Ok(ResponseBody::Empty);
                }
                if args.path.starts_with("/hid/events/send_key") {
                    keys.lock().unwrap().push(parse_key(&args.path));
                    return Ok(ResponseBody::Empty);
                }
                if args.path.starts_with("/streamer/snapshot") {
                    let mut i = shot_calls.lock().unwrap();
                    if screenshots.is_empty() {
                        *i += 1;
                        return Err(ClientError::Other(
                            "no screenshot frame configured for this test".to_string(),
                        ));
                    }
                    let idx = (*i).min(screenshots.len() - 1);
                    *i += 1;
                    return Ok(ResponseBody::Image(screenshots[idx].clone()));
                }
                if args.path == "/streamer" {
                    return Ok(ResponseBody::Json(serde_json::json!({
                        "ok": true,
                        "result": { "streamer": { "source": { "online": true, "resolution": { "width": w, "height": h } } } }
                    })));
                }
                Ok(ResponseBody::Empty)
            })
        });
        // 127.0.0.1 on a reserved/closed port, not "mock.local" — same
        // reasoning as slam.rs's stub_client.
        let client = Arc::new(PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
            None,
            request_fn,
        ));
        (client, moves, keys, shot_calls)
    }

    fn jpeg_encode(rgb: &[u8], w: u32, h: u32) -> Vec<u8> {
        let img: image::RgbImage = image::ImageBuffer::from_raw(w, h, rgb.to_vec()).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
        encoder.encode_image(&img).unwrap();
        buf
    }

    fn solid_jpeg(w: u32, h: u32, fill: [u8; 3]) -> Vec<u8> {
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
        for i in 0..(w as usize) * (h as usize) {
            buf[i * 3] = fill[0];
            buf[i * 3 + 1] = fill[1];
            buf[i * 3 + 2] = fill[2];
        }
        jpeg_encode(&buf, w, h)
    }

    fn decode_rgb(jpeg: &[u8]) -> Vec<u8> {
        image::load_from_memory(jpeg).unwrap().to_rgb8().into_raw()
    }

    fn stamp_square(
        base_rgb: &[u8],
        w: u32,
        h: u32,
        cx: i64,
        cy: i64,
        size: i64,
        colour: [u8; 3],
    ) -> Vec<u8> {
        let mut buf = base_rgb.to_vec();
        let half = size / 2;
        for y in (cy - half)..=(cy + half) {
            if y < 0 || y >= h as i64 {
                continue;
            }
            for x in (cx - half)..=(cx + half) {
                if x < 0 || x >= w as i64 {
                    continue;
                }
                let i = ((y as u32 * w + x as u32) as usize) * 3;
                buf[i] = colour[0];
                buf[i + 1] = colour[1];
                buf[i + 2] = colour[2];
            }
        }
        buf
    }

    /// An iPad-portrait letterbox frame: black bars outside the content
    /// region, bright grey inside. Same construction as slam.rs's own
    /// `make_ipad_portrait_frame` (and the TS test's `makeIpadPortraitFrame`).
    fn make_ipad_portrait_frame() -> Vec<u8> {
        let (w, h) = (1920u32, 1080u32);
        let mut data = vec![0u8; (w as usize) * (h as usize) * 3];
        let (ipad_x0, ipad_x1) = (625i64, 1295i64);
        for y in 0..h as i64 {
            for x in ipad_x0..=ipad_x1 {
                let i = ((y as u32 * w + x as u32) as usize) * 3;
                data[i] = 200;
                data[i + 1] = 200;
                data[i + 2] = 200;
            }
        }
        jpeg_encode(&data, w, h)
    }

    /// A landscape-ish "iPad content" frame — bright content the full frame
    /// width, which the bounds detector reads as landscape orientation
    /// (knownNonIpad).
    fn make_landscape_frame() -> Vec<u8> {
        solid_jpeg(1920, 1080, [200, 200, 200])
    }

    fn default_req(client: Arc<PiKVMClient>, guard: AnchorGuard) -> AnchorRequest {
        AnchorRequest {
            client,
            corner: None,
            guard,
            screenshot: ScreenshotMode::Raw,
            capture_verification: false,
            recovery: AnchorRecoveryPosture::InspectOnly,
            nudge: None,
            pace_ms: Some(0),
            slam_origin_px: None,
            verbose: false,
        }
    }

    mod bounds_guard {
        use super::*;

        #[tokio::test]
        async fn throws_the_byte_identical_error_when_bounds_detection_fails_undetermined_target() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![black]);
            let err = anchor_cursor(default_req(
                client,
                AnchorGuard::BoundsGuard {
                    allow_on_undetermined: false,
                },
            ))
            .await
            .unwrap_err();
            assert_eq!(
                err.to_string(),
                "moveToPixel: refusing slam-then-move — target type undetermined \
                 (bounds detection failed — frame too dark or unrecognised) and \
                 slam-origin defaulted to LEGACY_PORTRAIT, which presumes iPad. \
                 Slam-to-corner on an iPad triggers the iPadOS hot-corner gesture and \
                 re-locks the screen mid-session. Options: \
                 (1) use strategy='detect-then-move' (recommended for iPad), \
                 (2) pass slamOriginPx explicitly if you know the target is non-iPad, \
                 (3) pass forbidSlamOnIpad=false to opt out (only safe if iPad \
                 hot-corners are disabled)."
            );
            assert!(moves.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn throws_when_an_ipad_portrait_letterbox_is_detected() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let portrait = make_ipad_portrait_frame();
            let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![portrait]);
            let err = anchor_cursor(default_req(
                client,
                AnchorGuard::BoundsGuard {
                    allow_on_undetermined: false,
                },
            ))
            .await
            .unwrap_err();
            assert!(err.to_string().contains("iPad-portrait letterbox detected"));
            assert!(moves.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn does_not_throw_when_bounds_are_detected_as_landscape_known_non_ipad() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let landscape = make_landscape_frame();
            let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![landscape]);
            let result = anchor_cursor(default_req(
                client,
                AnchorGuard::BoundsGuard {
                    allow_on_undetermined: false,
                },
            ))
            .await
            .unwrap();
            assert!(!moves.lock().unwrap().is_empty());
            assert_eq!(
                result.bounds.map(|b| b.orientation),
                Some(IpadOrientation::Landscape)
            );
        }

        #[tokio::test]
        async fn does_not_throw_when_the_caller_passes_an_explicit_slam_origin_px() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![black]);
            let mut req = default_req(
                client,
                AnchorGuard::BoundsGuard {
                    allow_on_undetermined: false,
                },
            );
            req.slam_origin_px = Some((50, 50));
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.origin, (50, 50));
            assert!(!moves.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn allow_on_undetermined_true_skips_the_refusal_but_keeps_the_same_origin_computation(
        ) {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![black]);
            let result = anchor_cursor(default_req(
                client,
                AnchorGuard::BoundsGuard {
                    allow_on_undetermined: true,
                },
            ))
            .await
            .unwrap();
            // Bounds detection failed → falls back to LEGACY_PORTRAIT_SLAM_ORIGIN,
            // same as the always-refuse path would have computed had it not thrown.
            assert_eq!(result.origin, LEGACY_PORTRAIT_SLAM_ORIGIN);
            assert!(!moves.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn capture_verification_defaults_false_zero_verification_screenshots_taken() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let landscape = make_landscape_frame();
            let (client, _moves, _keys, shots) = stub_client((1920, 1080), vec![landscape]);
            let result = anchor_cursor(default_req(
                client,
                AnchorGuard::BoundsGuard {
                    allow_on_undetermined: false,
                },
            ))
            .await
            .unwrap();
            // Exactly the one bounds-detection screenshot the guard itself
            // took — slam_to_corner never calls take_screenshot when
            // verify_motion is false.
            assert_eq!(*shots.lock().unwrap(), 1);
            assert_eq!(result.verified, None);
            assert!(!result.recovery_attempted);
        }
    }

    mod caller_asserted_unset {
        use super::*;

        #[tokio::test]
        async fn never_throws_even_against_an_undetermined_black_frame() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(1920, 1080, [0, 0, 0]);
            let (client, moves, _keys, _shots) = stub_client((1920, 1080), vec![black]);
            let result = anchor_cursor(default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "lock screen has no active hot corner".to_string(),
                },
            ))
            .await
            .unwrap();
            assert_eq!(result.verified, None);
            assert!(!moves.lock().unwrap().is_empty());
        }
    }

    mod caller_asserted_recovery_throw {
        use super::*;

        #[tokio::test]
        async fn throws_when_verification_fails_and_recovery_is_explicitly_throw() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let frozen = solid_jpeg(400, 300, [50, 50, 50]);
            // Trace: (1) resolve_caller_asserted_origin's own detect — black,
            // fails. (2) anchor_cursor's verification_bounds re-detect
            // (resolved.bounds still None, cache still empty) — black again,
            // fails. (3)/(4) slam_to_corner's before/after verify capture —
            // identical frozen frames, no diff.
            let (client, _moves, keys, _shots) = stub_client(
                (400, 300),
                vec![black.clone(), black, frozen.clone(), frozen],
            );
            let mut req = default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "test".to_string(),
                },
            );
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::Throw;
            let err = anchor_cursor(req).await.unwrap_err();
            assert!(err.to_string().contains("slam motion did not verify"));
            assert!(err.to_string().contains("recovery:'throw'"));
            assert!(keys.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn does_not_throw_when_verification_succeeds() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let before_rgb = vec![50u8; 400 * 300 * 3];
            let after_rgb = stamp_square(&before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
            let before = jpeg_encode(&before_rgb, 400, 300);
            let after = jpeg_encode(&after_rgb, 400, 300);
            let (client, _moves, _keys, _shots) =
                stub_client((400, 300), vec![black.clone(), black, before, after]);
            let mut req = default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "test".to_string(),
                },
            );
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::Throw;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(true));
            assert!(!result.recovery_attempted);
        }
    }

    mod caller_asserted_recovery_key_sequence_retry {
        use super::*;

        #[tokio::test]
        async fn verified_true_on_the_first_attempt_no_recovery_no_key_presses() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let before_rgb = vec![50u8; 400 * 300 * 3];
            let after_rgb = stamp_square(&before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
            let before = jpeg_encode(&before_rgb, 400, 300);
            let after = jpeg_encode(&after_rgb, 400, 300);
            let (client, _moves, keys, _shots) =
                stub_client((400, 300), vec![black.clone(), black, before, after]);
            let mut req = default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "test".to_string(),
                },
            );
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::KeySequenceRetry;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(true));
            assert!(!result.recovery_attempted);
            assert!(keys.lock().unwrap().is_empty());
        }

        /// Real ~1.2s wall-clock delay: `ipad_unlock_key_sequence`'s pacing
        /// (200/600/400ms) is un-injected here, matching cursor-anchor.ts's
        /// own un-mocked `sleep` import — the TS test suite pays the same
        /// real delay (no fake timers in cursor-anchor.test.ts).
        #[tokio::test]
        async fn recovers_when_the_retry_succeeds_esc_enter_space_then_re_slam_re_verify() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let frozen = solid_jpeg(400, 300, [50, 50, 50]);
            let retry_before_rgb = vec![60u8; 400 * 300 * 3];
            let retry_after_rgb =
                stamp_square(&retry_before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
            let retry_before = jpeg_encode(&retry_before_rgb, 400, 300);
            let retry_after = jpeg_encode(&retry_after_rgb, 400, 300);
            let (client, _moves, keys, _shots) = stub_client(
                (400, 300),
                vec![
                    black.clone(),
                    black,
                    frozen.clone(),
                    frozen,
                    retry_before,
                    retry_after,
                ],
            );
            let mut req = default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "test".to_string(),
                },
            );
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::KeySequenceRetry;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(true));
            assert!(result.recovery_attempted);
            assert_eq!(
                *keys.lock().unwrap(),
                vec![
                    "Escape".to_string(),
                    "Enter".to_string(),
                    "Space".to_string()
                ]
            );
        }

        #[tokio::test]
        async fn does_not_throw_even_when_the_retry_also_fails_to_verify() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let frozen = solid_jpeg(400, 300, [50, 50, 50]);
            let (client, _moves, keys, _shots) = stub_client(
                (400, 300),
                vec![
                    black.clone(),
                    black,
                    frozen.clone(),
                    frozen.clone(),
                    frozen.clone(),
                    frozen,
                ],
            );
            let mut req = default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "test".to_string(),
                },
            );
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::KeySequenceRetry;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(false));
            assert!(result.recovery_attempted);
            assert_eq!(
                *keys.lock().unwrap(),
                vec![
                    "Escape".to_string(),
                    "Enter".to_string(),
                    "Space".to_string()
                ]
            );
        }
    }

    mod caller_asserted_recovery_defensive_keys {
        use super::*;

        #[tokio::test]
        async fn sends_esc_enter_once_on_a_failed_verification_no_re_slam_no_throw() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let frozen = solid_jpeg(400, 300, [50, 50, 50]);
            let (client, _moves, keys, shots) = stub_client(
                (400, 300),
                vec![black.clone(), black, frozen.clone(), frozen],
            );
            let mut req = default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "test".to_string(),
                },
            );
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::DefensiveKeys;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(false));
            assert!(result.recovery_attempted);
            assert_eq!(
                *keys.lock().unwrap(),
                vec!["Escape".to_string(), "Enter".to_string()]
            );
            // No re-attempt: exactly the 2 bounds-detection + 2 verify
            // screenshot calls this trace expects, nothing more.
            assert_eq!(*shots.lock().unwrap(), 4);
        }

        #[tokio::test]
        async fn does_not_run_recovery_when_verification_succeeds() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let before_rgb = vec![50u8; 400 * 300 * 3];
            let after_rgb = stamp_square(&before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
            let before = jpeg_encode(&before_rgb, 400, 300);
            let after = jpeg_encode(&after_rgb, 400, 300);
            let (client, _moves, keys, _shots) =
                stub_client((400, 300), vec![black.clone(), black, before, after]);
            let mut req = default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "test".to_string(),
                },
            );
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::DefensiveKeys;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(true));
            assert!(!result.recovery_attempted);
            assert!(keys.lock().unwrap().is_empty());
        }
    }

    mod caller_asserted_recovery_inspect_only {
        use super::*;

        #[tokio::test]
        async fn verified_is_still_populated_on_failure_but_no_recovery_runs_and_no_throw() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let frozen = solid_jpeg(400, 300, [50, 50, 50]);
            let (client, _moves, keys, _shots) = stub_client(
                (400, 300),
                vec![black.clone(), black, frozen.clone(), frozen],
            );
            let mut req = default_req(
                client,
                AnchorGuard::CallerAsserted {
                    reason: "test".to_string(),
                },
            );
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::InspectOnly;
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(false));
            assert!(!result.recovery_attempted);
            assert!(keys.lock().unwrap().is_empty());
        }
    }

    mod none_calibration {
        use super::*;

        #[tokio::test]
        async fn never_screenshots_for_verification_when_capture_verification_is_unset() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, moves, _keys, shots) = stub_client((400, 300), vec![]);
            let result = anchor_cursor(default_req(client, AnchorGuard::NoneCalibration))
                .await
                .unwrap();
            assert_eq!(*shots.lock().unwrap(), 0);
            assert_eq!(result.verified, None);
            assert!(result.bounds.is_none());
            // The bare slam still ran.
            assert!(!moves.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn never_throws_regardless_of_what_a_screenshot_fn_would_show() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, _moves, _keys, _shots) = stub_client((400, 300), vec![]);
            anchor_cursor(default_req(client, AnchorGuard::NoneCalibration))
                .await
                .unwrap();
        }

        #[tokio::test]
        async fn runs_the_post_slam_nudge_when_requested() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, moves, _keys, _shots) = stub_client((400, 300), vec![]);
            let mut req = default_req(client, AnchorGuard::NoneCalibration);
            req.nudge = Some(AnchorNudge {
                away: Some(Corner::TopLeft),
                only_axis: Some(Axis::Y),
            });
            anchor_cursor(req).await.unwrap();
            // nudge_from_edge's default 5 calls, all in +y (away from
            // top-left, only_axis:Y zeroes dx) — on top of the slam's own
            // moves.
            let nudge_moves: Vec<_> = moves
                .lock()
                .unwrap()
                .iter()
                .filter(|(dx, dy)| *dx == 0.0 && *dy > 0.0)
                .copied()
                .collect();
            assert_eq!(nudge_moves.len(), 5);
        }

        #[tokio::test]
        async fn skips_the_nudge_when_omitted() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let (client, moves, _keys, _shots) = stub_client((400, 300), vec![]);
            anchor_cursor(default_req(client, AnchorGuard::NoneCalibration))
                .await
                .unwrap();
            let nudge_moves: Vec<_> = moves
                .lock()
                .unwrap()
                .iter()
                .filter(|(dx, dy)| *dx == 0.0 && *dy > 0.0)
                .copied()
                .collect();
            assert_eq!(nudge_moves.len(), 0);
        }

        // Regression: the nudge used to run unconditionally after the
        // verify/recovery block, even when verification had just failed —
        // wastes real HID calls nudging the cursor away from a slam the
        // caller is about to reject anyway (measureCell's exact combo).
        #[tokio::test]
        async fn skips_the_nudge_when_capture_verification_fails_even_with_inspect_only() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let frozen = solid_jpeg(400, 300, [50, 50, 50]);
            // Trace: resolve_calibration_origin makes no client calls
            // (bounds always None from it) → anchor_cursor's
            // verification_bounds fallback detects fresh (black, fails) →
            // slam_to_corner's before/after verify capture (frozen, frozen,
            // no diff).
            let (client, moves, _keys, _shots) =
                stub_client((400, 300), vec![black, frozen.clone(), frozen]);
            let mut req = default_req(client, AnchorGuard::NoneCalibration);
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::InspectOnly;
            req.nudge = Some(AnchorNudge {
                away: Some(Corner::TopLeft),
                only_axis: Some(Axis::Y),
            });
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(false));
            let nudge_moves: Vec<_> = moves
                .lock()
                .unwrap()
                .iter()
                .filter(|(dx, dy)| *dx == 0.0 && *dy > 0.0)
                .copied()
                .collect();
            assert_eq!(nudge_moves.len(), 0);
        }

        #[tokio::test]
        async fn still_runs_the_nudge_when_capture_verification_succeeds() {
            let _guard = TEST_LOCK.lock().await;
            clear_orientation_cache();
            let black = solid_jpeg(400, 300, [0, 0, 0]);
            let before_rgb = vec![50u8; 400 * 300 * 3];
            let after_rgb = stamp_square(&before_rgb, 400, 300, 5, 5, 10, [255, 255, 255]);
            let before = jpeg_encode(&before_rgb, 400, 300);
            let after = jpeg_encode(&after_rgb, 400, 300);
            let (client, moves, _keys, _shots) =
                stub_client((400, 300), vec![black, before, after]);
            let mut req = default_req(client, AnchorGuard::NoneCalibration);
            req.capture_verification = true;
            req.recovery = AnchorRecoveryPosture::InspectOnly;
            req.nudge = Some(AnchorNudge {
                away: Some(Corner::TopLeft),
                only_axis: Some(Axis::Y),
            });
            let result = anchor_cursor(req).await.unwrap();
            assert_eq!(result.verified, Some(true));
            let nudge_moves: Vec<_> = moves
                .lock()
                .unwrap()
                .iter()
                .filter(|(dx, dy)| *dx == 0.0 && *dy > 0.0)
                .copied()
                .collect();
            assert_eq!(nudge_moves.len(), 5);
        }

        /// 2026-08-24 P0 fix regression pair (georgs-mac-mini's PR #68 gate,
        /// live-confirmed on real hardware): `guard: NoneCalibration` skips
        /// bounds detection for ORIGIN purposes, but verification still
        /// needs the iPad's real bounds when the target IS a letterboxed
        /// iPad. Before the fix, `anchor_cursor` compared against the raw
        /// capture-frame corner (0,0) regardless — inside the black
        /// letterbox bar, never where the cursor can physically land.
        mod corner_target_from_bounds_fix {
            use super::*;

            #[tokio::test]
            async fn verified_true_when_the_cluster_lands_at_the_ipads_own_detected_letterbox_corner(
            ) {
                let _guard = TEST_LOCK.lock().await;
                clear_orientation_cache();
                let portrait = make_ipad_portrait_frame();
                let bounds =
                    detect_ipad_bounds_from_buffer(&portrait, DetectOptions::default()).unwrap();
                assert!(bounds.x > 100);
                let portrait_rgb = decode_rgb(&portrait);
                let after_rgb = stamp_square(
                    &portrait_rgb,
                    1920,
                    1080,
                    bounds.x as i64 + 5,
                    bounds.y as i64 + 5,
                    10,
                    [255, 255, 255],
                );
                let after = jpeg_encode(&after_rgb, 1920, 1080);
                // Trace: the `detect_ipad_bounds_from_buffer` call just above
                // (used to learn `bounds.x`/`.y` for stamping) already
                // populates `LAST_GOOD_BOUNDS` as a side effect, so
                // `anchor_cursor`'s own verification_bounds lookup is a
                // cache HIT (`get_last_good_bounds()`), not a fresh detect —
                // no extra screenshot call. Only slam_to_corner's own
                // before/after verify capture touches the client: portrait
                // (unstamped) then the stamped frame. Same reasoning as
                // slam.rs's own analogous test (2 frames, not 3).
                let (client, _moves, _keys, _shots) =
                    stub_client((1920, 1080), vec![portrait, after]);
                let mut req = default_req(client, AnchorGuard::NoneCalibration);
                req.capture_verification = true;
                req.recovery = AnchorRecoveryPosture::InspectOnly;
                let result = anchor_cursor(req).await.unwrap();
                assert_eq!(result.verified, Some(true));
            }

            #[tokio::test]
            async fn verified_false_when_the_cluster_lands_at_the_raw_frame_corner_inside_the_letterbox_bar(
            ) {
                let _guard = TEST_LOCK.lock().await;
                clear_orientation_cache();
                let portrait = make_ipad_portrait_frame();
                let bounds =
                    detect_ipad_bounds_from_buffer(&portrait, DetectOptions::default()).unwrap();
                assert!(bounds.x > 100);
                let portrait_rgb = decode_rgb(&portrait);
                let after_rgb = stamp_square(&portrait_rgb, 1920, 1080, 5, 5, 10, [255, 255, 255]); // raw-frame (0,0) corner
                let after = jpeg_encode(&after_rgb, 1920, 1080);
                // Same cache-hit reasoning as the positive-control test
                // above — only 2 real screenshot calls (slam's before/after).
                let (client, _moves, _keys, _shots) =
                    stub_client((1920, 1080), vec![portrait, after]);
                let mut req = default_req(client, AnchorGuard::NoneCalibration);
                req.capture_verification = true;
                req.recovery = AnchorRecoveryPosture::InspectOnly;
                let result = anchor_cursor(req).await.unwrap();
                assert_eq!(result.verified, Some(false));
            }
        }
    }
}
