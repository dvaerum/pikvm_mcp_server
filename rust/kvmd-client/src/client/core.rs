//! `PiKVMClient`'s core: construction, belief delegation, resource
//! cleanup, and the low-level request/retry plumbing every other
//! `impl PiKVMClient` block (in sibling files) calls through. The struct
//! definition lives here; its fields are `pub(super)` so the sibling
//! `impl` blocks in this directory can reach them directly — same
//! privacy shape as a single big `impl`, just split across files by
//! responsibility.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use pikvm_mcp_cursor_belief::{Bounds as BeliefBounds, CursorBelief, CursorBeliefOptions, Point};

use crate::streamer_keepalive::{StreamerKeepalive, StreamerKeepaliveConfig};

use super::error::ClientError;
use super::request::{
    build_http_client, real_request_fn, HttpMethod, RequestArgs, RequestFn, ResponseBody,
};
use super::types::{CalibrationState, PiKVMConfig, ScreenResolution};

/// Grace window for the streamer idle-stop retry-once: how long to wait
/// between the initial 503/null-streamer response and the single retry,
/// giving kvmd's own stream-controller loop + ustreamer's fork+exec+bind
/// time to finish after the held keepalive WS's connection triggered a
/// (re)start.
const STREAMER_RESTART_GRACE_MS: u64 = 1500;

/// Wake-nudge escalation (`PiKVMConfig::source_online_wake_nudge`, off by
/// default — see docs/streamer-source-online-wake-nudge-plan.md): delta
/// matches `--fallback-mouse-move`'s own already-live-tested nudge in
/// `cursor_anchor_corner_control_smoke.rs`, deliberately NOT the unrelated
/// ±1px net-zero nudge `screenshot_keeping_cursor_alive` uses (that one only
/// keeps an already-awake cursor visible in-frame; it has never been tested
/// as a display-wake event).
const WAKE_NUDGE_DELTA_PX: f64 = 5.0;
/// Settle time after the nudge before the final retry — matches the
/// corner-control harness's own post-wake settle window.
const WAKE_NUDGE_SETTLE_MS: u64 = 1500;

/// v2 escalation (docs/streamer-source-online-wake-nudge-plan.md): a
/// keypress reliably revives `source.online` (confirmed live, multiple
/// times); the only reason it isn't the default nudge is the lock-
/// screen's own documented two-stage wake-then-dismiss state machine —
/// a SECOND keyboard key sent while the first stage is still active
/// advances it, which is unsafe to risk blind. This client can't see the
/// screen during the exact outage it's trying to recover from (that's
/// the definition of the failure), so screen state can't be the gate.
/// The tractable proxy instead: how long since THIS client last sent a
/// keyboard key. Tonight's own live evidence (`docs/allow-access-when-
/// locked-keyboard-check-plan.md`'s two attempts) showed a second Space
/// sent after a real gap exceeding this project's own documented
/// ~10-12s wake/redraw window registers as a FRESH wake, not a
/// continuation — so a quiet window comfortably past that resets the
/// state machine back to safe-to-wake. `N=2` evidence, not a proven
/// constant — deliberately wide margin, flagged for its own live
/// verification.
const KEYBOARD_WAKE_QUIET_WINDOW_MS: u64 = 20_000;

/// The client's default `CursorBelief` (wide initial variance + wide
/// bounds so `predict()` can't drift off-screen before orientation sets
/// real bounds). Shared by the client's own-belief fallback AND the
/// startup CursorLocator (once module 3 lands) so the injected and
/// default beliefs are byte-identical.
pub fn create_default_belief() -> CursorBelief {
    CursorBelief::new(CursorBeliefOptions {
        initial_position_variance: Some(10000.0), // wide — caller should reset on first known position
        bounds: Some(BeliefBounds {
            x: 0.0,
            y: 0.0,
            width: 4096.0,
            height: 2160.0,
        }),
        ..CursorBeliefOptions::new(Point { x: 0.0, y: 0.0 })
    })
}

pub(super) struct ScreenshotScale {
    pub(super) scale_x: f64,
    pub(super) scale_y: f64,
}

pub struct PiKVMClient {
    pub(super) config: PiKVMConfig,
    pub(super) request_fn: RequestFn,
    pub(super) cached_resolution: Mutex<Option<ScreenResolution>>,
    pub(super) screenshot_scale: Mutex<Option<ScreenshotScale>>,
    pub(super) calibration: Mutex<Option<CalibrationState>>,
    pub(super) streamer_keepalive: StreamerKeepalive,

    /// Single source of truth for the cursor's believed position. Every
    /// successful `mouse_move_relative` calls `belief.predict`. Callers
    /// can push observations via `observe_cursor` and reset belief via
    /// `reset_belief`.
    pub belief: Mutex<CursorBelief>,

    /// When THIS client last sent a keyboard key (`send_key`/
    /// `send_shortcut`), stamped by `send_key` on every call. Per-
    /// instance, deliberately NOT the process-global `emit_clock` (that
    /// module tracks mouse emits only and is shared across every client
    /// instance — the wrong shape for "has THIS client recently sent a
    /// key"). Read by `fetch_snapshot_with_retry`'s v2 escalation via
    /// `keyboard_wake_is_safe` — see
    /// docs/streamer-source-online-wake-nudge-plan.md.
    pub(super) last_keyboard_emit: Mutex<Option<Instant>>,
}

impl PiKVMClient {
    pub fn new(config: PiKVMConfig, belief: Option<CursorBelief>) -> Self {
        let http = build_http_client(config.verify_ssl, config.proxy_url.as_deref());
        let request_fn = real_request_fn(
            http,
            config.host.clone(),
            config.username.clone(),
            config.password.clone(),
        );
        Self::with_request_fn(config, belief, request_fn)
    }

    /// Test seam: construct with an injected [`RequestFn`] instead of the
    /// real networking implementation, bypassing the network entirely —
    /// same role as the TS belief-wiring tests stubbing the private
    /// `request` method.
    pub fn with_request_fn(
        config: PiKVMConfig,
        belief: Option<CursorBelief>,
        request_fn: RequestFn,
    ) -> Self {
        let streamer_keepalive = StreamerKeepalive::new(StreamerKeepaliveConfig {
            host: config.host.clone(),
            username: config.username.clone(),
            password: config.password.clone(),
            verify_ssl: config.verify_ssl,
            proxy_url: config.proxy_url.clone(),
        });
        Self {
            config,
            request_fn,
            cached_resolution: Mutex::new(None),
            screenshot_scale: Mutex::new(None),
            calibration: Mutex::new(None),
            streamer_keepalive,
            belief: Mutex::new(belief.unwrap_or_else(create_default_belief)),
            last_keyboard_emit: Mutex::new(None),
        }
    }

    /// Callers (orientation detection, etc.) push the iPad letterbox
    /// bounds in here so `belief.predict` can clip + inflate.
    pub fn set_belief_bounds(&self, bounds: Option<BeliefBounds>) {
        self.belief.lock().unwrap().bounds = bounds;
    }

    /// Callers push successful cursor detections in. `confidence` ∈
    /// [0, 1]. Pass `reject_stationary: true` to gate the update against
    /// static-feature lock-in. Returns `true` if the belief was actually
    /// updated, `false` if the observation was rejected.
    pub fn observe_cursor(
        &self,
        measurement: Point,
        confidence: f64,
        opts: Option<pikvm_mcp_cursor_belief::ObserveOptions>,
    ) -> bool {
        self.belief
            .lock()
            .unwrap()
            .observe(measurement, confidence, opts)
    }

    /// Pure query — would a measurement at this position be rejected as a
    /// static-feature lock-in?
    pub fn would_reject_as_stationary(
        &self,
        measurement: Point,
        opts: Option<pikvm_mcp_cursor_belief::WouldRejectOptions>,
    ) -> bool {
        self.belief
            .lock()
            .unwrap()
            .would_reject_as_stationary(measurement, opts)
    }

    /// Collapse belief to a known position (post-slam, post-locateCursor
    /// probe, post-template seed).
    pub fn reset_belief(&self, observation: Point) {
        self.belief.lock().unwrap().reset(observation, None);
    }

    /// Close any held resources — tears down the held `/api/ws` connection
    /// and cancels any pending reconnect. A long-lived MCP server process
    /// never calls this in practice; it exists for tests/benches that
    /// construct and discard many clients.
    pub fn close(&self) {
        self.streamer_keepalive.stop();
    }

    /// Whether the held `/api/ws` stream-keepalive connection is currently
    /// connected. Diagnostic-only pass-through to `StreamerKeepalive
    /// ::connected()` — added 2026-08-30 to investigate whether a 503 at
    /// screenshot time correlates with the keepalive being mid-reconnect
    /// (exponential backoff, capped at `RECONNECT_MAX_MS`) rather than a
    /// screenshot-specific issue. See
    /// docs/slam-verify-screenshot-retry-plan.md's before/after-retry
    /// history for the investigation this supports.
    pub fn streamer_keepalive_connected(&self) -> bool {
        self.streamer_keepalive.connected()
    }

    pub(super) async fn request(&self, args: RequestArgs) -> Result<ResponseBody, ClientError> {
        (self.request_fn)(args).await
    }

    /// Fetch `/streamer/snapshot` bytes, absorbing the ustreamer
    /// idle-stop race. `ensure_started()` makes this a true no-op after
    /// the first call in a session.
    pub(super) async fn fetch_snapshot_with_retry(
        &self,
        path: &str,
    ) -> Result<Vec<u8>, ClientError> {
        self.streamer_keepalive.ensure_started().await;
        match self
            .request(RequestArgs {
                method: HttpMethod::Get,
                path: path.to_string(),
                body: None,
            })
            .await
        {
            Ok(ResponseBody::Image(bytes)) => Ok(bytes),
            Ok(_) => Err(ClientError::Other(
                "expected an image response from the streamer snapshot endpoint".into(),
            )),
            Err(err) => {
                if err.api_status() != Some(503) {
                    return Err(err);
                }
                tokio::time::sleep(Duration::from_millis(STREAMER_RESTART_GRACE_MS)).await;
                match self
                    .request(RequestArgs {
                        method: HttpMethod::Get,
                        path: path.to_string(),
                        body: None,
                    })
                    .await
                {
                    Ok(ResponseBody::Image(bytes)) => Ok(bytes),
                    Ok(_) => Err(ClientError::Other(
                        "expected an image response from the streamer snapshot endpoint".into(),
                    )),
                    Err(err2) => {
                        if err2.api_status() != Some(503) {
                            return Err(err2);
                        }
                        if !self.config.source_online_wake_nudge {
                            return Err(streamer_unavailable_error(&err2, false));
                        }
                        // docs/streamer-source-online-wake-nudge-plan.md:
                        // live evidence tonight is that this specific 503
                        // pattern is the iPad's own display needing a real
                        // redraw event, not a connection-bookkeeping race.
                        // v2: a keypress reliably does this (confirmed live,
                        // multiple times) — a mouse-move (v1) mostly doesn't
                        // (also confirmed live). A keypress is unsafe ONLY
                        // when the lock screen's own two-stage wake-then-
                        // dismiss state machine might still be mid-sequence
                        // — this client can't see the screen during the
                        // exact outage it's recovering from, so
                        // `keyboard_wake_is_safe` uses the tractable proxy
                        // instead (how long since THIS client last sent a
                        // keyboard key — see `KEYBOARD_WAKE_QUIET_WINDOW_MS`'s
                        // own doc comment). Falls back to v1's corner-aware
                        // mouse-move nudge when a keypress isn't safe.
                        let keyboard_safe = {
                            let last = *self.last_keyboard_emit.lock().unwrap();
                            keyboard_wake_is_safe(
                                last,
                                Instant::now(),
                                Duration::from_millis(KEYBOARD_WAKE_QUIET_WINDOW_MS),
                            )
                        };
                        // Best-effort: a nudge failure falls through to the
                        // final attempt anyway, same convention as
                        // `screenshot_keeping_cursor_alive`'s `let _ = ...`.
                        if keyboard_safe {
                            let _ = self.send_key("Space", None).await;
                        } else {
                            let (nudge_dx, nudge_dy) = {
                                let belief = self.belief.lock().unwrap();
                                wake_nudge_toward_center(belief.position, belief.bounds)
                            };
                            let _ = self.mouse_move_relative(nudge_dx, nudge_dy).await;
                        }
                        tokio::time::sleep(Duration::from_millis(WAKE_NUDGE_SETTLE_MS)).await;
                        match self
                            .request(RequestArgs {
                                method: HttpMethod::Get,
                                path: path.to_string(),
                                body: None,
                            })
                            .await
                        {
                            Ok(ResponseBody::Image(bytes)) => Ok(bytes),
                            Ok(_) => Err(ClientError::Other(
                                "expected an image response from the streamer snapshot endpoint"
                                    .into(),
                            )),
                            Err(err3) => {
                                if err3.api_status() != Some(503) {
                                    return Err(err3);
                                }
                                Err(streamer_unavailable_error(&err3, true))
                            }
                        }
                    }
                }
            }
        }
    }

    /// Fetch `GET /streamer`'s state, with the SAME idle-stop retry as
    /// `fetch_snapshot_with_retry` — but this endpoint never 503s, it
    /// just reports `streamer: null` while ustreamer isn't running yet.
    pub(super) async fn fetch_streamer_state_with_retry(
        &self,
    ) -> Result<serde_json::Value, ClientError> {
        self.streamer_keepalive.ensure_started().await;
        let first = self.request_json_get("/streamer").await?;
        if streamer_source(&first).is_some() {
            return Ok(first);
        }
        tokio::time::sleep(Duration::from_millis(STREAMER_RESTART_GRACE_MS)).await;
        self.request_json_get("/streamer").await
    }

    pub(super) async fn request_json_get(
        &self,
        path: &str,
    ) -> Result<serde_json::Value, ClientError> {
        match self
            .request(RequestArgs {
                method: HttpMethod::Get,
                path: path.to_string(),
                body: None,
            })
            .await?
        {
            ResponseBody::Json(v) => Ok(v),
            ResponseBody::Empty => Ok(serde_json::json!({})),
            ResponseBody::Image(_) => Err(ClientError::Other(format!(
                "expected JSON from {path}, got an image"
            ))),
        }
    }
}

/// Direction-aware wake-nudge delta: moves `WAKE_NUDGE_DELTA_PX` toward
/// screen center from `position`, using `bounds` to find center — so a
/// cursor parked at (or near) ANY corner nudges away from it, not further
/// into it. `bounds: None` (belief has no known screen bounds yet) falls
/// back to the fixed `(+WAKE_NUDGE_DELTA_PX, +WAKE_NUDGE_DELTA_PX)` —
/// matches `--fallback-mouse-move`'s own validated delta, a reasonable
/// default when there's no bounds to compute a direction from at all, and
/// this exact case is unit-tested below.
fn wake_nudge_toward_center(position: Point, bounds: Option<BeliefBounds>) -> (f64, f64) {
    let Some(bounds) = bounds else {
        return (WAKE_NUDGE_DELTA_PX, WAKE_NUDGE_DELTA_PX);
    };
    let center_x = bounds.x + bounds.width / 2.0;
    let center_y = bounds.y + bounds.height / 2.0;
    let dx = if position.x <= center_x {
        WAKE_NUDGE_DELTA_PX
    } else {
        -WAKE_NUDGE_DELTA_PX
    };
    let dy = if position.y <= center_y {
        WAKE_NUDGE_DELTA_PX
    } else {
        -WAKE_NUDGE_DELTA_PX
    };
    (dx, dy)
}

/// v2 escalation gate: is it safe to send a keyboard wake key right now?
/// Mirrors `streamer_keepalive::liveness::is_stale`'s exact shape and
/// boundary convention (`>`, not `>=`) — `None` (no keyboard key ever
/// sent by this client) is always safe; otherwise safe only once
/// `quiet_window` has fully elapsed since the last one. See
/// `KEYBOARD_WAKE_QUIET_WINDOW_MS`'s own doc comment for why this proxy
/// exists instead of checking screen state directly.
fn keyboard_wake_is_safe(
    last_keyboard_emit: Option<Instant>,
    now: Instant,
    quiet_window: Duration,
) -> bool {
    match last_keyboard_emit {
        None => true,
        Some(last) => now.duration_since(last) > quiet_window,
    }
}

/// Shared `StreamerUnavailable` builder for `fetch_snapshot_with_retry`'s
/// two exit points (nudge disabled/skipped vs. nudge attempted and still
/// 503) — same error text either way except for the one clause noting
/// whether the wake nudge fired, so operator-hints's pattern match and the
/// original 503/UnavailableError text stay identical in both cases.
fn streamer_unavailable_error(err: &ClientError, nudge_attempted: bool) -> ClientError {
    let nudge_clause = if nudge_attempted {
        "a wake nudge (relative mouse move, PiKVMConfig::source_online_wake_nudge) was also \
         tried and did not recover it"
    } else {
        "the wake-nudge escalation is disabled (PiKVMConfig::source_online_wake_nudge)"
    };
    ClientError::StreamerUnavailable(format!(
        "Streamer unavailable even after a held /api/ws stream client and one retry \
         ({STREAMER_RESTART_GRACE_MS}ms grace window): {err} \
         This retry exists specifically to rule out ustreamer's idle-stop race — surviving \
         it means the more likely explanation is a genuine source-side outage. Check \
         pikvm_health_check's streamer.source.online (HDMI cable / iPad off / mid-reboot). \
         ({nudge_clause}.)"
    ))
}

/// `response.result.streamer.source`, threading through the same
/// defensive-null handling as the TS getters (`streamer` is genuinely
/// `null`, not absent, when ustreamer isn't running).
pub(super) fn streamer_source(response: &serde_json::Value) -> Option<&serde_json::Value> {
    response.get("result")?.get("streamer")?.get("source")
}

pub(super) fn parse_resolution(v: &serde_json::Value) -> Option<ScreenResolution> {
    let width = v.get("width")?.as_u64()?;
    let height = v.get("height")?.as_u64()?;
    Some(ScreenResolution {
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::error::PiKVMApiError;
    use crate::client::request::ResponseBody;
    use crate::client::types::{PiKVMConfig, ScreenResolution};
    use std::sync::Arc;

    /// Pins the streamer idle-stop retry-once control flow
    /// (`fetch_snapshot_with_retry` / `fetch_streamer_state_with_retry`):
    /// a 503/null-streamer response followed by a successful retry
    /// recovers; two 503s in a row produce `StreamerUnavailable` (not a
    /// bare `PiKVMApiError`) carrying the original error text so
    /// operator-hints's pattern match still fires.
    ///
    /// Reduced-fidelity relative to `client-streamer-keepalive.test.ts`:
    /// that TS suite runs a REAL loopback HTTP+WS server and asserts on
    /// actual elapsed wall-clock time (steady-state calls pay zero retry
    /// cost) and on the keepalive WS's own connect count/auth headers.
    /// This port instead drives the retry control flow through the
    /// injected `RequestFn` seam — it proves the retry/error-mapping
    /// logic is faithful, but does NOT exercise the real WS race timing
    /// or `StreamerKeepalive`'s wiring end-to-end the way the TS test
    /// does. A real loopback HTTP+WS fixture equivalent to the TS one
    /// is a known gap, not yet ported.
    use std::sync::atomic::{AtomicU32, Ordering};

    fn unavailable_error() -> ClientError {
        ClientError::Api(PiKVMApiError {
            status: 503,
            message: "PiKVM API error 503: UnavailableError: Service Unavailable".to_string(),
        })
    }

    #[tokio::test]
    async fn recovers_via_the_retry_once_when_the_first_snapshot_races_ustreamer() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let calls = calls_c.clone();
            Box::pin(async move {
                if args.path.starts_with("/streamer/snapshot") {
                    let n = calls.fetch_add(1, Ordering::SeqCst);
                    if n == 0 {
                        return Err(unavailable_error());
                    }
                    return Ok(ResponseBody::Image(vec![1, 2, 3]));
                }
                // getResolution's forced refresh — real dims not needed by this assertion.
                Ok(ResponseBody::Json(serde_json::json!({
                    "ok": true,
                    "result": { "streamer": { "source": { "online": true, "resolution": { "width": 4, "height": 4 } } } }
                })))
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://mock.local", "admin", "pw"),
            None,
            request_fn,
        );
        let buf = client
            .fetch_snapshot_with_retry("/streamer/snapshot")
            .await
            .unwrap();
        assert_eq!(buf, vec![1, 2, 3]);
        assert_eq!(calls.load(Ordering::SeqCst), 2); // exactly one retry, no retry-storm
    }

    #[tokio::test]
    async fn negative_control_genuine_failure_raises_streamer_unavailable_not_a_bare_503() {
        let request_fn: RequestFn =
            Arc::new(move |_args: RequestArgs| Box::pin(async move { Err(unavailable_error()) }));
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://mock.local", "admin", "pw"),
            None,
            request_fn,
        );
        let err = client
            .fetch_snapshot_with_retry("/streamer/snapshot")
            .await
            .unwrap_err();
        match err {
            ClientError::StreamerUnavailable(msg) => {
                assert!(msg.contains("held /api/ws stream client and one retry"));
                // The named error still carries the original 503/UnavailableError
                // text so operator-hints.ts's pattern match still fires on it.
                assert!(msg.contains("UnavailableError"));
            }
            other => panic!("expected StreamerUnavailable, got {other:?}"),
        }
    }

    /// nixos-dev review: pins `wake_nudge_toward_center`'s core safety
    /// property — the nudge must move AWAY from whichever corner the
    /// cursor is believed to be at, not a fixed direction that could move
    /// further into a bottom corner's quick-action affordances.
    mod wake_nudge_toward_center_tests {
        use super::*;

        fn bounds() -> BeliefBounds {
            BeliefBounds {
                x: 0.0,
                y: 0.0,
                width: 4096.0,
                height: 2160.0,
            }
        }

        #[test]
        fn from_top_left_nudges_right_and_down_toward_center() {
            let (dx, dy) = wake_nudge_toward_center(Point { x: 0.0, y: 0.0 }, Some(bounds()));
            assert_eq!((dx, dy), (WAKE_NUDGE_DELTA_PX, WAKE_NUDGE_DELTA_PX));
        }

        /// The safety-critical case: from bottom-right (matches
        /// `slam_to_corner`'s `BottomRight` target), the nudge must be
        /// NEGATIVE in both axes — toward center, away from the corner's
        /// quick-action affordances — not the fixed +5,+5 the original
        /// design would have sent regardless of position.
        #[test]
        fn from_bottom_right_nudges_left_and_up_toward_center() {
            let (dx, dy) = wake_nudge_toward_center(
                Point {
                    x: 4090.0,
                    y: 2150.0,
                },
                Some(bounds()),
            );
            assert_eq!((dx, dy), (-WAKE_NUDGE_DELTA_PX, -WAKE_NUDGE_DELTA_PX));
        }

        #[test]
        fn from_bottom_left_nudges_right_and_up_toward_center() {
            let (dx, dy) = wake_nudge_toward_center(Point { x: 5.0, y: 2150.0 }, Some(bounds()));
            assert_eq!((dx, dy), (WAKE_NUDGE_DELTA_PX, -WAKE_NUDGE_DELTA_PX));
        }

        #[test]
        fn from_top_right_nudges_left_and_down_toward_center() {
            let (dx, dy) = wake_nudge_toward_center(Point { x: 4090.0, y: 5.0 }, Some(bounds()));
            assert_eq!((dx, dy), (-WAKE_NUDGE_DELTA_PX, WAKE_NUDGE_DELTA_PX));
        }

        /// No known bounds — falls back to the fixed default rather than
        /// panicking or guessing a direction from nothing.
        #[test]
        fn with_no_bounds_falls_back_to_the_fixed_default() {
            let (dx, dy) = wake_nudge_toward_center(
                Point {
                    x: 4090.0,
                    y: 2150.0,
                },
                None,
            );
            assert_eq!((dx, dy), (WAKE_NUDGE_DELTA_PX, WAKE_NUDGE_DELTA_PX));
        }
    }

    /// Pins `keyboard_wake_is_safe`'s boundary convention (mirrors
    /// `streamer_keepalive::liveness::is_stale`'s own `>`, not `>=`, and
    /// its 5-case shape: none/well-within/at-boundary/just-past/well-past).
    mod keyboard_wake_is_safe_tests {
        use super::*;

        const WINDOW: Duration = Duration::from_millis(20_000);

        #[test]
        fn safe_when_no_keyboard_key_was_ever_sent() {
            assert!(keyboard_wake_is_safe(None, Instant::now(), WINDOW));
        }

        #[test]
        fn not_safe_well_within_the_window() {
            let now = Instant::now();
            let last = now - Duration::from_millis(1_000);
            assert!(!keyboard_wake_is_safe(Some(last), now, WINDOW));
        }

        #[test]
        fn not_safe_exactly_at_the_boundary() {
            let now = Instant::now();
            let last = now - WINDOW;
            assert!(!keyboard_wake_is_safe(Some(last), now, WINDOW));
        }

        #[test]
        fn safe_just_past_the_boundary() {
            let now = Instant::now();
            let last = now - WINDOW - Duration::from_millis(1);
            assert!(keyboard_wake_is_safe(Some(last), now, WINDOW));
        }

        #[test]
        fn safe_well_past_the_window() {
            let now = Instant::now();
            let last = now - Duration::from_millis(60_000);
            assert!(keyboard_wake_is_safe(Some(last), now, WINDOW));
        }
    }

    /// Wiring: `send_key` stamps this client's own `last_keyboard_emit`
    /// clock on every successful call — the v2 escalation's whole gate
    /// depends on this actually happening.
    #[tokio::test]
    async fn send_key_stamps_the_last_keyboard_emit_clock() {
        let request_fn: RequestFn =
            Arc::new(move |_args: RequestArgs| Box::pin(async move { Ok(ResponseBody::Empty) }));
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://mock.local", "admin", "pw"),
            None,
            request_fn,
        );
        assert!(client.last_keyboard_emit.lock().unwrap().is_none());
        client.send_key("Space", None).await.unwrap();
        let stamped = client
            .last_keyboard_emit
            .lock()
            .unwrap()
            .expect("send_key should have stamped last_keyboard_emit");
        assert!(stamped.elapsed() < Duration::from_secs(1));
    }

    /// v2 fallback path: when a keyboard key was sent recently (inside
    /// `KEYBOARD_WAKE_QUIET_WINDOW_MS`), a Space escalation isn't safe —
    /// falls back to v1's corner-aware mouse-move nudge. With the cursor
    /// believed to be at a BottomRight-style corner position, the actual
    /// HID request sent carries negative deltas (moving toward center),
    /// not the corner-agnostic fixed +5,+5. Also pins that NO second
    /// keyboard key is sent in this branch (only the one forced below).
    #[tokio::test]
    async fn wake_nudge_falls_back_to_corner_aware_mouse_move_when_keyboard_is_not_safe() {
        let nudge_deltas = Arc::new(std::sync::Mutex::new(None));
        let key_calls = Arc::new(AtomicU32::new(0));
        let nudge_deltas_c = nudge_deltas.clone();
        let key_calls_c = key_calls.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let nudge_deltas = nudge_deltas_c.clone();
            let key_calls = key_calls_c.clone();
            Box::pin(async move {
                if args.path.starts_with("/streamer/snapshot") {
                    return Err(unavailable_error());
                }
                if args.path.starts_with("/hid/events/send_key") {
                    key_calls.fetch_add(1, Ordering::SeqCst);
                    return Ok(ResponseBody::Empty);
                }
                if let Some(query) = args.path.strip_prefix("/hid/events/send_mouse_relative?") {
                    *nudge_deltas.lock().unwrap() = Some(query.to_string());
                    return Ok(ResponseBody::Empty);
                }
                panic!("unexpected request path in this test: {}", args.path);
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig {
                source_online_wake_nudge: true,
                ..PiKVMConfig::new("http://mock.local", "admin", "pw")
            },
            None,
            request_fn,
        );
        // Default bounds (create_default_belief) are 4096x2160 — anchor the
        // belief near BottomRight, the corner this review specifically
        // flagged.
        client.reset_belief(Point {
            x: 4090.0,
            y: 2150.0,
        });
        // Force the "keyboard not safe" branch: a real key sent moments ago.
        client.send_key("Escape", None).await.unwrap();
        let _ = client.fetch_snapshot_with_retry("/streamer/snapshot").await;
        let query = nudge_deltas
            .lock()
            .unwrap()
            .clone()
            .expect("mouse-move nudge should have fired exactly once");
        assert!(
            query.contains(&format!("delta_x={}", -WAKE_NUDGE_DELTA_PX as i64)),
            "expected a negative delta_x (toward center from BottomRight), got: {query}"
        );
        assert!(
            query.contains(&format!("delta_y={}", -WAKE_NUDGE_DELTA_PX as i64)),
            "expected a negative delta_y (toward center from BottomRight), got: {query}"
        );
        // Exactly one send_key call total — the forced "Escape" above, and
        // NOT a second one from the escalation (which must have used the
        // mouse-move fallback instead).
        assert_eq!(key_calls.load(Ordering::SeqCst), 1);
    }

    /// docs/streamer-source-online-wake-nudge-plan.md v2: with the flag ON
    /// and no recent keyboard activity (the common case — a fresh client),
    /// two consecutive 503s escalate to a Space keypress wake and a THIRD
    /// attempt, which recovers here — exactly one keypress, no retry-storm.
    #[tokio::test]
    async fn wake_nudge_enabled_recovers_via_the_third_attempt_after_a_keyboard_wake() {
        let snapshot_calls = Arc::new(AtomicU32::new(0));
        let key_calls = Arc::new(AtomicU32::new(0));
        let snapshot_calls_c = snapshot_calls.clone();
        let key_calls_c = key_calls.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let snapshot_calls = snapshot_calls_c.clone();
            let key_calls = key_calls_c.clone();
            Box::pin(async move {
                if args.path.starts_with("/streamer/snapshot") {
                    let n = snapshot_calls.fetch_add(1, Ordering::SeqCst);
                    if n < 2 {
                        return Err(unavailable_error());
                    }
                    return Ok(ResponseBody::Image(vec![9, 9, 9]));
                }
                if args.path.starts_with("/hid/events/send_key") {
                    key_calls.fetch_add(1, Ordering::SeqCst);
                    return Ok(ResponseBody::Empty);
                }
                panic!("unexpected request path in this test: {}", args.path);
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig {
                source_online_wake_nudge: true,
                ..PiKVMConfig::new("http://mock.local", "admin", "pw")
            },
            None,
            request_fn,
        );
        let buf = client
            .fetch_snapshot_with_retry("/streamer/snapshot")
            .await
            .unwrap();
        assert_eq!(buf, vec![9, 9, 9]);
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 3);
        assert_eq!(key_calls.load(Ordering::SeqCst), 1);
    }

    /// Flag ON, no recent keyboard activity, but the device stays
    /// genuinely unavailable through all three attempts: still exactly one
    /// keypress (never re-sends past the one escalation), and the
    /// resulting error explicitly says the nudge was tried.
    #[tokio::test]
    async fn wake_nudge_enabled_still_fails_after_a_keyboard_wake_reports_it_was_tried() {
        let key_calls = Arc::new(AtomicU32::new(0));
        let key_calls_c = key_calls.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let key_calls = key_calls_c.clone();
            Box::pin(async move {
                if args.path.starts_with("/streamer/snapshot") {
                    return Err(unavailable_error());
                }
                if args.path.starts_with("/hid/events/send_key") {
                    key_calls.fetch_add(1, Ordering::SeqCst);
                    return Ok(ResponseBody::Empty);
                }
                panic!("unexpected request path in this test: {}", args.path);
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig {
                source_online_wake_nudge: true,
                ..PiKVMConfig::new("http://mock.local", "admin", "pw")
            },
            None,
            request_fn,
        );
        let err = client
            .fetch_snapshot_with_retry("/streamer/snapshot")
            .await
            .unwrap_err();
        match err {
            ClientError::StreamerUnavailable(msg) => {
                assert!(msg.contains("wake nudge"));
                assert!(msg.contains("did not recover it"));
            }
            other => panic!("expected StreamerUnavailable, got {other:?}"),
        }
        assert_eq!(key_calls.load(Ordering::SeqCst), 1);
    }

    /// Flag OFF (the default): behavior is byte-identical to before this
    /// feature existed — no third attempt, no nudge ever sent, and the
    /// error explicitly says the escalation was disabled rather than
    /// silently omitting that detail.
    #[tokio::test]
    async fn wake_nudge_disabled_by_default_never_sends_a_nudge() {
        let snapshot_calls = Arc::new(AtomicU32::new(0));
        let snapshot_calls_c = snapshot_calls.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let snapshot_calls = snapshot_calls_c.clone();
            Box::pin(async move {
                if args.path.starts_with("/streamer/snapshot") {
                    snapshot_calls.fetch_add(1, Ordering::SeqCst);
                    return Err(unavailable_error());
                }
                panic!(
                    "unexpected request path in this test (a mouse-move nudge must not fire \
                     when the flag is off): {}",
                    args.path
                );
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://mock.local", "admin", "pw"), // source_online_wake_nudge: false
            None,
            request_fn,
        );
        let err = client
            .fetch_snapshot_with_retry("/streamer/snapshot")
            .await
            .unwrap_err();
        match err {
            ClientError::StreamerUnavailable(msg) => {
                assert!(msg.contains("escalation is disabled"));
            }
            other => panic!("expected StreamerUnavailable, got {other:?}"),
        }
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 2); // the pre-existing retry-once, nothing more
    }

    /// The nudge itself erroring must not crash the retry — best-effort,
    /// same convention as `screenshot_keeping_cursor_alive`'s `let _ = ...`:
    /// falls through to the final snapshot attempt anyway.
    #[tokio::test]
    async fn wake_nudge_failure_falls_through_to_the_final_attempt_anyway() {
        let snapshot_calls = Arc::new(AtomicU32::new(0));
        let snapshot_calls_c = snapshot_calls.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let snapshot_calls = snapshot_calls_c.clone();
            Box::pin(async move {
                if args.path.starts_with("/streamer/snapshot") {
                    let n = snapshot_calls.fetch_add(1, Ordering::SeqCst);
                    if n < 2 {
                        return Err(unavailable_error());
                    }
                    return Ok(ResponseBody::Image(vec![7, 7, 7]));
                }
                if args.path.starts_with("/hid/events/send_key") {
                    return Err(unavailable_error());
                }
                panic!("unexpected request path in this test: {}", args.path);
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig {
                source_online_wake_nudge: true,
                ..PiKVMConfig::new("http://mock.local", "admin", "pw")
            },
            None,
            request_fn,
        );
        let buf = client
            .fetch_snapshot_with_retry("/streamer/snapshot")
            .await
            .unwrap();
        assert_eq!(buf, vec![7, 7, 7]);
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn get_resolution_recovers_via_the_same_retry() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let calls = calls_c.clone();
            Box::pin(async move {
                assert_eq!(args.path, "/streamer");
                let n = calls.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    return Ok(ResponseBody::Json(
                        serde_json::json!({ "ok": true, "result": { "streamer": null } }),
                    ));
                }
                Ok(ResponseBody::Json(serde_json::json!({
                    "ok": true,
                    "result": { "streamer": { "source": { "online": true, "resolution": { "width": 4, "height": 4 } } } }
                })))
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://mock.local", "admin", "pw"),
            None,
            request_fn,
        );
        let resolution = client.get_resolution(true).await.unwrap();
        assert_eq!(
            resolution,
            ScreenResolution {
                width: 4,
                height: 4
            }
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn get_streamer_status_recovers_via_the_same_retry() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let request_fn: RequestFn = Arc::new(move |_args: RequestArgs| {
            let calls = calls_c.clone();
            Box::pin(async move {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    return Ok(ResponseBody::Json(
                        serde_json::json!({ "ok": true, "result": { "streamer": null } }),
                    ));
                }
                Ok(ResponseBody::Json(serde_json::json!({
                    "ok": true,
                    "result": { "streamer": { "source": { "online": true, "resolution": { "width": 4, "height": 4 } } } }
                })))
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://mock.local", "admin", "pw"),
            None,
            request_fn,
        );
        let (online, _resolution) = client.get_streamer_status().await.unwrap();
        assert!(online);
    }
}
