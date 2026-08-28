//! PiKVM API Client — REST control of HID + screenshot capture. Faithful
//! port of `src/pikvm/client.ts`.
//!
//! All mouse operations use the REST API (more reliable than WebSocket);
//! the client also holds a [`StreamerKeepalive`] WS connection purely to
//! stop kvmd's ustreamer idle-stopping between calls.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pikvm_mcp_cursor_belief::{Bounds as BeliefBounds, CursorBelief, CursorBeliefOptions, Point};

use crate::emit_clock;
use crate::streamer_keepalive::{StreamerKeepalive, StreamerKeepaliveConfig};

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

// ============================================================================
// Config + public types
// ============================================================================

#[derive(Debug, Clone)]
pub struct PiKVMConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    /// Default `false` (matches the TS default) — PiKVM's self-signed cert
    /// is accepted unless the caller opts into strict verification.
    pub verify_ssl: bool,
    /// Default `"en-us"`.
    pub default_keymap: String,
    /// Optional HTTP CONNECT proxy for ALL outbound PiKVM requests
    /// (e.g. `http://127.0.0.1:8888`). See `streamer_keepalive.rs`'s
    /// header for why this exists (macOS Local Network privacy).
    /// `None` = direct connection.
    pub proxy_url: Option<String>,
}

impl PiKVMConfig {
    /// Convenience constructor mirroring TS call sites that only ever set
    /// host/username/password (everything else takes its documented
    /// default), matching `PiKVMConfig`'s TS-side optional fields.
    pub fn new(
        host: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        Self {
            host: host.into(),
            username: username.into(),
            password: password.into(),
            verify_ssl: false,
            default_keymap: "en-us".to_string(),
            proxy_url: None,
        }
    }
}

/// Live HID capability snapshot from `/api/hid`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HidProfile {
    pub online: bool,
    pub mouse_absolute: bool,
    pub mouse_online: bool,
    pub keyboard_online: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TypeOptions {
    pub keymap: Option<String>,
    pub slow: bool,
    pub delay: Option<u32>,
}

/// `state`: `Some(true)` = press, `Some(false)` = release, `None` = press+release.
#[derive(Debug, Clone, Copy, Default)]
pub struct KeyOptions {
    pub state: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenResolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
    Up,
    Down,
}

impl MouseButton {
    fn as_str(self) -> &'static str {
        match self {
            MouseButton::Left => "left",
            MouseButton::Right => "right",
            MouseButton::Middle => "middle",
            MouseButton::Up => "up",
            MouseButton::Down => "down",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScreenshotResult {
    pub buffer: Vec<u8>,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    pub actual_width: u32,
    pub actual_height: u32,
    pub scale_x: f64,
    pub scale_y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalibrationState {
    pub factor_x: f64,
    pub factor_y: f64,
    pub resolution: ScreenResolution,
}

#[derive(Debug, Clone)]
pub struct CalibrationResult {
    pub expected_position: (i64, i64),
    pub requested_normalized: (i32, i32),
    pub resolution: ScreenResolution,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct ScreenshotOptions {
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub quality: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct ResetHidOptions {
    pub reconnect_usb: bool,
    pub settle_ms: Option<u64>,
}

// ============================================================================
// Errors
// ============================================================================

/// Thrown by `request()` instead of a bare error so callers that need to
/// distinguish "the server said no" (and specifically which status) from
/// any other failure don't have to parse the message. `.message` is
/// UNCHANGED from the pre-existing "PiKVM API error N: ..." text —
/// operator-hints.ts's pattern matching and its test suite both key off
/// that exact string; this is additive (a `.status`), not a format change.
#[derive(Debug, Clone)]
pub struct PiKVMApiError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for PiKVMApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for PiKVMApiError {}

/// Faithful port of `ClientError`'s union of failure shapes: a structured
/// API error (`PiKVMApiError`), the streamer-idle-stop-retry-exhausted
/// case (`StreamerUnavailableError`), and everything else (`Other`, e.g.
/// "Invalid or missing resolution data...", "Failed to read screenshot
/// dimensions"). Rust has no `instanceof`, so callers that need to
/// discriminate (the retry-once logic) match on this enum instead.
#[derive(Debug, Clone)]
pub enum ClientError {
    Api(PiKVMApiError),
    StreamerUnavailable(String),
    Other(String),
}

impl ClientError {
    /// `err instanceof PiKVMApiError` equivalent.
    pub fn api_status(&self) -> Option<u16> {
        match self {
            ClientError::Api(e) => Some(e.status),
            _ => None,
        }
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Api(e) => write!(f, "{e}"),
            ClientError::StreamerUnavailable(m) => write!(f, "{m}"),
            ClientError::Other(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for ClientError {}

// ============================================================================
// Constants + pure helpers
// ============================================================================

/// Grace window for the streamer idle-stop retry-once: how long to wait
/// between the initial 503/null-streamer response and the single retry,
/// giving kvmd's own stream-controller loop + ustreamer's fork+exec+bind
/// time to finish after the held keepalive WS's connection triggered a
/// (re)start.
const STREAMER_RESTART_GRACE_MS: u64 = 1500;

// PiKVM uses signed 16-bit integers for absolute mouse coordinates.
const MOUSE_COORD_MIN: i32 = -32768;
const MOUSE_COORD_MAX: i32 = 32767;

// Relative mouse deltas are limited to signed 8-bit range.
const MOUSE_DELTA_MIN: f64 = -127.0;
const MOUSE_DELTA_MAX: f64 = 127.0;

/// Linearly remap a value from one range to another.
fn remap(value: f64, from_min: f64, from_max: f64, to_min: f64, to_max: f64) -> i32 {
    (to_min + (value - from_min) * (to_max - to_min) / (from_max - from_min)).round() as i32
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    value.max(min).min(max)
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// Max per-event wheel magnitude. The USB-HID wheel is a SIGNED BYTE, and
/// kvmd's send_mouse_wheel silently wraps a large value (a single
/// delta_y=500 wrapped to a ~no-op and did NOT scroll on-device). The
/// validated way to scroll a large amount is repeated MODERATE events
/// (25× delta_y=20 scrolled correctly). Cap each emitted event at ±20.
pub const WHEEL_STEP_MAX: i32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WheelDelta {
    pub delta_x: i32,
    pub delta_y: i32,
}

/// Split a (deltaX, deltaY) scroll into a sequence of wheel events, each
/// with per-axis magnitude ≤ `step`, sign preserved, summing back to the
/// rounded input. Pure so the chunking is unit-tested without a live
/// PiKVM. A small scroll (|delta| ≤ step on both axes) yields a single
/// unchanged event; a (0,0) scroll yields no events.
pub fn chunk_wheel_deltas(delta_x: f64, delta_y: f64, step: i32) -> Vec<WheelDelta> {
    let clamp_mag = |v: i32| -> i32 { v.signum() * v.abs().min(step) };
    let mut rx = delta_x.round() as i32;
    let mut ry = delta_y.round() as i32;
    let mut events = Vec::new();
    while rx != 0 || ry != 0 {
        let ex = clamp_mag(rx);
        let ey = clamp_mag(ry);
        events.push(WheelDelta {
            delta_x: ex,
            delta_y: ey,
        });
        rx -= ex;
        ry -= ey;
    }
    events
}

// ============================================================================
// Low-level request seam
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone)]
pub enum RequestBody {
    Json(serde_json::Value),
    Text(String),
}

#[derive(Debug, Clone)]
pub struct RequestArgs {
    pub method: HttpMethod,
    /// Path + query string, e.g. `/hid/events/send_mouse_move?to_x=0&to_y=0`.
    /// Resolved against `/api` on the configured host, matching TS's
    /// `new URL('/api'+path, this.config.host)`.
    pub path: String,
    pub body: Option<RequestBody>,
}

/// What a successful request resolves to — mirrors TS `request<T>()`'s
/// runtime content-type dispatch (image bytes / parsed JSON / empty body)
/// collapsed to a fixed enum since Rust has no `T = unknown`. The TS
/// "not valid JSON, wrap as `{ result: text } `" fallback is modelled by
/// constructing that same shape as a `Json` value here, so it's
/// indistinguishable to callers either way.
#[derive(Debug, Clone)]
pub enum ResponseBody {
    Image(Vec<u8>),
    Json(serde_json::Value),
    Empty,
}

pub type RequestFn = Arc<
    dyn Fn(RequestArgs) -> Pin<Box<dyn Future<Output = Result<ResponseBody, ClientError>> + Send>>
        + Send
        + Sync,
>;

fn sanitize_error_text(text: &str) -> String {
    // Faithful port of the TS regex sanitization
    // (`/password[=:][^\s,"]*/gi`, `/X-KVMD-Passwd[^,\s"]*/gi`,
    // `.substring(0, 200)`). `regex` (not hand-rolled) because this is
    // genuine case-insensitive pattern-replace, not a simple
    // word-boundary scan (contrast operator_hints's hand-rolled
    // `contains_word_503`) — and it redacts credentials before they
    // might reach logs, which is exactly the wrong place to risk a
    // hand-rolled bug.
    use std::sync::OnceLock;
    static PASSWORD_RE: OnceLock<regex::Regex> = OnceLock::new();
    static KVMD_PASSWD_RE: OnceLock<regex::Regex> = OnceLock::new();
    let password_re = PASSWORD_RE.get_or_init(|| {
        regex::RegexBuilder::new(r#"password[=:][^\s,"]*"#)
            .case_insensitive(true)
            .build()
            .expect("static regex is valid")
    });
    let kvmd_passwd_re = KVMD_PASSWD_RE.get_or_init(|| {
        regex::RegexBuilder::new(r#"X-KVMD-Passwd[^,\s"]*"#)
            .case_insensitive(true)
            .build()
            .expect("static regex is valid")
    });
    let redacted = password_re.replace_all(text, "password=[REDACTED]");
    let redacted = kvmd_passwd_re.replace_all(&redacted, "X-KVMD-Passwd=[REDACTED]");
    redacted.chars().take(200).collect()
}

/// The real networking implementation of the request seam — builds
/// `{host}/api{path}`, sets the `X-KVMD-User`/`X-KVMD-Passwd` auth
/// headers, dispatches on the response content-type, and sanitizes error
/// bodies before wrapping them in `PiKVMApiError`. Faithful port of
/// `PiKVMClient.request`.
fn real_request_fn(
    http: reqwest::Client,
    host: String,
    username: String,
    password: String,
) -> RequestFn {
    Arc::new(move |args: RequestArgs| {
        let http = http.clone();
        let host = host.clone();
        let username = username.clone();
        let password = password.clone();
        Box::pin(async move {
            let url = format!("{}/api{}", host.trim_end_matches('/'), args.path);
            let mut builder = match args.method {
                HttpMethod::Get => http.get(&url),
                HttpMethod::Post => http.post(&url),
            };
            builder = builder
                .header("X-KVMD-User", &username)
                .header("X-KVMD-Passwd", &password);
            if let Some(body) = &args.body {
                builder = match body {
                    RequestBody::Json(v) => {
                        builder.header("Content-Type", "application/json").json(v)
                    }
                    RequestBody::Text(t) => {
                        builder.header("Content-Type", "text/plain").body(t.clone())
                    }
                };
            }
            let response = builder
                .send()
                .await
                .map_err(|e| ClientError::Other(format!("request to {url} failed: {e}")))?;

            let status = response.status();
            if !status.is_success() {
                let status_code = status.as_u16();
                let error_text = response.text().await.unwrap_or_default();
                let sanitized = sanitize_error_text(&error_text);
                return Err(ClientError::Api(PiKVMApiError {
                    status: status_code,
                    message: format!("PiKVM API error {status_code}: {sanitized}"),
                }));
            }

            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let content_length_zero = response
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == "0")
                .unwrap_or(false);
            let status_no_content = status.as_u16() == 204;

            if content_type.contains("image/") {
                let bytes = response.bytes().await.map_err(|e| {
                    ClientError::Other(format!("failed to read response body: {e}"))
                })?;
                return Ok(ResponseBody::Image(bytes.to_vec()));
            }

            if status_no_content || content_length_zero {
                return Ok(ResponseBody::Empty);
            }

            let text = response
                .text()
                .await
                .map_err(|e| ClientError::Other(format!("failed to read response body: {e}")))?;
            if text.is_empty() {
                return Ok(ResponseBody::Empty);
            }
            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(v) => Ok(ResponseBody::Json(v)),
                Err(_) => Ok(ResponseBody::Json(serde_json::json!({ "result": text }))),
            }
        })
    })
}

// ============================================================================
// PiKVMClient
// ============================================================================

struct ScreenshotScale {
    scale_x: f64,
    scale_y: f64,
}

pub struct PiKVMClient {
    config: PiKVMConfig,
    request_fn: RequestFn,
    cached_resolution: Mutex<Option<ScreenResolution>>,
    screenshot_scale: Mutex<Option<ScreenshotScale>>,
    calibration: Mutex<Option<CalibrationState>>,
    streamer_keepalive: StreamerKeepalive,

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

    async fn request(&self, args: RequestArgs) -> Result<ResponseBody, ClientError> {
        (self.request_fn)(args).await
    }

    /// Fetch `/streamer/snapshot` bytes, absorbing the ustreamer
    /// idle-stop race. `ensure_started()` makes this a true no-op after
    /// the first call in a session.
    async fn fetch_snapshot_with_retry(&self, path: &str) -> Result<Vec<u8>, ClientError> {
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
    async fn fetch_streamer_state_with_retry(&self) -> Result<serde_json::Value, ClientError> {
        self.streamer_keepalive.ensure_started().await;
        let first = self.request_json_get("/streamer").await?;
        if streamer_source(&first).is_some() {
            return Ok(first);
        }
        tokio::time::sleep(Duration::from_millis(STREAMER_RESTART_GRACE_MS)).await;
        self.request_json_get("/streamer").await
    }

    async fn request_json_get(&self, path: &str) -> Result<serde_json::Value, ClientError> {
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

    /// Phase 202: emit a ±1px wake nudge IMMEDIATELY before capturing a
    /// screenshot so the iPad's soft cursor is visible in the captured
    /// frame. Net cursor displacement is 0 (1 right + 1 left).
    pub async fn screenshot_keeping_cursor_alive(
        &self,
        options: Option<ScreenshotOptions>,
    ) -> Result<ScreenshotResult, ClientError> {
        // If the wake nudge fails (HID busy etc.), proceed with the
        // screenshot anyway — degraded behavior matches the old path;
        // better than throwing here.
        let _ = self.mouse_move_relative(1.0, 0.0).await;
        let _ = self.mouse_move_relative(-1.0, 0.0).await;
        self.screenshot(options).await
    }

    pub async fn screenshot(
        &self,
        options: Option<ScreenshotOptions>,
    ) -> Result<ScreenshotResult, ClientError> {
        let options = options.unwrap_or_default();
        let mut params = Vec::new();
        if options.max_width.is_some() || options.max_height.is_some() {
            params.push("preview=1".to_string());
            if let Some(w) = options.max_width {
                params.push(format!("preview_max_width={w}"));
            }
            if let Some(h) = options.max_height {
                params.push(format!("preview_max_height={h}"));
            }
            if let Some(q) = options.quality {
                params.push(format!("preview_quality={q}"));
            }
        }
        let path = if params.is_empty() {
            "/streamer/snapshot".to_string()
        } else {
            format!("/streamer/snapshot?{}", params.join("&"))
        };
        let buffer = self.fetch_snapshot_with_retry(&path).await?;

        // Force-refresh resolution to ensure accuracy.
        let actual_resolution = self.get_resolution(true).await?;

        let dims = image::load_from_memory(&buffer)
            .map_err(|_| ClientError::Other("Failed to read screenshot dimensions".to_string()))?;
        let (width, height) = (dims.width(), dims.height());

        let scale_x = actual_resolution.width as f64 / width as f64;
        let scale_y = actual_resolution.height as f64 / height as f64;
        *self.screenshot_scale.lock().unwrap() = Some(ScreenshotScale { scale_x, scale_y });

        Ok(ScreenshotResult {
            buffer,
            screenshot_width: width,
            screenshot_height: height,
            actual_width: actual_resolution.width,
            actual_height: actual_resolution.height,
            scale_x,
            scale_y,
        })
    }

    pub async fn get_resolution(
        &self,
        force_refresh: bool,
    ) -> Result<ScreenResolution, ClientError> {
        if !force_refresh {
            if let Some(r) = *self.cached_resolution.lock().unwrap() {
                return Ok(r);
            }
        }
        let response = self.fetch_streamer_state_with_retry().await?;
        let resolution = streamer_source(&response)
            .and_then(|s| s.get("resolution"))
            .and_then(parse_resolution)
            .ok_or_else(|| {
                ClientError::Other(
                    "Invalid or missing resolution data from PiKVM streamer API".into(),
                )
            })?;
        *self.cached_resolution.lock().unwrap() = Some(resolution);
        Ok(resolution)
    }

    /// Phase 189: report streamer source state — whether the HDMI capture
    /// is seeing a signal (device powered on and outputting video).
    pub async fn get_streamer_status(&self) -> Result<(bool, ScreenResolution), ClientError> {
        let response = self.fetch_streamer_state_with_retry().await?;
        let source = streamer_source(&response).ok_or_else(|| {
            ClientError::Other("Invalid or missing streamer.source data from PiKVM API".into())
        })?;
        let online = source
            .get("online")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| {
                ClientError::Other("Invalid or missing streamer.source data from PiKVM API".into())
            })?;
        let resolution = source
            .get("resolution")
            .and_then(parse_resolution)
            .ok_or_else(|| {
                ClientError::Other(
                    "Invalid or missing streamer.source.resolution data from PiKVM API".into(),
                )
            })?;
        Ok((online, resolution))
    }

    /// Convert pixel coordinates to PiKVM's normalized coordinate system
    /// (range -32768..32767). Calibration factors compensate for
    /// resolution-dependent scaling issues; without calibration, factors
    /// default to 1.0.
    fn pixel_to_normalized(
        &self,
        pixel_x: f64,
        pixel_y: f64,
        resolution: ScreenResolution,
    ) -> (i32, i32) {
        let base_x = remap(
            pixel_x,
            0.0,
            (resolution.width - 1) as f64,
            MOUSE_COORD_MIN as f64,
            MOUSE_COORD_MAX as f64,
        );
        let base_y = remap(
            pixel_y,
            0.0,
            (resolution.height - 1) as f64,
            MOUSE_COORD_MIN as f64,
            MOUSE_COORD_MAX as f64,
        );

        let calibration = *self.calibration.lock().unwrap();
        let factor_x = calibration.map(|c| c.factor_x).unwrap_or(1.0);
        let factor_y = calibration.map(|c| c.factor_y).unwrap_or(1.0);

        let corrected_x = ((base_x as f64 + 32768.0) * factor_x).round() as i32 - 32768;
        let corrected_y = ((base_y as f64 + 32768.0) * factor_y).round() as i32 - 32768;

        (
            clamp_i32(corrected_x, MOUSE_COORD_MIN, MOUSE_COORD_MAX),
            clamp_i32(corrected_y, MOUSE_COORD_MIN, MOUSE_COORD_MAX),
        )
    }

    /// Perform calibration by moving the cursor to the center of the
    /// screen. Returns information needed for the agent to calculate
    /// calibration factors.
    pub async fn calibrate(&self) -> Result<CalibrationResult, ClientError> {
        let resolution = self.get_resolution(true).await?;
        let center_x = (resolution.width as f64 / 2.0).round() as i64;
        let center_y = (resolution.height as f64 / 2.0).round() as i64;

        let saved_calibration = self.calibration.lock().unwrap().take();
        let normalized = self.pixel_to_normalized(center_x as f64, center_y as f64, resolution);
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!(
                "/hid/events/send_mouse_move?to_x={}&to_y={}",
                normalized.0, normalized.1
            ),
            body: None,
        })
        .await?;
        *self.calibration.lock().unwrap() = saved_calibration;

        Ok(CalibrationResult {
            expected_position: (center_x, center_y),
            requested_normalized: normalized,
            resolution,
            message: format!(
                "Cursor moved to expected center position ({center_x}, {center_y}). \
                 Please take a screenshot and visually verify the actual cursor position. \
                 Then call pikvm_set_calibration with the calculated factors: \
                 factorX = {center_x} / actual_x, factorY = {center_y} / actual_y"
            ),
        })
    }

    /// Sanity check: factors should be reasonable (0.5 to 2.0).
    pub fn set_calibration_factors(&self, factor_x: f64, factor_y: f64) -> Result<(), ClientError> {
        if !(0.5..=2.0).contains(&factor_x) || !(0.5..=2.0).contains(&factor_y) {
            return Err(ClientError::Other(format!(
                "Calibration factors out of reasonable range (0.5-2.0): factorX={factor_x}, factorY={factor_y}"
            )));
        }
        let resolution = self
            .cached_resolution
            .lock()
            .unwrap()
            .unwrap_or(ScreenResolution {
                width: 0,
                height: 0,
            });
        *self.calibration.lock().unwrap() = Some(CalibrationState {
            factor_x,
            factor_y,
            resolution,
        });
        Ok(())
    }

    pub fn get_calibration(&self) -> Option<CalibrationState> {
        *self.calibration.lock().unwrap()
    }

    pub fn clear_calibration(&self) {
        *self.calibration.lock().unwrap() = None;
    }

    /// Move mouse to absolute pixel position WITHOUT calibration or
    /// screenshot scaling. Used during auto-calibration to send known
    /// uncalibrated positions.
    pub async fn mouse_move_raw(&self, x: f64, y: f64) -> Result<(), ClientError> {
        let resolution = self.get_resolution(false).await?;
        let saved_calibration = self.calibration.lock().unwrap().take();
        let normalized = self.pixel_to_normalized(x, y, resolution);
        *self.calibration.lock().unwrap() = saved_calibration;
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!(
                "/hid/events/send_mouse_move?to_x={}&to_y={}",
                normalized.0, normalized.1
            ),
            body: None,
        })
        .await?;
        Ok(())
    }

    fn has_resolution_changed(&self, current: ScreenResolution) -> bool {
        match *self.calibration.lock().unwrap() {
            Some(c) => c.resolution != current,
            None => false,
        }
    }

    /// Scale coordinates from screenshot space to actual screen space. If
    /// no screenshot has been taken, coordinates pass through unchanged.
    fn scale_coordinates(&self, x: f64, y: f64) -> (f64, f64) {
        match &*self.screenshot_scale.lock().unwrap() {
            Some(s) => ((x * s.scale_x).round(), (y * s.scale_y).round()),
            None => (x, y),
        }
    }

    /// Type text using paste-as-keys (handles special characters correctly).
    pub async fn r#type(
        &self,
        text: &str,
        options: Option<TypeOptions>,
    ) -> Result<(), ClientError> {
        let options = options.unwrap_or_default();
        let keymap = options
            .keymap
            .unwrap_or_else(|| self.config.default_keymap.clone());
        let mut params = vec![format!("keymap={keymap}")];
        if options.slow {
            params.push("slow=1".to_string());
        }
        if let Some(delay) = options.delay {
            params.push(format!("delay={delay}"));
        }
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!("/hid/print?{}", params.join("&")),
            body: Some(RequestBody::Text(text.to_string())),
        })
        .await?;
        Ok(())
    }

    pub async fn send_key(
        &self,
        key: &str,
        options: Option<KeyOptions>,
    ) -> Result<(), ClientError> {
        let options = options.unwrap_or_default();
        let mut params = vec![format!("key={key}")];
        if let Some(state) = options.state {
            params.push(format!("state={state}"));
        }
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!("/hid/events/send_key?{}", params.join("&")),
            body: None,
        })
        .await?;
        Ok(())
    }

    /// Send a keyboard shortcut (multiple keys pressed together). Emits
    /// an explicit press → settle → tap last key → settle → release
    /// sequence via `send_key` (reliable on iPadOS, unlike
    /// `send_shortcut`'s near-simultaneous events — see the TS doc
    /// comment for the on-device finding). The last key is the "action"
    /// key; all preceding keys are held as modifiers.
    pub async fn send_shortcut(&self, keys: &[&str]) -> Result<(), ClientError> {
        if keys.is_empty() {
            return Ok(());
        }
        if keys.len() == 1 {
            return self.send_key(keys[0], None).await;
        }
        let modifiers = &keys[..keys.len() - 1];
        let action_key = keys[keys.len() - 1];

        for m in modifiers {
            self.send_key(m, Some(KeyOptions { state: Some(true) }))
                .await?;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        self.send_key(action_key, None).await?;
        tokio::time::sleep(Duration::from_millis(40)).await;
        for m in modifiers.iter().rev() {
            self.send_key(m, Some(KeyOptions { state: Some(false) }))
                .await?;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        Ok(())
    }

    /// Move mouse to absolute pixel position (via REST API). Coordinates
    /// are automatically scaled from screenshot space to screen space if
    /// a scaled screenshot was previously taken. Returns whether
    /// calibration was invalidated by a resolution change.
    pub async fn mouse_move(&self, x: f64, y: f64) -> Result<bool, ClientError> {
        let (sx, sy) = self.scale_coordinates(x, y);
        let resolution = self.get_resolution(true).await?;

        let mut calibration_invalidated = false;
        if self.has_resolution_changed(resolution) {
            *self.calibration.lock().unwrap() = None;
            calibration_invalidated = true;
        }

        let normalized = self.pixel_to_normalized(sx, sy, resolution);
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!(
                "/hid/events/send_mouse_move?to_x={}&to_y={}",
                normalized.0, normalized.1
            ),
            body: None,
        })
        .await?;

        Ok(calibration_invalidated)
    }

    /// Move mouse relative to current position (via REST API).
    /// `delta_x`/`delta_y`: negative = left/up, positive = right/down.
    pub async fn mouse_move_relative(&self, delta_x: f64, delta_y: f64) -> Result<(), ClientError> {
        let clamped_x = clamp_f64(delta_x.round(), MOUSE_DELTA_MIN, MOUSE_DELTA_MAX);
        let clamped_y = clamp_f64(delta_y.round(), MOUSE_DELTA_MIN, MOUSE_DELTA_MAX);

        // The TS opt-in PIKVM_EMIT_LOG stack-trace capture is NOT ported:
        // Rust has no equivalent to JS's cheap `Error().stack`, and
        // capturing a real backtrace on every HID emit would be a much
        // higher-cost operation for an optional diagnostic feature.
        // Individually-flagged deviation — the {t, requested, clamped}
        // JSON logging itself is not yet wired here either, pending a
        // real caller that needs it.

        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!(
                "/hid/events/send_mouse_relative?delta_x={}&delta_y={}",
                clamped_x as i64, clamped_y as i64
            ),
            body: None,
        })
        .await?;
        // Phase 187: stamp the keepalive clock.
        emit_clock::record_emit();
        // Phase 192-B: forward-predict the cursor belief by the CLAMPED
        // emit (what was actually sent over HID).
        self.belief.lock().unwrap().predict(
            pikvm_mcp_cursor_belief::Emit {
                dx: clamped_x,
                dy: clamped_y,
            },
            None,
        );
        Ok(())
    }

    /// Click mouse button (via REST API). With `options.state` set, sends
    /// a single press-or-release event. Otherwise sends a full click:
    /// press, hold `down_ms` (default 150ms — iPadOS requires a
    /// non-zero press duration to register a tap reliably), release.
    pub async fn mouse_click(
        &self,
        button: MouseButton,
        state: Option<bool>,
        down_ms: Option<u64>,
    ) -> Result<(), ClientError> {
        let button = button.as_str();
        if let Some(state) = state {
            self.request(RequestArgs {
                method: HttpMethod::Post,
                path: format!("/hid/events/send_mouse_button?button={button}&state={state}"),
                body: None,
            })
            .await?;
            return Ok(());
        }
        let down_ms = down_ms.unwrap_or(150);
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!("/hid/events/send_mouse_button?button={button}&state=true"),
            body: None,
        })
        .await?;
        if down_ms > 0 {
            tokio::time::sleep(Duration::from_millis(down_ms)).await;
        }
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!("/hid/events/send_mouse_button?button={button}&state=false"),
            body: None,
        })
        .await?;
        Ok(())
    }

    /// Scroll mouse wheel (via REST API). Chunks large deltas into
    /// repeated ±`WHEEL_STEP_MAX` events (see `chunk_wheel_deltas`).
    pub async fn mouse_scroll(&self, delta_x: f64, delta_y: f64) -> Result<(), ClientError> {
        for ev in chunk_wheel_deltas(delta_x, delta_y, WHEEL_STEP_MAX) {
            self.request(RequestArgs {
                method: HttpMethod::Post,
                path: format!(
                    "/hid/events/send_mouse_wheel?delta_x={}&delta_y={}",
                    ev.delta_x, ev.delta_y
                ),
                body: None,
            })
            .await?;
        }
        Ok(())
    }

    pub async fn get_keymaps(&self) -> Result<Vec<String>, ClientError> {
        let response = self.request_json_get("/hid/keymaps").await?;
        let keymaps = response
            .get("result")
            .and_then(|r| r.get("keymaps"))
            .and_then(|k| k.as_object())
            .ok_or_else(|| {
                ClientError::Other("Invalid or missing keymaps data from PiKVM API".into())
            })?;
        Ok(keymaps.keys().cloned().collect())
    }

    /// Reset the PiKVM USB HID gadget. Recovery primitive for when
    /// mouse/keyboard report `online: false`. With `opts: None`, this
    /// preserves the original void behaviour (fire the soft reset and
    /// return `Ok(None)`) — Rust has no TS-style overload, so `Some`/
    /// `None` on `opts` plays the role of the two TS overloads, and
    /// `Ok(Some(profile))` only when `opts` was given.
    pub async fn reset_hid(
        &self,
        opts: Option<ResetHidOptions>,
    ) -> Result<Option<HidProfile>, ClientError> {
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: "/hid/reset".to_string(),
            body: None,
        })
        .await?;
        let Some(opts) = opts else { return Ok(None) };
        if opts.reconnect_usb {
            self.request(RequestArgs {
                method: HttpMethod::Post,
                path: "/hid/set_connected?connected=0".to_string(),
                body: None,
            })
            .await?;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            self.request(RequestArgs {
                method: HttpMethod::Post,
                path: "/hid/set_connected?connected=1".to_string(),
                body: None,
            })
            .await?;
        }
        tokio::time::sleep(Duration::from_millis(opts.settle_ms.unwrap_or(2000))).await;
        Ok(Some(self.get_hid_profile().await?))
    }

    /// Read HID configuration flags. Used to decide whether absolute-mode
    /// mouse tools are usable on the current target. iPad and other
    /// relative-only HID hosts report `mouse_absolute: false`.
    pub async fn get_hid_profile(&self) -> Result<HidProfile, ClientError> {
        let response = self.request_json_get("/hid").await?;
        let r = response.get("result");
        let get_bool = |path: &[&str], default: bool| -> bool {
            let mut cur = r;
            for key in path {
                cur = cur.and_then(|v| v.get(key));
            }
            cur.and_then(|v| v.as_bool()).unwrap_or(default)
        };
        Ok(HidProfile {
            online: get_bool(&["online"], false),
            mouse_absolute: get_bool(&["mouse", "absolute"], true),
            mouse_online: get_bool(&["mouse", "online"], false),
            keyboard_online: get_bool(&["keyboard", "online"], false),
        })
    }

    pub async fn check_auth(&self) -> bool {
        self.request(RequestArgs {
            method: HttpMethod::Get,
            path: "/auth/check".to_string(),
            body: None,
        })
        .await
        .is_ok()
    }
}

fn build_http_client(verify_ssl: bool, proxy_url: Option<&str>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder().danger_accept_invalid_certs(!verify_ssl);
    if let Some(proxy_url) = proxy_url {
        if !proxy_url.is_empty() {
            builder =
                builder.proxy(reqwest::Proxy::all(proxy_url).expect("proxy URL should be valid"));
        }
    }
    builder
        .build()
        .expect("reqwest client config should be valid")
}

/// `response.result.streamer.source`, threading through the same
/// defensive-null handling as the TS getters (`streamer` is genuinely
/// `null`, not absent, when ustreamer isn't running).
fn streamer_source(response: &serde_json::Value) -> Option<&serde_json::Value> {
    response.get("result")?.get("streamer")?.get("source")
}

fn parse_resolution(v: &serde_json::Value) -> Option<ScreenResolution> {
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

    fn stub_request_fn() -> RequestFn {
        Arc::new(|_args: RequestArgs| Box::pin(async { Ok(ResponseBody::Empty) }))
    }

    fn new_test_client() -> PiKVMClient {
        PiKVMClient::with_request_fn(
            PiKVMConfig::new("mock.local", "admin", "x"),
            None,
            stub_request_fn(),
        )
    }

    fn pt(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    mod chunk_wheel_deltas_tests {
        use super::*;

        fn sum(evs: &[WheelDelta]) -> WheelDelta {
            evs.iter().fold(
                WheelDelta {
                    delta_x: 0,
                    delta_y: 0,
                },
                |a, e| WheelDelta {
                    delta_x: a.delta_x + e.delta_x,
                    delta_y: a.delta_y + e.delta_y,
                },
            )
        }

        #[test]
        fn leaves_a_small_scroll_as_a_single_unchanged_event() {
            assert_eq!(
                chunk_wheel_deltas(0.0, 15.0, WHEEL_STEP_MAX),
                vec![WheelDelta {
                    delta_x: 0,
                    delta_y: 15
                }]
            );
            assert_eq!(
                chunk_wheel_deltas(0.0, WHEEL_STEP_MAX as f64, WHEEL_STEP_MAX),
                vec![WheelDelta {
                    delta_x: 0,
                    delta_y: WHEEL_STEP_MAX
                }]
            );
        }

        #[test]
        fn splits_the_field_report_failure_case_into_step_events_that_sum_back() {
            let evs = chunk_wheel_deltas(0.0, 500.0, WHEEL_STEP_MAX);
            assert_eq!(evs.len(), 25); // ceil(500/20)
            assert!(evs.iter().all(|e| e.delta_y.abs() <= WHEEL_STEP_MAX));
            assert_eq!(
                sum(&evs),
                WheelDelta {
                    delta_x: 0,
                    delta_y: 500
                }
            );
        }

        #[test]
        fn preserves_sign_for_negative_scroll_up_deltas() {
            let evs = chunk_wheel_deltas(0.0, -50.0, WHEEL_STEP_MAX);
            assert!(evs.iter().all(|e| e.delta_y <= 0));
            assert_eq!(
                sum(&evs),
                WheelDelta {
                    delta_x: 0,
                    delta_y: -50
                }
            );
            assert_eq!(
                evs,
                vec![
                    WheelDelta {
                        delta_x: 0,
                        delta_y: -20
                    },
                    WheelDelta {
                        delta_x: 0,
                        delta_y: -20
                    },
                    WheelDelta {
                        delta_x: 0,
                        delta_y: -10
                    },
                ]
            );
        }

        #[test]
        fn handles_a_non_multiple_with_a_remainder_tail() {
            let evs = chunk_wheel_deltas(0.0, 50.0, WHEEL_STEP_MAX);
            assert_eq!(
                evs,
                vec![
                    WheelDelta {
                        delta_x: 0,
                        delta_y: 20
                    },
                    WheelDelta {
                        delta_x: 0,
                        delta_y: 20
                    },
                    WheelDelta {
                        delta_x: 0,
                        delta_y: 10
                    },
                ]
            );
        }

        #[test]
        fn chunks_both_axes_together_and_stops_when_both_are_drained() {
            let evs = chunk_wheel_deltas(30.0, -50.0, WHEEL_STEP_MAX);
            assert_eq!(
                sum(&evs),
                WheelDelta {
                    delta_x: 30,
                    delta_y: -50
                }
            );
            assert_eq!(evs.len(), 3); // max(ceil(30/20), ceil(50/20))
            assert!(evs
                .iter()
                .all(|e| e.delta_x.abs() <= WHEEL_STEP_MAX && e.delta_y.abs() <= WHEEL_STEP_MAX));
            assert_eq!(
                evs[2],
                WheelDelta {
                    delta_x: 0,
                    delta_y: -10
                }
            );
        }

        #[test]
        fn emits_no_events_for_a_zero_scroll() {
            assert_eq!(chunk_wheel_deltas(0.0, 0.0, WHEEL_STEP_MAX), vec![]);
        }

        #[test]
        fn rounds_fractional_deltas_before_chunking() {
            assert_eq!(
                chunk_wheel_deltas(0.0, 12.7, WHEEL_STEP_MAX),
                vec![WheelDelta {
                    delta_x: 0,
                    delta_y: 13
                }]
            );
        }

        #[test]
        fn honours_a_custom_step() {
            let evs = chunk_wheel_deltas(0.0, 30.0, 10);
            assert_eq!(
                evs,
                vec![
                    WheelDelta {
                        delta_x: 0,
                        delta_y: 10
                    },
                    WheelDelta {
                        delta_x: 0,
                        delta_y: 10
                    },
                    WheelDelta {
                        delta_x: 0,
                        delta_y: 10
                    },
                ]
            );
        }
    }

    mod calibration_state_machine {
        use super::*;

        #[test]
        fn starts_uncalibrated() {
            let client = new_test_client();
            assert_eq!(client.get_calibration(), None);
        }

        #[test]
        fn set_calibration_factors_records_factors_for_retrieval() {
            let client = new_test_client();
            client.set_calibration_factors(1.1, 1.2).unwrap();
            let cal = client.get_calibration().unwrap();
            assert_eq!(cal.factor_x, 1.1);
            assert_eq!(cal.factor_y, 1.2);
        }

        #[test]
        fn clear_calibration_returns_to_uncalibrated() {
            let client = new_test_client();
            client.set_calibration_factors(1.0, 1.0).unwrap();
            client.clear_calibration();
            assert_eq!(client.get_calibration(), None);
        }

        #[test]
        fn rejects_factor_x_below_the_lower_bound() {
            let client = new_test_client();
            assert!(client.set_calibration_factors(0.4, 1.0).is_err());
        }

        #[test]
        fn rejects_factor_x_above_the_upper_bound() {
            let client = new_test_client();
            assert!(client.set_calibration_factors(2.1, 1.0).is_err());
        }

        #[test]
        fn rejects_factor_y_below_the_lower_bound() {
            let client = new_test_client();
            assert!(client.set_calibration_factors(1.0, 0.4).is_err());
        }

        #[test]
        fn rejects_factor_y_above_the_upper_bound() {
            let client = new_test_client();
            assert!(client.set_calibration_factors(1.0, 2.1).is_err());
        }

        #[test]
        fn accepts_the_lower_boundary_value_inclusive() {
            let client = new_test_client();
            client.set_calibration_factors(0.5, 0.5).unwrap();
            assert_eq!(client.get_calibration().unwrap().factor_x, 0.5);
        }

        #[test]
        fn accepts_the_upper_boundary_value_inclusive() {
            let client = new_test_client();
            client.set_calibration_factors(2.0, 2.0).unwrap();
            assert_eq!(client.get_calibration().unwrap().factor_y, 2.0);
        }

        #[test]
        fn error_message_names_the_offending_factor_values() {
            let client = new_test_client();
            let err = client.set_calibration_factors(3.0, 0.1).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains('3') || msg.contains("0.1"));
        }

        #[test]
        fn rejected_calibration_leaves_prior_state_untouched() {
            let client = new_test_client();
            client.set_calibration_factors(1.1, 1.1).unwrap();
            assert!(client.set_calibration_factors(99.0, 99.0).is_err());
            let cal = client.get_calibration().unwrap();
            assert_eq!(cal.factor_x, 1.1);
            assert_eq!(cal.factor_y, 1.1);
        }

        #[test]
        fn snapshots_a_resolution_placeholder_when_none_has_been_cached_yet() {
            let client = new_test_client();
            client.set_calibration_factors(1.0, 1.0).unwrap();
            let cal = client.get_calibration().unwrap();
            assert_eq!(
                cal.resolution,
                ScreenResolution {
                    width: 0,
                    height: 0
                }
            );
        }

        #[test]
        fn close_is_safe_to_call_idempotent_no_op() {
            let client = new_test_client();
            client.close();
            client.close();
        }
    }

    mod belief_wiring {
        use super::*;

        #[tokio::test]
        async fn mouse_move_relative_forwards_the_clamped_emit_to_belief_predict() {
            let c = new_test_client();
            c.reset_belief(pt(100.0, 100.0));
            assert_eq!(c.belief.lock().unwrap().position, pt(100.0, 100.0));

            c.mouse_move_relative(20.0, 0.0).await.unwrap();

            // belief.position should have advanced by 20 * default ratio (1.3) = 26 px.
            let pos = c.belief.lock().unwrap().position;
            assert!((pos.x - 126.0).abs() < 0.1);
            assert_eq!(pos.y, 100.0);
        }

        #[tokio::test]
        async fn belief_predict_uses_clamped_values_not_raw_caller_input() {
            let c = new_test_client();
            c.reset_belief(pt(0.0, 0.0));

            // Caller asks for +500 mickeys; PiKVM clamps to +127.
            c.mouse_move_relative(500.0, 0.0).await.unwrap();

            // belief.predict must see 127, not 500: 127 * 1.3 = 165.1.
            let pos = c.belief.lock().unwrap().position;
            assert!((pos.x - 165.1).abs() < 1.0);
        }

        #[tokio::test]
        async fn multiple_emits_accumulate_in_belief_position() {
            let c = new_test_client();
            c.reset_belief(pt(0.0, 0.0));
            c.mouse_move_relative(10.0, 0.0).await.unwrap();
            c.mouse_move_relative(10.0, 0.0).await.unwrap();
            c.mouse_move_relative(10.0, 0.0).await.unwrap();
            let pos = c.belief.lock().unwrap().position;
            assert!((pos.x - 39.0).abs() < 0.1);
        }

        #[tokio::test]
        async fn set_belief_bounds_enables_clip_and_inflate_behaviour() {
            let c = new_test_client();
            c.set_belief_bounds(Some(BeliefBounds {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 800.0,
            }));
            c.reset_belief(pt(990.0, 400.0));

            let x_var_before = c.belief.lock().unwrap().variance().x;
            c.mouse_move_relative(50.0, 0.0).await.unwrap();

            let belief = c.belief.lock().unwrap();
            assert_eq!(belief.position.x, 1000.0);
            assert!(belief.variance().x > x_var_before);
        }

        #[tokio::test]
        async fn observe_cursor_pushes_a_measurement_into_the_belief() {
            let c = new_test_client();
            c.reset_belief(pt(0.0, 0.0));
            c.mouse_move_relative(10.0, 0.0).await.unwrap(); // belief now ≈ (13, 0)

            c.observe_cursor(pt(13.0, 0.0), 0.95, None);
            let belief = c.belief.lock().unwrap();
            assert!((belief.position.x - 13.0).abs() < 0.5);
            assert!(belief.variance().x < 2.0);
        }

        #[test]
        fn belief_is_initialised_wide_so_a_fresh_client_does_not_pretend_to_know_position() {
            let c = new_test_client();
            let region = c.belief.lock().unwrap().expected_region(Some(0.95));
            assert!(region.rx > 150.0);
            assert!(region.ry > 150.0);
        }

        #[tokio::test]
        async fn phase_315_default_bounds_prevent_belief_position_drift_to_extreme_negatives() {
            let c = new_test_client();
            c.reset_belief(pt(100.0, 100.0));
            for _ in 0..12 {
                c.mouse_move_relative(-127.0, 0.0).await.unwrap();
            }
            let pos = c.belief.lock().unwrap().position;
            assert!(pos.x >= 0.0);
            assert!(pos.y >= 0.0);
        }

        #[tokio::test]
        async fn emits_still_advance_the_keepalive_clock() {
            let c = new_test_client();
            c.reset_belief(pt(0.0, 0.0));
            c.mouse_move_relative(15.0, 0.0).await.unwrap();
            assert!(c.belief.lock().unwrap().position.x > 0.0);
        }

        #[tokio::test]
        async fn c1_p2_an_injected_belief_is_used_as_is() {
            let injected = create_default_belief();
            let c = PiKVMClient::with_request_fn(
                PiKVMConfig::new("mock.local", "admin", "x"),
                Some(injected),
                stub_request_fn(),
            );
            c.reset_belief(pt(100.0, 100.0));
            c.mouse_move_relative(20.0, 0.0).await.unwrap();
            let pos = c.belief.lock().unwrap().position;
            assert!((pos.x - 126.0).abs() < 0.1);
        }

        #[test]
        fn c1_p2_omitting_the_belief_still_yields_an_equivalent_default() {
            let a = new_test_client();
            let b = new_test_client();
            let ra = a.belief.lock().unwrap().expected_region(Some(0.95));
            let rb = b.belief.lock().unwrap().expected_region(Some(0.95));
            assert!((ra.rx - rb.rx).abs() < 1e-5);
        }

        mod stationary_cluster_rejection_wiring {
            use super::*;

            #[test]
            fn would_reject_as_stationary_returns_false_before_any_observation() {
                let c = new_test_client();
                c.reset_belief(pt(0.0, 0.0));
                assert!(!c.would_reject_as_stationary(pt(100.0, 100.0), None));
            }

            #[tokio::test]
            async fn would_reject_as_stationary_delegates_to_belief() {
                let c = new_test_client();
                c.reset_belief(pt(0.0, 0.0));
                c.observe_cursor(pt(970.0, 771.0), 0.9, None);
                c.mouse_move_relative(50.0, 0.0).await.unwrap();
                assert!(c.would_reject_as_stationary(pt(970.0, 771.0), None));
                assert!(!c.would_reject_as_stationary(pt(1100.0, 770.0), None));
            }

            #[tokio::test]
            async fn observe_cursor_with_reject_stationary_returns_false_on_lock_in() {
                let c = new_test_client();
                c.reset_belief(pt(0.0, 0.0));
                c.observe_cursor(pt(970.0, 771.0), 0.9, None);
                c.mouse_move_relative(50.0, 0.0).await.unwrap();
                let x_after_predict = c.belief.lock().unwrap().position.x;
                let accepted = c.observe_cursor(
                    pt(970.0, 771.0),
                    0.9,
                    Some(pikvm_mcp_cursor_belief::ObserveOptions {
                        reject_stationary: true,
                        ..Default::default()
                    }),
                );
                assert!(!accepted);
                assert_eq!(c.belief.lock().unwrap().position.x, x_after_predict);
            }

            #[tokio::test]
            async fn observe_cursor_with_reject_stationary_returns_true_on_a_clearly_moved_measurement(
            ) {
                let c = new_test_client();
                c.reset_belief(pt(0.0, 0.0));
                c.observe_cursor(pt(970.0, 771.0), 0.9, None);
                c.mouse_move_relative(50.0, 0.0).await.unwrap();
                let accepted = c.observe_cursor(
                    pt(1100.0, 770.0),
                    0.9,
                    Some(pikvm_mcp_cursor_belief::ObserveOptions {
                        reject_stationary: true,
                        ..Default::default()
                    }),
                );
                assert!(accepted);
            }
        }
    }

    /// Proves `PiKVMClient` routes its outbound requests through the
    /// configured proxy when `proxy_url` is set, and goes direct
    /// otherwise. Faithful port of `client-proxy.test.ts`'s intent
    /// (loopback origin + loopback proxy, no PiKVM, no TLS needed) —
    /// this is the unit-level guard for the loopback-proxy workaround
    /// (see `PiKVMConfig::proxy_url`'s doc).
    ///
    /// Adapted, not copied verbatim: the TS test's fake proxy only
    /// implements CONNECT tunnelling because undici's `ProxyAgent`
    /// CONNECT-tunnels even plain-HTTP origins (documented in that
    /// file's header) — reqwest instead forward-proxies plain `http://`
    /// targets (absolute-URI request line straight to the proxy, no
    /// CONNECT). This fixture's fake proxy handles BOTH wire forms so
    /// the test asserts the actual contract that matters ("does the
    /// client's traffic reach the proxy") rather than one library's
    /// specific wire-level choice.
    mod proxy_routing {
        use super::*;
        use std::net::SocketAddr;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};
        use tokio::sync::Mutex as TokioMutex;

        async fn read_request_head(sock: &mut TcpStream) -> Vec<u8> {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let n = sock.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            buf
        }

        /// Stands in for the PiKVM: answers `/api/auth/check` with 200,
        /// everything else 404. Tolerates both origin-form
        /// (`/api/auth/check`) and absolute-URI (`http://host/api/auth/check`)
        /// request lines, since it may be reached directly OR through
        /// the fake forward-proxy below.
        async fn spawn_origin() -> SocketAddr {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else {
                        break;
                    };
                    tokio::spawn(async move {
                        let buf = read_request_head(&mut sock).await;
                        let text = String::from_utf8_lossy(&buf);
                        let path = text
                            .lines()
                            .next()
                            .unwrap_or("")
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or("");
                        if path.ends_with("/api/auth/check") {
                            let body = b"{}";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = sock.write_all(resp.as_bytes()).await;
                            let _ = sock.write_all(body).await;
                        } else {
                            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                        }
                    });
                }
            });
            addr
        }

        /// Minimal proxy: records the target of every connection it
        /// handles, then blindly tunnels bytes to it — either via a real
        /// CONNECT response (CONNECT method) or by forwarding the
        /// already-buffered absolute-URI request verbatim (any other
        /// method), matching a real forward proxy either way.
        async fn spawn_fake_proxy() -> (SocketAddr, Arc<TokioMutex<Vec<String>>>) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let targets: Arc<TokioMutex<Vec<String>>> = Arc::new(TokioMutex::new(Vec::new()));
            let targets_bg = targets.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((sock, _)) = listener.accept().await else {
                        break;
                    };
                    tokio::spawn(handle_proxy_conn(sock, targets_bg.clone()));
                }
            });
            (addr, targets)
        }

        async fn handle_proxy_conn(mut sock: TcpStream, targets: Arc<TokioMutex<Vec<String>>>) {
            let buf = read_request_head(&mut sock).await;
            let text = String::from_utf8_lossy(&buf);
            let first_line = text.lines().next().unwrap_or("").to_string();
            let mut parts = first_line.split_whitespace();
            let method = parts.next().unwrap_or("");
            let target_field = parts.next().unwrap_or("");

            let target = if method == "CONNECT" {
                let (h, p) = target_field.split_once(':').unwrap_or((target_field, "80"));
                Some((h.to_string(), p.parse::<u16>().unwrap_or(80)))
            } else {
                url::Url::parse(target_field).ok().and_then(|u| {
                    u.host_str()
                        .map(|h| (h.to_string(), u.port_or_known_default().unwrap_or(80)))
                })
            };
            let Some((host, port)) = target else { return };
            targets.lock().await.push(format!("{host}:{port}"));

            let Ok(mut upstream) = TcpStream::connect((host.as_str(), port)).await else {
                return;
            };
            if method == "CONNECT" {
                let _ = sock
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await;
            } else {
                let _ = upstream.write_all(&buf).await;
            }
            let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
        }

        #[tokio::test]
        async fn routes_requests_through_the_proxy_when_proxy_url_is_set() {
            let origin_addr = spawn_origin().await;
            let (proxy_addr, targets) = spawn_fake_proxy().await;
            let config = PiKVMConfig {
                proxy_url: Some(format!("http://{proxy_addr}")),
                ..PiKVMConfig::new(format!("http://{origin_addr}"), "admin", "pw")
            };
            let client = PiKVMClient::new(config, None);
            assert!(client.check_auth().await);
            let seen = targets.lock().await;
            assert!(seen.iter().any(|t| t == &origin_addr.to_string()));
        }

        #[tokio::test]
        async fn connects_directly_no_proxy_when_proxy_url_is_unset() {
            let origin_addr = spawn_origin().await;
            let config = PiKVMConfig::new(format!("http://{origin_addr}"), "admin", "pw");
            let client = PiKVMClient::new(config, None);
            assert!(client.check_auth().await);
        }
    }

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
    mod streamer_idle_stop_retry {
        use super::*;
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
            let request_fn: RequestFn = Arc::new(move |_args: RequestArgs| {
                Box::pin(async move { Err(unavailable_error()) })
            });
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
}
