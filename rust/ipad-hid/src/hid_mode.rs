//! Stateless HID-mode derivation (pikvm-nixos #51).
//!
//! Faithful port of `src/pikvm/hid-mode.ts`.
//!
//! The appliance owns the HID mode (desktop = absolute/dual, ipad =
//! relative/single) and exposes it over a loopback token endpoint. The MCP
//! READS it and flips its own absolute/relative behaviour, holding no
//! second copy. Two source shapes:
//!
//!  - DECLARED (`--target ipad|desktop`, no endpoint) — the permanent,
//!    first-class config for stock-Arch pikvm01: fixed mode, always
//!    reachable, never settling.
//!  - ENDPOINT (`PIKVM_HIDMODE_URL` set) — the appliance: derive from GET
//!    /hidmode, short-TTL cached, FAIL-CLOSED when unreachable (mover ops
//!    refuse rather than guess), with a settling gate over the post-switch
//!    USB re-enumeration window.
//!
//! ADR-0002 Phase 1: the full set of mode-derived defaults a mover-adjacent
//! handler needs is computed ONCE per `resolve()` via `HidModeResolver::policy`,
//! rather than re-derived piecemeal at each call site.

use pikvm_mcp_detection_vision::brightness::VERY_DIM_THRESHOLD;
use pikvm_mcp_foundation::session_auth::basic_auth_header;
use pikvm_mcp_ipad_primitives::click_verify::{
    default_chunk_pace_ms_for, default_max_residual_px_for,
};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HidMode {
    Ipad,
    Desktop,
}

fn mode_str(m: HidMode) -> &'static str {
    match m {
        HidMode::Ipad => "ipad",
        HidMode::Desktop => "desktop",
    }
}

/// desktop => absolute mouse (dual gadget); ipad => relative mouse (single).
pub fn mode_is_absolute(mode: HidMode) -> bool {
    matches!(mode, HidMode::Desktop)
}

/// One parse of GET /hidmode. The endpoint reports the ASSEMBLED gadget, so
/// `mode` is the OBSERVED gadget (authoritative for driving); `None` =
/// unrecognisable / mid-reassembly (unsettled). `requested` is the marker's
/// INTENT and `settled` is "gadget recognisable" (NOT "the switch
/// succeeded"): `settled && requested != mode` is a next-boot-pending
/// divergence (drift) — the config (requested) will assemble on the next
/// reboot but differs from the current gadget.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HidModeReading {
    pub mode: Option<HidMode>,
    pub requested: Option<HidMode>,
    pub settled: bool,
}

pub struct WriteResult {
    pub ok: bool,
    pub message: String,
}

/// The MCP end of the /hidmode contract. `read` returns the mode, or
/// **`None`** when the route is unconfigured / unreachable / non-200
/// (unknown != a guessed mode).
pub struct HidModeEndpoint {
    pub configured: bool,
    pub read: Arc<dyn Fn() -> BoxFuture<'static, Option<HidModeReading>> + Send + Sync>,
    pub write: Arc<dyn Fn(HidMode) -> BoxFuture<'static, WriteResult> + Send + Sync>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeSource {
    Declared,
    Endpoint,
}

pub struct HidModeStatus {
    /// The resolved mode (observed gadget), or **`None`** = UNKNOWN
    /// (unreachable / unsettled / not yet read).
    pub mode: Option<HidMode>,
    pub source: ModeSource,
    pub reachable: bool,
    pub settling: bool,
    pub last_read_at: Option<u64>,
    /// The marker's intent from the last read (`None` for declared / not read).
    pub requested_mode: Option<HidMode>,
    /// The assembled gadget != the requested (next-boot) mode while
    /// recognisable => a next-boot-pending divergence.
    pub drift_detected: bool,
    pub mover_allowed: bool,
    pub mover_block_reason: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    CurveOneShot,
    DetectThenMove,
}

/// The full set of mode-derived defaults a mover-adjacent handler needs,
/// computed ONCE per `resolve()` instead of re-derived piecemeal at each
/// read site.
pub struct HidPolicy {
    pub mode: HidMode,
    pub mouse_absolute: bool,
    pub strategy: Strategy,
    // Round 2 Phase 0 / F11: do not collapse these two — both derive to
    // `!mouse_absolute` today, but forbid_slam_fallback gates the
    // AUTOMATIC fallback path, while forbid_slam_on_ipad gates even an
    // EXPLICIT caller request. A future mode/policy could need one true
    // and the other false.
    pub forbid_slam_fallback: bool,
    pub forbid_slam_on_ipad: bool,
    pub chunk_pace_ms: Option<u64>,
    pub max_residual_px: Option<f64>,
    /// Mode-only component of the dim-screen precheck threshold. Callers
    /// with a single-tap-style override still apply it on top — this is
    /// NOT the final per-call value.
    pub dim_threshold: f64,
    /// Whether the iPad tap-offset bias correction should be applied to
    /// the aim point. Desktop/absolute clicks by coordinate, no offset.
    pub apply_tap_bias: bool,
}

pub struct HidModeResolverOpts {
    /// Exactly one of `declared` / `endpoint` (enforced by the caller at startup).
    pub declared: Option<HidMode>,
    pub endpoint: Option<HidModeEndpoint>,
    /// Endpoint cache lifetime; a read within this window is reused, not re-fetched.
    pub ttl_ms: Option<u64>,
    /// Max time the settling gate stays closed after a switch before it
    /// AUTO-EXPIRES (the backstop that makes the gate un-latchable).
    pub settle_window_ms: Option<u64>,
    pub now: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
}

const DEFAULT_TTL_MS: u64 = 5000;
// Backstop for the settling gate. clear_settling() (health_check on UDC-online)
// is the fast path; this bounds the MAX time the mover stays gated when that
// path doesn't run, so a missed clear can't dead-latch the mover (the #51
// bug: settling was a one-way flag cleared ONLY by health_check, so polling
// status left it stuck until an MCP restart). 15s comfortably covers a real
// post-switch USB re-enumeration (a few seconds).
const DEFAULT_SETTLE_WINDOW_MS: u64 = 15000;

fn default_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis() as u64
}

/// Whether a UDC-state reading is confident enough to clear the settling
/// gate early (see `HidModeResolver::clear_settling`). Only a CONFIRMED-
/// online reading does — `None` (the UDC reader isn't wired) or
/// `{online: false}` (confirmed still offline) both leave the gate as-is
/// rather than guessing, relying on the resolver's own auto-expiry backstop
/// instead.
pub fn should_clear_settling_for(udc_state: Option<&crate::hid_recovery::UdcState>) -> bool {
    udc_state.is_some_and(|s| s.online)
}

pub struct MoverGate {
    pub allowed: bool,
    pub reason: Option<String>,
}

/// Resolves the HID mode the mover should use. Declared sources are trivial
/// and always allow moving. Endpoint sources cache the last good read for a
/// short TTL, fail closed when the endpoint can't be read (mover ops
/// REFUSE), and gate the mover during the re-enumeration window after a
/// detected switch.
pub struct HidModeResolver {
    declared: Option<HidMode>,
    endpoint: Option<HidModeEndpoint>,
    ttl_ms: u64,
    settle_window_ms: u64,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,

    last_good_mode: Option<HidMode>, // last VALID observed mode (persists across failures for change-detection)
    last_ok_at: Option<u64>,         // when last_good_mode was read (TTL anchor)
    current_mode: Option<HidMode>, // mode as of the last resolve: None when unreachable OR unsettled
    last_reading: Option<HidModeReading>, // last endpoint parse, for the drift diagnostic
    reachable: bool, // did the endpoint answer on the most recent resolve / cache-fresh
    settle_until: Option<u64>, // re-enum window deadline; settling === now() < settle_until (re-derived, never latches)
}

impl HidModeResolver {
    pub fn new(opts: HidModeResolverOpts) -> Self {
        let now = opts.now.unwrap_or_else(|| Arc::new(default_now));
        // Declared is known + reachable from the start; endpoint is UNKNOWN until read.
        let reachable = opts.declared.is_some();
        let (last_good_mode, current_mode) = match opts.declared {
            Some(d) => (Some(d), Some(d)),
            None => (None, None),
        };
        Self {
            declared: opts.declared,
            endpoint: opts.endpoint,
            ttl_ms: opts.ttl_ms.unwrap_or(DEFAULT_TTL_MS),
            settle_window_ms: opts.settle_window_ms.unwrap_or(DEFAULT_SETTLE_WINDOW_MS),
            now,
            last_good_mode,
            last_ok_at: None,
            current_mode,
            last_reading: None,
            reachable,
            settle_until: None,
        }
    }

    /// True when this resolver derives from an endpoint (vs a declared target).
    pub fn is_endpoint(&self) -> bool {
        self.endpoint.is_some()
    }

    /// Resolve the current mode. Declared -> the fixed value. Endpoint ->
    /// the cached value when fresh, else a re-read; a failed read yields
    /// **`None`** (fail-closed) and is never cached (so recovery is
    /// immediate). A read that returns a mode DIFFERENT from the last good
    /// one begins settling (a switch happened elsewhere).
    pub async fn resolve(&mut self) -> Option<HidMode> {
        if let Some(d) = self.declared {
            return Some(d);
        }
        let ep = self
            .endpoint
            .as_ref()
            .expect("endpoint must be set when declared is None");
        let t = (self.now)();
        if let Some(last_ok_at) = self.last_ok_at {
            if t.saturating_sub(last_ok_at) < self.ttl_ms {
                self.reachable = true;
                self.current_mode = self.last_good_mode; // fresh cache — no I/O
                return self.last_good_mode;
            }
        }
        let reading = (ep.read)().await;
        self.last_reading = reading.clone();
        let Some(reading) = reading else {
            self.reachable = false; // UNREACHABLE -> FAIL-CLOSED; never cached, so recovery is immediate
            self.current_mode = None;
            return None;
        };
        self.reachable = true;
        let Some(m) = reading.mode else {
            self.current_mode = None; // reachable but UNSETTLED (gadget mid-reassembly) -> fail-closed; not cached
            return None;
        };
        // The endpoint reports the OBSERVED gadget, so a changed observed
        // mode means the gadget re-assembled elsewhere — begin settling. (A
        // drift, where the gadget did NOT change, is surfaced separately in
        // status; it is not a settling event.)
        if let Some(last_good) = self.last_good_mode {
            if m != last_good {
                self.settle_until = Some(t + self.settle_window_ms);
            }
        }
        self.last_good_mode = Some(m);
        self.last_ok_at = Some(t);
        self.current_mode = Some(m);
        Some(m)
    }

    /// The mode as of the last resolve(): declared value, or the observed
    /// gadget mode, fail-closed to `None` when unreachable OR unsettled.
    fn resolved_mode(&self) -> Option<HidMode> {
        self.declared.or(self.current_mode)
    }

    /// Settling is RE-DERIVED from the clock, never a latched flag: true
    /// only while the bounded re-enum window is still open. It
    /// auto-expires (so a missed clear_settling() can't dead-latch the
    /// mover) and clear_settling() clears it early on confirmed UDC-online.
    fn is_settling(&self) -> bool {
        match self.settle_until {
            Some(until) => (self.now)() < until,
            None => false,
        }
    }

    /// requested(next-boot)!=observed while the gadget is recognisable =>
    /// a next-boot-pending divergence.
    fn drift(&self) -> bool {
        if self.declared.is_some() {
            return false;
        }
        match &self.last_reading {
            Some(r) if r.settled => {
                matches!((r.requested, r.mode), (Some(req), Some(m)) if req != m)
            }
            _ => false,
        }
    }

    /// Whether a mover op may proceed, and why not.
    pub fn mover_gate(&self) -> MoverGate {
        let mode = self.resolved_mode();
        if mode.is_none() {
            let reason = if self.declared.is_none() && self.reachable {
                "HID gadget not recognisable — it is mid-reassembly (unsettled); refusing to move until it settles"
            } else {
                "HID mode unknown — the appliance /hidmode endpoint is unreachable; refusing to move rather than guess the mode"
            };
            return MoverGate {
                allowed: false,
                reason: Some(reason.to_string()),
            };
        }
        if self.is_settling() {
            return MoverGate {
                allowed: false,
                reason: Some("HID re-enumerating after a mode switch — the target USB is not back online yet; retry once it reconnects".to_string()),
            };
        }
        MoverGate {
            allowed: true,
            reason: None,
        }
    }

    /// The mode-derived defaults a mover-adjacent handler needs, computed
    /// once. Returns **`None`** exactly when `mover_gate().allowed` is
    /// false (mode unknown or settling) — mirrors `mover_gate`'s
    /// fail-closed contract.
    pub fn policy(&self) -> Option<HidPolicy> {
        let gate = self.mover_gate();
        if !gate.allowed {
            return None;
        }
        // mover_gate().allowed === true implies resolved_mode() is Some
        // (see mover_gate's own None check above) — this expect documents
        // that invariant rather than re-deriving it.
        let m = self
            .resolved_mode()
            .expect("mover_gate().allowed implies resolved_mode() is Some");
        let mouse_absolute = mode_is_absolute(m);
        Some(HidPolicy {
            mode: m,
            mouse_absolute,
            strategy: if mouse_absolute {
                Strategy::DetectThenMove
            } else {
                Strategy::CurveOneShot
            },
            forbid_slam_fallback: !mouse_absolute,
            forbid_slam_on_ipad: !mouse_absolute,
            chunk_pace_ms: default_chunk_pace_ms_for(mouse_absolute),
            max_residual_px: default_max_residual_px_for(mouse_absolute),
            dim_threshold: if mouse_absolute {
                0.0
            } else {
                VERY_DIM_THRESHOLD
            },
            apply_tap_bias: !mouse_absolute,
        })
    }

    pub fn status(&self) -> HidModeStatus {
        let gate = self.mover_gate();
        let drift_detected = self.drift();
        let mut warnings = Vec::new();
        if drift_detected {
            let r = self
                .last_reading
                .as_ref()
                .expect("drift() true implies last_reading is Some");
            warnings.push(format!(
                "NEXT-BOOT PENDING: the appliance will boot into \"{}\" but the gadget is currently assembled as \"{}\" — the mover is correctly driving the current gadget \"{}\" (no wrong-mode risk); the requested mode takes effect on the next reboot.",
                mode_str(r.requested.expect("drift() true implies requested is Some")),
                mode_str(r.mode.expect("drift() true implies mode is Some")),
                mode_str(r.mode.expect("drift() true implies mode is Some")),
            ));
        }
        HidModeStatus {
            mode: self.resolved_mode(),
            source: if self.declared.is_some() {
                ModeSource::Declared
            } else {
                ModeSource::Endpoint
            },
            reachable: self.reachable,
            settling: self.is_settling(),
            last_read_at: self.last_ok_at,
            requested_mode: if self.declared.is_some() {
                None
            } else {
                self.last_reading.as_ref().and_then(|r| r.requested)
            },
            drift_detected,
            mover_allowed: gate.allowed,
            mover_block_reason: gate.reason,
            warnings,
        }
    }

    /// Force the next resolve() to re-read (a switch drops the session; on
    /// reconnect we must not trust the cache). Keeps last_good_mode for
    /// change-detection.
    pub fn mark_reconnect(&mut self) {
        self.last_ok_at = None;
    }

    /// Open a bounded settling window from now (a switch we initiated).
    /// Auto-expires after settle_window_ms; clear_settling() ends it early
    /// on confirmed UDC-online.
    pub fn begin_settling(&mut self) {
        self.settle_until = Some((self.now)() + self.settle_window_ms);
    }

    /// Clear the settling gate early — the integration calls this once the
    /// target HID is confirmed ONLINE (UDC ground truth; the kvmd flags
    /// lie). The window ALSO auto-expires without this, so a missed call
    /// can't dead-latch the mover (the #51 bug).
    pub fn clear_settling(&mut self) {
        self.settle_until = None;
    }

    /// Switch the appliance mode (POST /hidmode). Begins settling and
    /// forces a re-read on reconnect. The returned message is HONEST: the
    /// switch is requested, the session WILL drop, and the new mode is NOT
    /// live yet. Declared resolvers cannot switch (there is no endpoint to
    /// POST).
    pub async fn set(&mut self, mode: HidMode) -> WriteResult {
        let Some(endpoint) = &self.endpoint else {
            return WriteResult {
                ok: false,
                message:
                    "HID mode is fixed (declared target); there is no /hidmode endpoint to switch"
                        .to_string(),
            };
        };
        let r = (endpoint.write)(mode).await;
        self.begin_settling();
        self.mark_reconnect();
        WriteResult {
            ok: r.ok,
            message: format!(
                "mode switch to \"{}\" requested ({}). The session WILL drop and the new mode is NOT live yet — reconnect and re-read /hidmode before driving input.",
                mode_str(mode),
                r.message
            ),
        }
    }
}

type HttpGetFn = Arc<
    dyn Fn(
            String,
            HashMap<String, String>,
        ) -> BoxFuture<'static, anyhow::Result<(u16, serde_json::Value)>>
        + Send
        + Sync,
>;
type HttpPostFn = Arc<
    dyn Fn(
            String,
            HashMap<String, String>,
            String,
        ) -> BoxFuture<'static, anyhow::Result<(u16, serde_json::Value)>>
        + Send
        + Sync,
>;

#[derive(Default)]
pub struct HidModeHttpDeps {
    pub get: Option<HttpGetFn>,
    pub post: Option<HttpPostFn>,
}

#[derive(Default)]
pub struct HidModeHttpConfig {
    pub url: Option<String>,
    pub token: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub proxy_url: Option<String>,
    pub verify_ssl: Option<bool>,
    pub timeout_ms: Option<u64>,
}

fn build_http_client(
    verify_ssl: bool,
    proxy_url: Option<&str>,
    timeout_ms: u64,
) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(!verify_ssl)
        .timeout(std::time::Duration::from_millis(timeout_ms));
    if let Some(proxy_url) = proxy_url {
        if !proxy_url.is_empty() {
            builder =
                builder.proxy(reqwest::Proxy::all(proxy_url).expect("proxy URL should be valid"));
        }
    }
    builder.build().expect("reqwest client should build")
}

fn coerce_mode(v: Option<&serde_json::Value>) -> Option<HidMode> {
    match v.and_then(|v| v.as_str()) {
        Some("ipad") => Some(HidMode::Ipad),
        Some("desktop") => Some(HidMode::Desktop),
        _ => None,
    }
}

/// HTTP client for the appliance /hidmode endpoint. Two auth shapes, tried
/// in order:
///   1. Bearer token (PIKVM_HIDMODE_TOKEN) — the ORIGINAL on-box loopback
///      deployment (the standalone `pikvm-hidmode-endpoint` daemon at
///      127.0.0.1:8083). Unchanged.
///   2. HTTP Basic, using the SAME kvmd credentials the MCP already sends
///      for every other appliance call (`client.rs`) — the off-box
///      front-door deployment (nginx `auth_request`-gated dashboard auth),
///      which REJECTS a bearer token (401). A single instance only ever
///      points `PIKVM_HIDMODE_URL` at ONE endpoint, so either/or precedence
///      is sufficient — no need to send both simultaneously.
///
/// PROXY: routes through `cfg.proxy_url` when configured, exactly like
/// `client.rs` — required for the off-box front-door case.
///
/// TLS-verify defaults off for the loopback self-signed cert either way.
/// `read()` degrades to `None` on any non-200 / error so the resolver
/// fails closed.
pub fn make_http_hid_mode_endpoint(
    cfg: HidModeHttpConfig,
    deps: HidModeHttpDeps,
) -> HidModeEndpoint {
    // PIKVM_HIDMODE_URL is the FULL endpoint, per the appliance module
    // author's contract — used AS-IS, no route appended. GET and POST both
    // target it.
    let url = cfg.url.as_deref().unwrap_or("").trim().to_string();
    let configured = !url.is_empty();
    let timeout_ms = cfg.timeout_ms.unwrap_or(2000); // a hung /hidmode must not stall the mover gate / startup
    let verify_ssl = cfg.verify_ssl.unwrap_or(false);

    let auth_headers: Arc<dyn Fn() -> HashMap<String, String> + Send + Sync> = {
        let token = cfg.token.clone();
        let username = cfg.username.clone();
        let password = cfg.password.clone();
        Arc::new(move || {
            let mut h = HashMap::new();
            if let Some(token) = &token {
                h.insert("authorization".to_string(), format!("Bearer {token}"));
            } else if let (Some(u), Some(p)) = (&username, &password) {
                h.insert("authorization".to_string(), basic_auth_header(u, p));
            }
            h
        })
    };

    let get_fn: HttpGetFn = deps.get.unwrap_or_else(|| {
        let proxy_url = cfg.proxy_url.clone();
        Arc::new(move |u: String, headers: HashMap<String, String>| {
            let client = build_http_client(verify_ssl, proxy_url.as_deref(), timeout_ms);
            Box::pin(async move {
                let mut req = client.get(&u);
                for (k, v) in &headers {
                    req = req.header(k.as_str(), v.as_str());
                }
                let res = req.send().await?;
                let status = res.status().as_u16();
                let body = res
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or(serde_json::Value::Null);
                Ok((status, body))
            })
        })
    });
    let post_fn: HttpPostFn = deps.post.unwrap_or_else(|| {
        let proxy_url = cfg.proxy_url.clone();
        Arc::new(
            move |u: String, headers: HashMap<String, String>, body: String| {
                let client = build_http_client(verify_ssl, proxy_url.as_deref(), timeout_ms);
                Box::pin(async move {
                    let mut req = client
                        .post(&u)
                        .header("content-type", "application/json")
                        .body(body);
                    for (k, v) in &headers {
                        req = req.header(k.as_str(), v.as_str());
                    }
                    let res = req.send().await?;
                    let status = res.status().as_u16();
                    let resp_body = res
                        .json::<serde_json::Value>()
                        .await
                        .unwrap_or(serde_json::Value::Null);
                    Ok((status, resp_body))
                })
            },
        )
    });

    let read: Arc<dyn Fn() -> BoxFuture<'static, Option<HidModeReading>> + Send + Sync> = {
        let url = url.clone();
        let get_fn = get_fn.clone();
        let auth_headers = auth_headers.clone();
        Arc::new(move || {
            let url = url.clone();
            let get_fn = get_fn.clone();
            let headers = (auth_headers)();
            Box::pin(async move {
                if url.is_empty() {
                    return None;
                }
                match (get_fn)(url, headers).await {
                    Ok((200, body)) => Some(HidModeReading {
                        // `mode` = the OBSERVED assembled gadget (authoritative); requested/settled for drift.
                        mode: coerce_mode(body.get("mode")),
                        requested: coerce_mode(body.get("requested")),
                        settled: body
                            .get("settled")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    }),
                    // non-200 / error -> unreachable / auth / error -> unknown (fail-closed upstream)
                    _ => None,
                }
            })
        })
    };

    let write: Arc<dyn Fn(HidMode) -> BoxFuture<'static, WriteResult> + Send + Sync> = {
        let url = url.clone();
        let post_fn = post_fn.clone();
        let auth_headers = auth_headers.clone();
        Arc::new(move |mode: HidMode| {
            let url = url.clone();
            let post_fn = post_fn.clone();
            let headers = (auth_headers)();
            Box::pin(async move {
                if url.is_empty() {
                    return WriteResult {
                        ok: false,
                        message: "/hidmode endpoint not configured".to_string(),
                    };
                }
                let body = serde_json::json!({ "mode": mode_str(mode) }).to_string();
                match (post_fn)(url, headers, body).await {
                    Ok((status, resp_body)) => {
                        let ok = (200..300).contains(&status);
                        let message = resp_body
                            .get("message")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("POST /hidmode: HTTP {status}"));
                        WriteResult { ok, message }
                    }
                    Err(e) => WriteResult {
                        ok: false,
                        message: format!("POST /hidmode failed: {e}"),
                    },
                }
            })
        })
    };

    HidModeEndpoint {
        configured,
        read,
        write,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // --- in-memory fake endpoint (mirrors TS's fakeEndpoint) -----------------

    struct FakeEndpointState {
        mode: Option<HidMode>,
        requested: Option<HidMode>,
        settled: bool,
        reachable: bool,
        reads: usize,
        writes: Vec<HidMode>,
    }

    /// Cheaply-cloneable handle onto the fake endpoint's shared state — kept
    /// SEPARATE from the `HidModeEndpoint` value itself (which the resolver
    /// takes ownership of) so tests can still mutate/inspect the fake after
    /// handing the endpoint to a `HidModeResolver`.
    #[derive(Clone)]
    struct FakeHandle(Arc<Mutex<FakeEndpointState>>);

    impl FakeHandle {
        fn set(&self, mode: Option<HidMode>, reachable: bool) {
            let mut s = self.0.lock().unwrap();
            s.mode = mode;
            s.requested = mode;
            s.settled = true;
            s.reachable = reachable;
        }

        /// next-boot pending: the gadget stays `observed` while the yaml
        /// requests a different mode.
        fn set_drift(&self, observed: HidMode, requested: HidMode) {
            let mut s = self.0.lock().unwrap();
            s.mode = Some(observed);
            s.requested = Some(requested);
            s.settled = true;
            s.reachable = true;
        }

        fn reads(&self) -> usize {
            self.0.lock().unwrap().reads
        }

        fn writes(&self) -> Vec<HidMode> {
            self.0.lock().unwrap().writes.clone()
        }
    }

    /// In-memory fake endpoint (mirrors TS's `fakeEndpoint`). Returns the
    /// `HidModeEndpoint` (for the resolver to own) plus a `FakeHandle` (for
    /// the test to keep mutating/inspecting).
    fn fake_endpoint(mode: Option<HidMode>, reachable: bool) -> (HidModeEndpoint, FakeHandle) {
        let state = Arc::new(Mutex::new(FakeEndpointState {
            mode,
            requested: mode,
            settled: true,
            reachable,
            reads: 0,
            writes: Vec::new(),
        }));
        let read_state = state.clone();
        let read: Arc<dyn Fn() -> BoxFuture<'static, Option<HidModeReading>> + Send + Sync> =
            Arc::new(move || {
                let read_state = read_state.clone();
                Box::pin(async move {
                    let mut s = read_state.lock().unwrap();
                    s.reads += 1;
                    if s.reachable {
                        Some(HidModeReading {
                            mode: s.mode,
                            requested: s.requested,
                            settled: s.settled,
                        })
                    } else {
                        None
                    }
                })
            });
        let write_state = state.clone();
        let write: Arc<dyn Fn(HidMode) -> BoxFuture<'static, WriteResult> + Send + Sync> =
            Arc::new(move |m| {
                let write_state = write_state.clone();
                Box::pin(async move {
                    write_state.lock().unwrap().writes.push(m);
                    WriteResult {
                        ok: true,
                        message: "mode switching, wait ~8s; USB re-enumerates, session drops"
                            .to_string(),
                    }
                })
            });
        (
            HidModeEndpoint {
                configured: true,
                read,
                write,
            },
            FakeHandle(state),
        )
    }

    fn clock(t: Arc<Mutex<u64>>) -> Arc<dyn Fn() -> u64 + Send + Sync> {
        Arc::new(move || *t.lock().unwrap())
    }

    // --- hid-mode helpers -----------------------------------------------------

    #[test]
    fn maps_desktop_to_absolute_ipad_to_relative() {
        assert!(mode_is_absolute(HidMode::Desktop));
        assert!(!mode_is_absolute(HidMode::Ipad));
    }

    // --- make_http_hid_mode_endpoint ------------------------------------------

    #[tokio::test]
    async fn get_post_target_the_url_as_is_with_a_bearer_token_and_parse_the_contract_shapes() {
        let seen_get: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        type SeenPost = Vec<(String, String, Option<String>)>;
        let seen_post: Arc<Mutex<SeenPost>> = Arc::new(Mutex::new(Vec::new()));
        let get: HttpGetFn = {
            let seen_get = seen_get.clone();
            Arc::new(move |u, h| {
                seen_get.lock().unwrap().push(u);
                assert_eq!(
                    h.get("authorization").map(String::as_str),
                    Some("Bearer tok")
                );
                Box::pin(async {
                    Ok((
                        200,
                        serde_json::json!({"ok": true, "mode": "ipad", "requested": "ipad", "settled": true}),
                    ))
                })
            })
        };
        let post: HttpPostFn = {
            let seen_post = seen_post.clone();
            Arc::new(move |u, h, b| {
                seen_post
                    .lock()
                    .unwrap()
                    .push((u, b, h.get("authorization").cloned()));
                Box::pin(async {
                    Ok((
                        200,
                        serde_json::json!({"ok": true, "mode": "desktop", "message": "mode switching to desktop; USB re-enumerates and the active session drops (~5s)"}),
                    ))
                })
            })
        };
        let ep = make_http_hid_mode_endpoint(
            HidModeHttpConfig {
                url: Some("http://127.0.0.1:8083/hidmode".to_string()),
                token: Some("tok".to_string()),
                ..Default::default()
            },
            HidModeHttpDeps {
                get: Some(get),
                post: Some(post),
            },
        );
        assert!(ep.configured);
        let reading = (ep.read)().await.unwrap();
        assert_eq!(reading.mode, Some(HidMode::Ipad));
        assert_eq!(reading.requested, Some(HidMode::Ipad));
        assert!(reading.settled);
        assert_eq!(seen_get.lock().unwrap()[0], "http://127.0.0.1:8083/hidmode"); // AS-IS

        let w = (ep.write)(HidMode::Desktop).await;
        let posted = seen_post.lock().unwrap();
        assert_eq!(posted[0].0, "http://127.0.0.1:8083/hidmode");
        let parsed: serde_json::Value = serde_json::from_str(&posted[0].1).unwrap();
        assert_eq!(parsed, serde_json::json!({"mode": "desktop"}));
        assert_eq!(posted[0].2.as_deref(), Some("Bearer tok"));
        assert!(w.ok);
        assert!(w.message.contains("switching"));
    }

    #[tokio::test]
    async fn non_200_get_yields_none_fail_closed_upstream() {
        let get: HttpGetFn = Arc::new(|_u, _h| {
            Box::pin(async {
                Ok((
                    401,
                    serde_json::json!({"ok": false, "message": "unauthorized"}),
                ))
            })
        });
        let ep = make_http_hid_mode_endpoint(
            HidModeHttpConfig {
                url: Some("http://x/hidmode".to_string()),
                ..Default::default()
            },
            HidModeHttpDeps {
                get: Some(get),
                post: None,
            },
        );
        assert!((ep.read)().await.is_none());
    }

    #[tokio::test]
    async fn a_post_error_status_yields_ok_false_carrying_the_endpoint_message() {
        let post: HttpPostFn = Arc::new(|_u, _h, _b| {
            Box::pin(async {
                Ok((
                    502,
                    serde_json::json!({"ok": false, "message": "switch to ipad failed (rc=1)"}),
                ))
            })
        });
        let ep = make_http_hid_mode_endpoint(
            HidModeHttpConfig {
                url: Some("http://x/hidmode".to_string()),
                ..Default::default()
            },
            HidModeHttpDeps {
                get: None,
                post: Some(post),
            },
        );
        let w = (ep.write)(HidMode::Ipad).await;
        assert!(!w.ok);
        assert!(w.message.contains("failed"));
    }

    #[test]
    fn an_unconfigured_endpoint_reports_not_configured() {
        let ep =
            make_http_hid_mode_endpoint(HidModeHttpConfig::default(), HidModeHttpDeps::default());
        assert!(!ep.configured);
    }

    #[tokio::test]
    async fn an_unconfigured_endpoint_reads_none() {
        let ep =
            make_http_hid_mode_endpoint(HidModeHttpConfig::default(), HidModeHttpDeps::default());
        assert!((ep.read)().await.is_none());
    }

    #[tokio::test]
    async fn basic_auth_fallback_when_no_token_but_credentials_are_configured() {
        let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let get: HttpGetFn = {
            let seen = seen.clone();
            Arc::new(move |_u, h| {
                seen.lock().unwrap().push(h.get("authorization").cloned());
                Box::pin(async {
                    Ok((
                        200,
                        serde_json::json!({"mode": "ipad", "requested": "ipad", "settled": true}),
                    ))
                })
            })
        };
        let post: HttpPostFn = {
            let seen = seen.clone();
            Arc::new(move |_u, h, _b| {
                seen.lock().unwrap().push(h.get("authorization").cloned());
                Box::pin(async { Ok((200, serde_json::json!({"ok": true, "message": "ok"}))) })
            })
        };
        let ep = make_http_hid_mode_endpoint(
            HidModeHttpConfig {
                url: Some("https://appliance/hidmode".to_string()),
                username: Some("admin".to_string()),
                password: Some("admin".to_string()),
                ..Default::default()
            },
            HidModeHttpDeps {
                get: Some(get),
                post: Some(post),
            },
        );
        (ep.read)().await;
        (ep.write)(HidMode::Desktop).await;
        let expected = basic_auth_header("admin", "admin");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].as_deref(), Some(expected.as_str()));
        assert_eq!(seen[1].as_deref(), Some(expected.as_str()));
    }

    #[tokio::test]
    async fn token_takes_priority_over_username_password_when_both_are_configured() {
        let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let get: HttpGetFn = {
            let seen = seen.clone();
            Arc::new(move |_u, h| {
                *seen.lock().unwrap() = h.get("authorization").cloned();
                Box::pin(async {
                    Ok((
                        200,
                        serde_json::json!({"mode": "ipad", "requested": "ipad", "settled": true}),
                    ))
                })
            })
        };
        let ep = make_http_hid_mode_endpoint(
            HidModeHttpConfig {
                url: Some("http://127.0.0.1:8083/hidmode".to_string()),
                token: Some("tok".to_string()),
                username: Some("admin".to_string()),
                password: Some("admin".to_string()),
                ..Default::default()
            },
            HidModeHttpDeps {
                get: Some(get),
                post: None,
            },
        );
        (ep.read)().await;
        assert_eq!(seen.lock().unwrap().as_deref(), Some("Bearer tok"));
    }

    #[tokio::test]
    async fn no_token_and_no_or_incomplete_credentials_sends_no_authorization_header() {
        let cases: [(Option<&str>, Option<&str>); 3] =
            [(None, None), (Some("admin"), None), (None, Some("admin"))];
        for (username, password) in cases {
            let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(Some("unset".to_string())));
            let get: HttpGetFn = {
                let seen = seen.clone();
                Arc::new(move |_u, h| {
                    *seen.lock().unwrap() = h.get("authorization").cloned();
                    Box::pin(async {
                        Ok((
                            200,
                            serde_json::json!({"mode": "ipad", "requested": "ipad", "settled": true}),
                        ))
                    })
                })
            };
            let ep = make_http_hid_mode_endpoint(
                HidModeHttpConfig {
                    url: Some("http://x/hidmode".to_string()),
                    username: username.map(str::to_string),
                    password: password.map(str::to_string),
                    ..Default::default()
                },
                HidModeHttpDeps {
                    get: Some(get),
                    post: None,
                },
            );
            (ep.read)().await;
            assert!(
                seen.lock().unwrap().is_none(),
                "username={username:?} password={password:?}"
            );
        }
    }

    #[tokio::test]
    async fn end_to_end_a_successful_basic_auth_derive_resolves_the_mode_and_leaves_the_mover_allowed(
    ) {
        let get: HttpGetFn = Arc::new(|_u, _h| {
            Box::pin(async {
                Ok((
                    200,
                    serde_json::json!({"mode": "ipad", "requested": "ipad", "settled": true}),
                ))
            })
        });
        let ep = make_http_hid_mode_endpoint(
            HidModeHttpConfig {
                url: Some("https://appliance/hidmode".to_string()),
                username: Some("admin".to_string()),
                password: Some("admin".to_string()),
                ..Default::default()
            },
            HidModeHttpDeps {
                get: Some(get),
                post: None,
            },
        );
        let mut resolver = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(ep),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        assert_eq!(resolver.resolve().await, Some(HidMode::Ipad));
        let gate = resolver.mover_gate();
        assert!(gate.allowed);
        assert!(gate.reason.is_none());
    }

    #[tokio::test]
    async fn end_to_end_rejected_basic_auth_fails_closed_mover_refused() {
        let get: HttpGetFn = Arc::new(|_u, _h| {
            Box::pin(async { Ok((401, serde_json::json!({"message": "unauthorized"}))) })
        });
        let ep = make_http_hid_mode_endpoint(
            HidModeHttpConfig {
                url: Some("https://appliance/hidmode".to_string()),
                username: Some("admin".to_string()),
                password: Some("wrong".to_string()),
                ..Default::default()
            },
            HidModeHttpDeps {
                get: Some(get),
                post: None,
            },
        );
        let mut resolver = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(ep),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        assert!(resolver.resolve().await.is_none());
        let gate = resolver.mover_gate();
        assert!(!gate.allowed);
        let reason = gate.reason.unwrap().to_lowercase();
        assert!(
            reason.contains("unreachable")
                || reason.contains("refusing to guess")
                || reason.contains("guess")
        );
    }

    // --- HidModeResolver — declared ------------------------------------------

    #[tokio::test]
    async fn declared_returns_the_fixed_mode_always_reachable_never_settling() {
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: Some(HidMode::Ipad),
            endpoint: None,
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        assert_eq!(l.resolve().await, Some(HidMode::Ipad));
        let s = l.status();
        assert_eq!(s.mode, Some(HidMode::Ipad));
        assert_eq!(s.source, ModeSource::Declared);
        assert!(s.reachable);
        assert!(!s.settling);
        assert!(l.mover_gate().allowed);
    }

    #[tokio::test]
    async fn a_declared_resolver_cannot_be_switched() {
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: Some(HidMode::Desktop),
            endpoint: None,
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        let r = l.set(HidMode::Ipad).await;
        assert!(!r.ok);
        let msg = r.message.to_lowercase();
        assert!(msg.contains("no") || msg.contains("declared") || msg.contains("fixed"));
    }

    // --- HidModeResolver — endpoint --------------------------------------------

    #[tokio::test]
    async fn derives_the_mode_from_the_endpoint_mouse_absolute_follows() {
        let (endpoint, _fake) = fake_endpoint(Some(HidMode::Desktop), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        assert_eq!(l.resolve().await, Some(HidMode::Desktop));
        assert!(mode_is_absolute(l.resolve().await.unwrap()));
        assert_eq!(l.status().source, ModeSource::Endpoint);
    }

    #[tokio::test]
    async fn fail_closed_unreachable_mode_unknown_and_mover_refuses() {
        let (endpoint, _fake) = fake_endpoint(None, false);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        assert!(l.resolve().await.is_none());
        let gate = l.mover_gate();
        assert!(!gate.allowed);
        let reason = gate.reason.unwrap().to_lowercase();
        assert!(reason.contains("unknown") || reason.contains("unreachable"));
        assert!(!l.status().reachable);
    }

    #[tokio::test]
    async fn recovers_once_the_endpoint_answers_again() {
        let (endpoint, fake) = fake_endpoint(None, false);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        assert!(l.resolve().await.is_none());
        fake.set(Some(HidMode::Ipad), true);
        assert_eq!(l.resolve().await, Some(HidMode::Ipad)); // no TTL wait — failures are never cached
        assert!(l.mover_gate().allowed);
    }

    #[tokio::test]
    async fn short_ttl_cache_a_fresh_read_is_reused() {
        let t = Arc::new(Mutex::new(1000u64));
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Ipad), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: Some(5000),
            settle_window_ms: None,
            now: Some(clock(t.clone())),
        });
        l.resolve().await;
        l.resolve().await;
        l.resolve().await;
        assert_eq!(fake.reads(), 1); // cached within TTL
        *t.lock().unwrap() += 5001;
        l.resolve().await;
        assert_eq!(fake.reads(), 2); // re-read after TTL
    }

    #[tokio::test]
    async fn mark_reconnect_forces_a_re_read_even_within_the_ttl() {
        let t = Arc::new(Mutex::new(1000u64));
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Ipad), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: Some(5000),
            settle_window_ms: None,
            now: Some(clock(t.clone())),
        });
        l.resolve().await;
        assert_eq!(fake.reads(), 1);
        l.mark_reconnect();
        l.resolve().await;
        assert_eq!(fake.reads(), 2);
    }

    #[tokio::test]
    async fn settling_blocks_the_mover_until_confirmed_online() {
        let t = Arc::new(Mutex::new(1000u64));
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Ipad), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: Some(1),
            settle_window_ms: None,
            now: Some(clock(t.clone())),
        });
        l.resolve().await;
        assert!(l.mover_gate().allowed);
        fake.set(Some(HidMode::Desktop), true); // switched by another surface
        *t.lock().unwrap() += 10;
        l.resolve().await; // detects the change
        assert!(l.status().settling);
        assert!(!l.mover_gate().allowed);
        let reason = l.mover_gate().reason.unwrap().to_lowercase();
        assert!(
            reason.contains("re-enumerat") || reason.contains("settl") || reason.contains("online")
        );
        l.clear_settling(); // integration confirms HID online (UDC ground truth)
        assert!(l.mover_gate().allowed);
    }

    #[tokio::test]
    async fn settling_auto_expires_after_the_window_with_no_clear_settling() {
        let t = Arc::new(Mutex::new(1000u64));
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Ipad), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: Some(1),
            settle_window_ms: Some(15000),
            now: Some(clock(t.clone())),
        });
        l.resolve().await;
        fake.set(Some(HidMode::Desktop), true);
        *t.lock().unwrap() += 10;
        l.resolve().await; // detects the change -> settling
        assert!(l.status().settling);
        assert!(!l.mover_gate().allowed); // correctly gated DURING the re-enum window
                                          // ...no clear_settling(), no restart — just the clock advancing past the window.
        *t.lock().unwrap() += 15000;
        assert!(!l.status().settling); // re-derived from now(): window elapsed => open
        assert!(l.mover_gate().allowed); // self-healed — the latch is impossible
    }

    #[tokio::test]
    async fn settling_stays_closed_for_the_full_window() {
        let t = Arc::new(Mutex::new(1000u64));
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Ipad), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: Some(1),
            settle_window_ms: Some(15000),
            now: Some(clock(t.clone())),
        });
        l.resolve().await;
        fake.set(Some(HidMode::Desktop), true);
        *t.lock().unwrap() += 10; // t=1010: anchors the window => settle_until=1010+15000=16010
        l.resolve().await;
        assert!(!l.mover_gate().allowed);
        *t.lock().unwrap() += 14999; // t=16009: still inside the window (< 16010)
        assert!(!l.mover_gate().allowed);
        *t.lock().unwrap() += 2; // t=16011: past the window => gate re-opens
        assert!(l.mover_gate().allowed);
    }

    #[tokio::test]
    async fn the_first_read_does_not_settle() {
        let (endpoint, _fake) = fake_endpoint(Some(HidMode::Desktop), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        l.resolve().await;
        assert!(!l.status().settling);
        assert!(l.mover_gate().allowed);
    }

    #[tokio::test]
    async fn set_posts_the_new_mode_begins_settling_and_returns_an_honest_message() {
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Ipad), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        l.resolve().await;
        let r = l.set(HidMode::Desktop).await;
        assert_eq!(fake.writes(), vec![HidMode::Desktop]);
        assert!(r.ok);
        let msg = r.message.to_lowercase();
        assert!(
            msg.contains("not")
                && (msg.contains("live")
                    || msg.contains("session")
                    || msg.contains("reconnect")
                    || msg.contains("enumerat"))
        );
        assert!(l.status().settling); // held until confirmed online
        assert!(!l.mover_gate().allowed);
    }

    #[tokio::test]
    async fn drives_the_observed_gadget_not_the_request() {
        // it-03400 contract: settled = "gadget recognisable", NOT "switch
        // succeeded". requested (the next-boot mode, from the yaml) is ipad
        // but the gadget is still desktop => mode=observed=desktop; the
        // switch applies on the next reboot.
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Desktop), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        l.resolve().await;
        fake.set_drift(HidMode::Desktop, HidMode::Ipad); // next-boot pending: gadget desktop, requested ipad
        l.mark_reconnect();
        assert_eq!(l.resolve().await, Some(HidMode::Desktop)); // we drive the ACTUAL gadget — correct, not confidently-wrong
        assert!(l.mover_gate().allowed); // desktop IS a valid assembled mode
    }

    #[tokio::test]
    async fn surfaces_the_drift_diagnostic_in_status() {
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Desktop), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        l.resolve().await;
        assert!(!l.status().drift_detected); // requested==observed

        fake.set_drift(HidMode::Desktop, HidMode::Ipad);
        l.mark_reconnect();
        l.resolve().await;
        let s = l.status();
        assert!(s.drift_detected);
        assert_eq!(s.requested_mode, Some(HidMode::Ipad));
        assert_eq!(s.mode, Some(HidMode::Desktop)); // still driving the real gadget
        let joined = s.warnings.join(" ").to_lowercase();
        assert!(
            joined.contains("next-boot pending")
                || joined.contains("takes effect on the next reboot")
                || joined.contains("will boot into")
        );
    }

    #[tokio::test]
    async fn unsettled_mode_null_fail_closes_with_a_reassembly_reason() {
        let (endpoint, fake) = fake_endpoint(Some(HidMode::Ipad), true);
        let mut l = HidModeResolver::new(HidModeResolverOpts {
            declared: None,
            endpoint: Some(endpoint),
            ttl_ms: None,
            settle_window_ms: None,
            now: None,
        });
        l.resolve().await;
        fake.set(None, true); // reachable, but the gadget is mid-reassembly (mode=None)
        l.mark_reconnect();
        assert!(l.resolve().await.is_none());
        assert!(l.status().reachable); // the endpoint answered
        assert!(!l.mover_gate().allowed);
        let reason = l.mover_gate().reason.unwrap().to_lowercase();
        assert!(
            reason.contains("reassembl")
                || reason.contains("unsettled")
                || reason.contains("settle")
        );
    }

    // --- proxy routing (loopback origin + loopback proxy) -----------------------

    mod proxy_routing {
        use super::*;
        use std::net::SocketAddr;
        use std::sync::Mutex as StdMutex;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};

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

        /// Stands in for the appliance's /hidmode endpoint: answers GET
        /// with a valid reading.
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
                        if path.ends_with("/hidmode") {
                            let body = br#"{"mode":"ipad","requested":"ipad","settled":true}"#;
                            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
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

        /// Minimal forward/CONNECT proxy: records the target of every
        /// connection it handles, then blindly tunnels bytes to it.
        async fn spawn_fake_proxy() -> (SocketAddr, Arc<StdMutex<Vec<String>>>) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let targets: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
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

        async fn handle_proxy_conn(mut sock: TcpStream, targets: Arc<StdMutex<Vec<String>>>) {
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
            targets.lock().unwrap().push(format!("{host}:{port}"));

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
        async fn routes_the_get_hidmode_fetch_through_the_proxy_when_proxy_url_is_set() {
            let origin_addr = spawn_origin().await;
            let (proxy_addr, targets) = spawn_fake_proxy().await;
            let ep = make_http_hid_mode_endpoint(
                HidModeHttpConfig {
                    url: Some(format!("http://{origin_addr}/hidmode")),
                    proxy_url: Some(format!("http://{proxy_addr}")),
                    ..Default::default()
                },
                HidModeHttpDeps::default(),
            );
            let reading = (ep.read)().await.unwrap();
            assert_eq!(reading.mode, Some(HidMode::Ipad));
            assert!(targets
                .lock()
                .unwrap()
                .iter()
                .any(|t| t == &origin_addr.to_string()));
        }

        #[tokio::test]
        async fn connects_directly_no_proxy_when_proxy_url_is_unset() {
            let origin_addr = spawn_origin().await;
            let ep = make_http_hid_mode_endpoint(
                HidModeHttpConfig {
                    url: Some(format!("http://{origin_addr}/hidmode")),
                    ..Default::default()
                },
                HidModeHttpDeps::default(),
            );
            let reading = (ep.read)().await.unwrap();
            assert_eq!(reading.mode, Some(HidMode::Ipad));
        }
    }
}
