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
//! NOT yet wired (a later phase): `--allow-tool-login`'s pre-auth
//! session (a header-less `initialize` admitted, gated at the tool layer
//! via the `login` tool) and the `skill_*` dynamic tools. `server.rs`'s
//! `PikvmMcpServer` already has the `gate: Option<Arc<LoginGate>>` slot
//! for this — every session minted here passes `None`, matching stdio's
//! own behavior, until that phase lands.
//!
//! Session count in `/health` is NOT tracked (`rmcp`'s `SessionManager`
//! trait doesn't expose a cheap live count) — a documented simplification
//! of index.ts's `sessions: transports.size`, not silently dropped.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use pikvm_mcp_foundation::auth::HeaderAuthorizer;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::tower::StreamableHttpService;
use rmcp::transport::StreamableHttpServerConfig;

use crate::server::{PikvmMcpServer, SharedState};

/// Faithful port of `startHttpServer`. Binds `host:port`, serves `/mcp`
/// (the rmcp Streamable HTTP transport, auth-gated when `authorize` is
/// set) and `/health` (always open), and runs until the process is
/// killed (matching the stdio path's own `service.waiting()` — this
/// awaits `axum::serve` directly instead).
pub async fn run_http_server(
    shared: Arc<SharedState>,
    host: &str,
    port: u16,
    authorize: Option<HeaderAuthorizer>,
) -> anyhow::Result<()> {
    let secured = authorize.is_some();

    let mcp_service: StreamableHttpService<PikvmMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(PikvmMcpServer::new(shared.clone(), None)),
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
    let mcp_router = match authorize {
        Some(authorize) => {
            mcp_router.layer(middleware::from_fn_with_state(authorize, require_auth))
        }
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

/// Faithful port of `requireAuth`'s strict path: a request passes only
/// with a valid `Authorization` header, checked via the SAME
/// [`HeaderAuthorizer`] the login tool (a later phase) would use. No
/// header-less `initialize` admission here yet (`--allow-tool-login`,
/// deferred — see this file's header comment).
async fn require_auth(
    State(authorize): State<HeaderAuthorizer>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if authorize(auth_header).await {
        return next.run(request).await;
    }
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
