//! The cascade-inference offload feature's axum route
//! (docs/cursor-offload-inference-design.md, task_d06561d91f58): a
//! dedicated-bearer-token-gated WS endpoint an offload helper connects out
//! to. Off by default — `run_http_server` only merges [`offload_router`]
//! when `PIKVM_OFFLOAD_ENABLED=1` resolved a token at startup (`main.rs`).

pub mod registry;
mod ws_handler;

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

pub use registry::{as_offload_inference_fn, OffloadState};

const BEARER_PREFIX: &str = "Bearer ";

/// Single bearer-token check reusing `foundation::auth::safe_equal`'s
/// existing constant-time compare (design doc §7: `header_matches` was
/// the wrong promotion target — nothing to promote there, it was already
/// `pub`; `safe_equal` is the actually-private function the original
/// review request meant). This is identity for the whole connection, not
/// per-message — the WS upgrade request is the only HTTP request this
/// route ever sees.
async fn require_offload_auth(
    State(state): State<Arc<OffloadState>>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix(BEARER_PREFIX));

    match presented {
        Some(token) if pikvm_mcp_foundation::auth::safe_equal(token, &state.token) => {
            next.run(request).await
        }
        _ => (
            StatusCode::UNAUTHORIZED,
            "Unauthorized: valid offload bearer token required",
        )
            .into_response(),
    }
}

/// The offload feature's whole router: one WS route, auth-gated in front
/// of the upgrade. Mounted by `http_server::run_http_server` only when the
/// feature is enabled — see that function's own doc comment.
pub fn offload_router(state: Arc<OffloadState>) -> Router {
    Router::new()
        .route("/offload/ws", get(ws_handler::offload_ws_handler))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_offload_auth,
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    use super::*;

    fn test_state() -> Arc<OffloadState> {
        Arc::new(OffloadState::new(
            "correct-token".to_string(),
            [0u8; 32],
            Duration::from_millis(200),
        ))
    }

    #[tokio::test]
    async fn missing_authorization_header_is_rejected() {
        let app = offload_router(test_state());
        let request = HttpRequest::get("/offload/ws").body(Body::empty()).unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_bearer_token_is_rejected() {
        let app = offload_router(test_state());
        let request = HttpRequest::get("/offload/ws")
            .header(axum::http::header::AUTHORIZATION, "Bearer wrong-token")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn non_bearer_authorization_scheme_is_rejected() {
        let app = offload_router(test_state());
        let request = HttpRequest::get("/offload/ws")
            .header(axum::http::header::AUTHORIZATION, "Basic dXNlcjpwYXNz")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn correct_bearer_token_passes_auth_and_reaches_the_ws_upgrade() {
        // Not a full WS handshake (needs the Upgrade/Connection headers +
        // Sec-WebSocket-Key too) -- this only proves auth doesn't reject
        // a genuinely correct token, i.e. the middleware's own pass/fail
        // boundary is right. A 401 here would mean the token check is
        // broken; anything else means auth passed and the request reached
        // the real handler (which then rejects it for missing WS upgrade
        // headers -- a different, expected failure this test isn't
        // asserting on).
        let app = offload_router(test_state());
        let request = HttpRequest::get("/offload/ws")
            .header(axum::http::header::AUTHORIZATION, "Bearer correct-token")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
