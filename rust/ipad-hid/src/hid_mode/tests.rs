//! Tests for the `hid_mode` module family (`types`, `resolver`,
//! `http_endpoint`). Split into its own file (Rust 2018+ submodule
//! layout) per the idiomatic-file-structure standing rule.

use super::http_endpoint::{HttpGetFn, HttpPostFn};
use super::*;
use pikvm_mcp_foundation::session_auth::basic_auth_header;
use std::sync::{Arc, Mutex};

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
    let ep = make_http_hid_mode_endpoint(HidModeHttpConfig::default(), HidModeHttpDeps::default());
    assert!(!ep.configured);
}

#[tokio::test]
async fn an_unconfigured_endpoint_reads_none() {
    let ep = make_http_hid_mode_endpoint(HidModeHttpConfig::default(), HidModeHttpDeps::default());
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
async fn end_to_end_a_successful_basic_auth_derive_resolves_the_mode_and_leaves_the_mover_allowed()
{
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
        reason.contains("reassembl") || reason.contains("unsettled") || reason.contains("settle")
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
