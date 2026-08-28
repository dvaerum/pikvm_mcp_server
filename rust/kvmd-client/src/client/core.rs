//! `PiKVMClient`'s core: construction, belief delegation, resource
//! cleanup, and the low-level request/retry plumbing every other
//! `impl PiKVMClient` block (in sibling files) calls through. The struct
//! definition lives here; its fields are `pub(super)` so the sibling
//! `impl` blocks in this directory can reach them directly — same
//! privacy shape as a single big `impl`, just split across files by
//! responsibility.

use std::sync::Mutex;
use std::time::Duration;

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
                        Err(ClientError::StreamerUnavailable(format!(
                            "Streamer unavailable even after a held /api/ws stream client and one retry \
                             ({STREAMER_RESTART_GRACE_MS}ms grace window): {err2} \
                             This retry exists specifically to rule out ustreamer's idle-stop race — surviving \
                             it means the more likely explanation is a genuine source-side outage. Check \
                             pikvm_health_check's streamer.source.online (HDMI cable / iPad off / mid-reboot)."
                        )))
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
