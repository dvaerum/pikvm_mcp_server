//! HTTP-backed `RecoveryTrigger` and UDC-state reader — the pikvm-nixos
//! localhost recovery helper's client side.
//!
//! Split out of `hid_recovery.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use std::sync::Arc;

use super::types::{
    udc_state_url, BoxFuture, EscalateResult, HostRecoveryAction, RecoveryTrigger, UdcState,
    UdcStateReaderFn,
};

/// HTTP client for the host recovery trigger (R2/R3a/R3b). POSTs `{ action }`
/// to the pikvm-nixos localhost helper with a bearer token. MCP end of the
/// [`RecoveryTrigger`] contract; unset `url` ⇒ `configured: false`.
pub fn make_http_recovery_trigger(
    url: Option<String>,
    token: Option<String>,
    verify_ssl: bool,
) -> RecoveryTrigger {
    let url = url.and_then(|u| {
        let trimmed = u.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let configured = url.is_some();
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!verify_ssl)
        .build()
        .expect("reqwest client build");

    let escalate_fn = {
        let url = url.clone();
        let token = token.clone();
        move |action: HostRecoveryAction| -> BoxFuture<'static, EscalateResult> {
            let url = url.clone();
            let token = token.clone();
            let client = client.clone();
            Box::pin(async move {
                let Some(url) = url else {
                    return EscalateResult {
                        ok: false,
                        message: "host recovery trigger not configured".to_string(),
                    };
                };
                let mut req = client
                    .post(&url)
                    .json(&serde_json::json!({ "action": action.as_str() }));
                if let Some(t) = &token {
                    req = req.bearer_auth(t);
                }
                match req.send().await {
                    Ok(res) => {
                        let status = res.status();
                        let ok = status.is_success();
                        let mut message =
                            format!("host trigger {}: HTTP {}", action.as_str(), status.as_u16());
                        if let Ok(body) = res.json::<serde_json::Value>().await {
                            if let Some(m) = body.get("message").and_then(|v| v.as_str()) {
                                message = m.to_string();
                            }
                        }
                        EscalateResult { ok, message }
                    }
                    Err(err) => {
                        if action == HostRecoveryAction::Reboot {
                            EscalateResult {
                                ok: true,
                                message: format!(
                                    "reboot initiated (host connection dropped: {err})"
                                ),
                            }
                        } else {
                            EscalateResult {
                                ok: false,
                                message: format!("host trigger {} failed: {err}", action.as_str()),
                            }
                        }
                    }
                }
            })
        }
    };

    RecoveryTrigger {
        configured,
        escalate_fn: Arc::new(escalate_fn),
    }
}

/// Build a reader for `GET {PIKVM_HID_RECOVERY_URL}/udc-state`. Returns the
/// parsed [`UdcState`] on HTTP 200, or **`None`** when the route is
/// unconfigured / unreachable / non-200 (so callers degrade: unknown ≠ down).
/// Reuses the same bearer token + TLS-verify as the recovery trigger.
pub fn make_udc_state_reader(
    url: Option<String>,
    token: Option<String>,
    verify_ssl: bool,
) -> UdcStateReaderFn {
    let base = url.and_then(|u| {
        let t = u.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let Some(base) = base else {
        return Arc::new(|| Box::pin(async { None }));
    };
    let full_url = udc_state_url(&base);
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!verify_ssl)
        .build()
        .expect("reqwest client build");

    Arc::new(move || -> BoxFuture<'static, Option<UdcState>> {
        let url = full_url.clone();
        let token = token.clone();
        let client = client.clone();
        Box::pin(async move {
            let mut req = client.get(&url);
            if let Some(t) = &token {
                req = req.bearer_auth(t);
            }
            let res = req.send().await.ok()?;
            if res.status().as_u16() != 200 {
                return None;
            }
            let body: serde_json::Value = res.json().await.ok()?;
            let state = body.get("state")?.as_str()?.to_string();
            let udc = body
                .get("udc")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let online = body
                .get("online")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Some(UdcState { udc, state, online })
        })
    })
}
