//! kvmd-backed client authentication for `--security kvmd` (unified auth).
//!
//! Faithful port of `src/kvmd-auth.ts`.
//!
//! Instead of checking the incoming /mcp client's HTTP Basic credentials
//! against a static file (`--security yes`), validate them against KVMD's
//! own user store so a user logs into /mcp with their **PiKVM**
//! username/password — one shared authority (`/etc/kvmd/htpasswd`). KVMD
//! hashes are passlib `{SSHA512}`, so validation MUST go through kvmd
//! (`GET /api/auth/check`), not a local hash check.
//!
//! This validates the CLIENT's credentials — a SEPARATE check from the
//! service credentials the PiKVM transport client (module 2) uses for the
//! server's own kvmd calls.
//!
//! Cost control: the transport's "Both" session model authorizes a session
//! once (at `initialize`), so kvmd is hit ~once per client session. A
//! short-TTL POSITIVE cache coalesces any header-only requests. Failures are
//! never cached (so a password change isn't locked out) — they just re-hit
//! kvmd, which applies its own throttling.

use crate::auth::{parse_basic_auth_header, HeaderAuthorizer};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

pub struct KvmdAuthOptions {
    /// PiKVM base URL (PIKVM_HOST) — the same host the service client talks to.
    pub host: String,
    /// Verify the kvmd TLS cert (usually false for PiKVM's self-signed cert).
    pub verify_ssl: bool,
    /// Optional loopback proxy (PIKVM_PROXY), same as the service client.
    pub proxy_url: Option<String>,
    /// Positive-cache TTL in ms. Default 60_000 (1 min).
    pub ttl_ms: Option<u64>,
}

type CheckFn =
    Arc<dyn Fn(String, String) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;
type NowFn = Arc<dyn Fn() -> u64 + Send + Sync>;

#[derive(Default)]
pub struct KvmdAuthDeps {
    /// Override the kvmd validation call (tests). Default: real GET /api/auth/check.
    pub check: Option<CheckFn>,
    /// Clock injection (tests). Default: a real millis-since-epoch clock.
    pub now: Option<NowFn>,
}

fn real_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// The real kvmd validation: GET {host}/api/auth/check with the client's
/// creds. Faithful port of `defaultKvmdCheck`.
fn default_kvmd_check(opts: &KvmdAuthOptions) -> CheckFn {
    let client = make_client(opts);
    let url = format!("{}/api/auth/check", opts.host.trim_end_matches('/'));
    Arc::new(move |username: String, password: String| {
        let client = client.clone();
        let url = url.clone();
        Box::pin(async move {
            let res = client
                .get(&url)
                .header("X-KVMD-User", username)
                .header("X-KVMD-Passwd", password)
                .send()
                .await;
            match res {
                Ok(r) => r.status() == reqwest::StatusCode::OK,
                Err(_) => false,
            }
        })
    })
}

fn make_client(opts: &KvmdAuthOptions) -> reqwest::Client {
    let mut builder = reqwest::Client::builder().danger_accept_invalid_certs(!opts.verify_ssl);
    if let Some(proxy_url) = &opts.proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .expect("kvmd-auth: failed to build HTTP client")
}

/// Build a [`HeaderAuthorizer`] that validates the incoming Basic
/// credentials against kvmd. Returns true iff kvmd accepts the (client)
/// credentials. Faithful port of `makeKvmdAuthorizer`.
pub fn make_kvmd_authorizer(opts: KvmdAuthOptions, deps: KvmdAuthDeps) -> HeaderAuthorizer {
    let check = deps.check.unwrap_or_else(|| default_kvmd_check(&opts));
    let now = deps.now.unwrap_or_else(|| Arc::new(real_now));
    let ttl_ms = opts.ttl_ms.unwrap_or(60_000);
    // key -> expiry timestamp. Keyed on user + a hash of the password (never
    // the plaintext password) so a rotated password expires the entry
    // naturally.
    let positive_cache: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));

    Arc::new(move |header: Option<String>| {
        let check = check.clone();
        let now = now.clone();
        let positive_cache = positive_cache.clone();
        Box::pin(async move {
            let Some((username, password)) = parse_basic_auth_header(header.as_deref()) else {
                return false;
            };
            let key = format!("{username}:{}", sha256_hex(&password));

            let cached_expiry = positive_cache.lock().unwrap().get(&key).copied();
            if let Some(expiry) = cached_expiry {
                if expiry > now() {
                    return true; // fresh positive hit
                }
                positive_cache.lock().unwrap().remove(&key); // stale (e.g. rotated password)
            }

            let ok = check(username, password).await;
            if ok {
                positive_cache.lock().unwrap().insert(key, now() + ttl_ms);
            }
            ok
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn basic_header(username: &str, password: &str) -> String {
        let raw = format!("{username}:{password}");
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        )
    }

    fn opts() -> KvmdAuthOptions {
        KvmdAuthOptions {
            host: "https://pikvm.example".into(),
            verify_ssl: false,
            proxy_url: None,
            ttl_ms: Some(1000),
        }
    }

    fn fixed_clock(ms: u64) -> NowFn {
        let counter = Arc::new(AtomicU64::new(ms));
        Arc::new(move || counter.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn accepts_when_the_injected_check_returns_true() {
        let check: CheckFn = Arc::new(|_u, _p| Box::pin(async { true }));
        let authorizer = make_kvmd_authorizer(
            opts(),
            KvmdAuthDeps {
                check: Some(check),
                now: None,
            },
        );
        let header = basic_header("admin", "secret");
        assert!(authorizer(Some(header)).await);
    }

    #[tokio::test]
    async fn rejects_when_the_injected_check_returns_false() {
        let check: CheckFn = Arc::new(|_u, _p| Box::pin(async { false }));
        let authorizer = make_kvmd_authorizer(
            opts(),
            KvmdAuthDeps {
                check: Some(check),
                now: None,
            },
        );
        let header = basic_header("admin", "wrong");
        assert!(!authorizer(Some(header)).await);
    }

    #[tokio::test]
    async fn rejects_a_missing_or_malformed_header_without_calling_check() {
        let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let calls_c = calls.clone();
        let check: CheckFn = Arc::new(move |_u, _p| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { true })
        });
        let authorizer = make_kvmd_authorizer(
            opts(),
            KvmdAuthDeps {
                check: Some(check),
                now: None,
            },
        );
        assert!(!authorizer(None).await);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_positive_result_is_cached_and_the_check_is_not_called_again_within_the_ttl() {
        let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let calls_c = calls.clone();
        let check: CheckFn = Arc::new(move |_u, _p| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { true })
        });
        let clock = fixed_clock(0);
        let authorizer = make_kvmd_authorizer(
            opts(),
            KvmdAuthDeps {
                check: Some(check),
                now: Some(clock),
            },
        );
        let header = basic_header("admin", "secret");

        assert!(authorizer(Some(header.clone())).await);
        assert!(authorizer(Some(header)).await); // second call, still within TTL

        assert_eq!(calls.load(Ordering::SeqCst), 1); // only ONE real check
    }

    #[tokio::test]
    async fn a_cached_positive_result_re_checks_kvmd_once_the_ttl_expires() {
        let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let calls_c = calls.clone();
        let check: CheckFn = Arc::new(move |_u, _p| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { true })
        });
        let counter = Arc::new(AtomicU64::new(0));
        let counter_c = counter.clone();
        let clock: NowFn = Arc::new(move || counter_c.load(Ordering::SeqCst));
        let authorizer = make_kvmd_authorizer(
            opts(),
            KvmdAuthDeps {
                check: Some(check),
                now: Some(clock),
            },
        );
        let header = basic_header("admin", "secret");

        assert!(authorizer(Some(header.clone())).await);
        counter.store(10_000, Ordering::SeqCst); // past the 1000ms TTL
        assert!(authorizer(Some(header)).await);

        assert_eq!(calls.load(Ordering::SeqCst), 2); // re-checked after expiry
    }

    #[tokio::test]
    async fn a_negative_result_is_never_cached_so_a_password_change_is_never_locked_out() {
        let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let calls_c = calls.clone();
        let check: CheckFn = Arc::new(move |_u, _p| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { false })
        });
        let authorizer = make_kvmd_authorizer(
            opts(),
            KvmdAuthDeps {
                check: Some(check),
                now: None,
            },
        );
        let header = basic_header("admin", "wrong");

        assert!(!authorizer(Some(header.clone())).await);
        assert!(!authorizer(Some(header)).await);

        assert_eq!(calls.load(Ordering::SeqCst), 2); // re-hit kvmd both times
    }

    #[tokio::test]
    async fn different_passwords_for_the_same_user_get_distinct_cache_entries() {
        // The cache key hashes the PASSWORD too (not just username) — a
        // rotated password must not accidentally hit a stale positive entry
        // keyed only on username.
        let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let calls_c = calls.clone();
        let check: CheckFn = Arc::new(move |_u, p: String| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { p == "correct" })
        });
        let authorizer = make_kvmd_authorizer(
            opts(),
            KvmdAuthDeps {
                check: Some(check),
                now: None,
            },
        );

        assert!(authorizer(Some(basic_header("admin", "correct"))).await);
        // A different password for the same user must re-hit the check, not
        // ride on the "correct" password's cached positive entry.
        assert!(!authorizer(Some(basic_header("admin", "different"))).await);

        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
