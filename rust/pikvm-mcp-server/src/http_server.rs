//! Streamable HTTP transport — faithful (partial) port of
//! `src/http-server.ts`.
//!
//! Uses `rmcp`'s own `StreamableHttpService` (session management, SSE,
//! JSON-RPC framing) nested under `/mcp` in an `axum::Router`, with a
//! thin auth middleware layered in front — matching the official
//! `simple_auth_streamhttp.rs` example's own shape (a
//! `middleware::from_fn_with_state` wrapping a `nest_service`), not a
//! hand-rolled transport (see docs/rust-port-plan.md §6).
//!
//! Phase C1/C2 (this increment): `--security no` (open), `--security
//! yes` (static Basic auth), `--security kvmd` (kvmd-backed) all work —
//! every request must carry a valid header, checked on every request via
//! the SAME [`HeaderAuthorizer`] the TS source uses. `/health` is always
//! unauthenticated.
//!
//! `--allow-tool-login`'s pre-auth session is wired: a header-less
//! `initialize` is admitted (opening a session the tool layer gates —
//! see `server.rs`'s `PikvmMcpServer::initialize`/`gate()`), and any
//! LATER request carrying that session's `Mcp-Session-Id` is admitted
//! regardless of headers, matching `http-server.ts`'s own
//! `sessionId && transports.has(sessionId)` fast path — rmcp's own
//! session manager is what actually validates the id is real; this
//! middleware only needs to avoid pre-emptively 401ing it. A
//! present-but-WRONG header is ALWAYS a hard 401, never downgraded to
//! pre-auth (matches `requireAuth`'s own documented "a header-LESS
//! initialize is the only admitted case" contract).
//!
//! `skill_*` dynamic tools are still NOT wired (a later phase).
//!
//! Session count in `/health` is NOT tracked (`rmcp`'s `SessionManager`
//! trait doesn't expose a cheap live count) — a documented simplification
//! of index.ts's `sessions: transports.size`, not silently dropped.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::tower::StreamableHttpService;
use rmcp::transport::StreamableHttpServerConfig;

use crate::server::{HeaderAuthed, PikvmAuthConfig, PikvmMcpServer, SharedState};

const MCP_SESSION_ID_HEADER: &str = "mcp-session-id";
/// A `tools/call`/`initialize` JSON-RPC body is small; refuse to buffer
/// an implausibly large one rather than let a malicious/broken client
/// force an unbounded allocation just to peek its `method` field.
const MAX_PEEK_BODY_BYTES: usize = 1024 * 1024;

/// Faithful port of `startHttpServer`. Binds `host:port`, serves `/mcp`
/// (the rmcp Streamable HTTP transport, auth-gated when `auth.authorize`
/// is set) and `/health` (always open), and runs until the process is
/// killed (matching the stdio path's own `service.waiting()` — this
/// awaits `axum::serve` directly instead).
pub async fn run_http_server(
    shared: Arc<SharedState>,
    host: &str,
    port: u16,
    auth: PikvmAuthConfig,
) -> anyhow::Result<()> {
    let secured = auth.authorize.is_some();
    let auth = Arc::new(auth);

    let factory_auth = auth.clone();
    let mcp_service: StreamableHttpService<PikvmMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(PikvmMcpServer::new(shared.clone(), factory_auth.clone())),
            LocalSessionManager::default().into(),
            // Faithful default config, widened only where the fixed
            // loopback-only `allowed_hosts` default would otherwise reject a
            // real `--host 0.0.0.0` deployment (rmcp's own DNS-rebinding
            // protection, not something the TS source ever had to consider —
            // Express doesn't validate Host by default). Include the actual
            // bind host + host:port pair alongside the safe loopback
            // defaults rather than replacing them.
            StreamableHttpServerConfig::default().with_allowed_hosts([
                host.to_string(),
                format!("{host}:{port}"),
                "localhost".to_string(),
                format!("localhost:{port}"),
                "127.0.0.1".to_string(),
                format!("127.0.0.1:{port}"),
            ]),
        );

    let mcp_router = Router::new().nest_service("/mcp", mcp_service);
    let mcp_router = match &auth.authorize {
        Some(_) => mcp_router.layer(middleware::from_fn_with_state(auth.clone(), require_auth)),
        None => mcp_router,
    };

    let app = Router::new()
        .route("/health", get(move || health(secured)))
        .merge(mcp_router);

    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let local_addr = listener.local_addr()?;
    eprintln!("PiKVM MCP Server running (Streamable HTTP) at http://{local_addr}/mcp");

    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(secured: bool) -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "transport": "streamable-http",
        "secured": secured,
    }))
}

fn unauthorized_response() -> Response {
    let body = Json(serde_json::json!({
        "jsonrpc": "2.0",
        "error": {"code": -32001, "message": "Unauthorized: valid credentials required"},
        "id": null,
    }));
    let mut response = (StatusCode::UNAUTHORIZED, body).into_response();
    response.headers_mut().insert(
        axum::http::header::WWW_AUTHENTICATE,
        axum::http::HeaderValue::from_static("Basic realm=\"pikvm-mcp\", charset=\"UTF-8\""),
    );
    response
}

/// Best-effort JSON-RPC `method` sniff: buffers the body (bounded by
/// [`MAX_PEEK_BODY_BYTES`]), checks whether it's an `initialize` call,
/// then hands back a fresh request with the SAME bytes so the downstream
/// rmcp service still sees the original body. Returns `None` (and the
/// request untouched) on any buffering/parse failure — treated as "not
/// an initialize", the safe default (falls through to a 401, never a
/// false admit).
async fn peek_is_initialize(request: Request) -> (Request, bool) {
    let (parts, body) = request.into_parts();
    let bytes = match to_bytes(body, MAX_PEEK_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return (Request::from_parts(parts, Body::empty()), false),
    };
    let is_initialize = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| {
            v.get("method")
                .and_then(|m| m.as_str())
                .map(|s| s == "initialize")
        })
        .unwrap_or(false);
    (Request::from_parts(parts, Body::from(bytes)), is_initialize)
}

/// Faithful port of `requireAuth`. A request passes if: (a) it carries a
/// valid `Authorization` header (checked via the SAME [`HeaderAuthorizer`]
/// the `login` tool uses), OR (b) it carries the `Mcp-Session-Id` of an
/// already-open session (rmcp's own session manager is the actual source
/// of truth for whether that id is real — a forged/expired one 400s
/// downstream, this middleware just doesn't pre-emptively block it), OR
/// (c) `allow_tool_login` is on, the request has NO header at all
/// (present-but-wrong is always a hard 401 — see below), and the body is
/// a JSON-RPC `initialize` call.
async fn require_auth(
    State(auth): State<Arc<PikvmAuthConfig>>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let Some(authorize) = &auth.authorize else {
        return next.run(request).await;
    };

    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if authorize(auth_header.clone()).await {
        return next.run(request).await;
    }

    if headers.contains_key(MCP_SESSION_ID_HEADER) {
        return next.run(request).await;
    }

    if auth.allow_tool_login && auth_header.is_none() {
        let (request, is_initialize) = peek_is_initialize(request).await;
        if is_initialize {
            let mut request = request;
            request.extensions_mut().insert(HeaderAuthed(false));
            return next.run(request).await;
        }
    }

    unauthorized_response()
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use http_body_util::BodyExt;
    use pikvm_mcp_foundation::auth::{make_static_authorizer, HttpAuth};
    use tower::ServiceExt;

    use super::*;

    fn test_auth(allow_tool_login: bool) -> Arc<PikvmAuthConfig> {
        let authorizer = make_static_authorizer(HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        });
        Arc::new(PikvmAuthConfig {
            authorize: Some(authorizer),
            allow_tool_login,
        })
    }

    fn basic_header(username: &str, password: &str) -> String {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
        )
    }

    fn initialize_body() -> Body {
        Body::from(
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
                .to_string(),
        )
    }

    fn tools_call_body() -> Body {
        Body::from(
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {}})
                .to_string(),
        )
    }

    /// Test-only downstream handler standing in for the real `/mcp`
    /// service — reports back whatever [`HeaderAuthed`] (if any) the
    /// middleware inserted, so the tests can assert on it directly rather
    /// than needing a real rmcp session behind the middleware.
    async fn probe_ext(request: Request) -> Response {
        let authed = request.extensions().get::<HeaderAuthed>().copied();
        Json(serde_json::json!({"header_authed": authed.map(|h| h.0)})).into_response()
    }

    fn app(auth: Arc<PikvmAuthConfig>) -> Router {
        Router::new()
            .route("/mcp", axum::routing::post(probe_ext))
            .layer(middleware::from_fn_with_state(auth, require_auth))
    }

    async fn send(app: Router, request: Request) -> (StatusCode, serde_json::Value) {
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn valid_header_passes_without_inserting_header_authed() {
        let request = Request::post("/mcp")
            .header(
                axum::http::header::AUTHORIZATION,
                basic_header("admin", "secret"),
            )
            .body(tools_call_body())
            .unwrap();
        let (status, body) = send(app(test_auth(false)), request).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["header_authed"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn invalid_header_with_no_session_id_is_rejected() {
        let request = Request::post("/mcp")
            .header(
                axum::http::header::AUTHORIZATION,
                basic_header("admin", "wrong"),
            )
            .body(tools_call_body())
            .unwrap();
        let (status, _) = send(app(test_auth(false)), request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn existing_session_id_bypasses_the_header_check() {
        let request = Request::post("/mcp")
            .header(MCP_SESSION_ID_HEADER, "some-open-session-id")
            .body(tools_call_body())
            .unwrap();
        let (status, _) = send(app(test_auth(false)), request).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn allow_tool_login_admits_a_header_less_initialize_as_unauthenticated() {
        let request = Request::post("/mcp").body(initialize_body()).unwrap();
        let (status, body) = send(app(test_auth(true)), request).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["header_authed"], serde_json::json!(false));
    }

    #[tokio::test]
    async fn allow_tool_login_still_rejects_a_header_less_non_initialize_call() {
        let request = Request::post("/mcp").body(tools_call_body()).unwrap();
        let (status, _) = send(app(test_auth(true)), request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn allow_tool_login_never_downgrades_a_present_but_wrong_header() {
        let request = Request::post("/mcp")
            .header(
                axum::http::header::AUTHORIZATION,
                basic_header("admin", "wrong"),
            )
            .body(initialize_body())
            .unwrap();
        let (status, _) = send(app(test_auth(true)), request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn without_allow_tool_login_a_header_less_initialize_is_still_rejected() {
        let request = Request::post("/mcp").body(initialize_body()).unwrap();
        let (status, _) = send(app(test_auth(false)), request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn peek_is_initialize_detects_the_initialize_method() {
        let request = Request::post("/mcp").body(initialize_body()).unwrap();
        let (_, is_init) = peek_is_initialize(request).await;
        assert!(is_init);
    }

    #[tokio::test]
    async fn peek_is_initialize_is_false_for_other_methods() {
        let request = Request::post("/mcp").body(tools_call_body()).unwrap();
        let (_, is_init) = peek_is_initialize(request).await;
        assert!(!is_init);
    }

    #[tokio::test]
    async fn peek_is_initialize_is_false_for_malformed_json_rather_than_erroring() {
        let request = Request::post("/mcp").body(Body::from("not json")).unwrap();
        let (_, is_init) = peek_is_initialize(request).await;
        assert!(!is_init);
    }
}
