//! Real HTTP-backed `HidModeEndpoint`: talks to the appliance's
//! /hidmode endpoint over REST, with bearer-token or HTTP-Basic auth.
//!
//! Split out of `hid_mode.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use pikvm_mcp_foundation::session_auth::basic_auth_header;
use std::collections::HashMap;
use std::sync::Arc;

use super::types::{mode_str, BoxFuture, HidMode, HidModeEndpoint, HidModeReading, WriteResult};

pub(super) type HttpGetFn = Arc<
    dyn Fn(
            String,
            HashMap<String, String>,
        ) -> BoxFuture<'static, anyhow::Result<(u16, serde_json::Value)>>
        + Send
        + Sync,
>;
pub(super) type HttpPostFn = Arc<
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
