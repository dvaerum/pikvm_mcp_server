//! Per-session authentication state + the in-band `login` tool gate for the
//! Streamable HTTP transport (opt-in via `--allow-tool-login`).
//!
//! Faithful port of `src/session-auth.ts`.
//!
//! The transport mints one MCP Server per session, so auth state is
//! naturally per-session: a plain mutable flag the login tool flips and the
//! tool-gating reads. Two ways a session becomes authenticated, unified on
//! ONE authorizer:
//!   - header-at-connect (the DEFAULT, stricter path): a valid Basic
//!     `Authorization` header on the `initialize` request marks the session
//!     authenticated at creation; a session cannot even be opened without it
//!     (unless tool-login is enabled).
//!   - the `login` tool (opt-in): an agent authenticates a pre-auth session
//!     in-band, WITHOUT setting a custom header — same credentials,
//!     validated by the SAME authorizer.
//!
//! The password is only ever encoded into a throwaway Basic header handed
//! to the authorizer; it is never logged or stored.

use crate::auth::HeaderAuthorizer;
use base64::Engine as _;
use std::sync::{Arc, Mutex};

/// True once this session presented valid creds (header at connect, or `login`).
/// Shared (`Arc<Mutex<_>>`) rather than the TS original's plain mutable
/// object field — Rust needs an explicit shared-ownership wrapper for a flag
/// read/written from multiple call sites (the tool-gating check and the
/// login tool's write) the way a JS object reference is implicitly shared.
#[derive(Clone)]
pub struct SessionAuthState {
    authenticated: Arc<Mutex<bool>>,
}

impl SessionAuthState {
    pub fn new(authenticated: bool) -> Self {
        Self {
            authenticated: Arc::new(Mutex::new(authenticated)),
        }
    }

    pub fn is_authenticated(&self) -> bool {
        *self.authenticated.lock().unwrap()
    }

    fn set_authenticated(&self, value: bool) {
        *self.authenticated.lock().unwrap() = value;
    }
}

/// Build a Basic `Authorization` header value from raw credentials. Faithful
/// port of `basicAuthHeader`.
pub fn basic_auth_header(username: &str, password: &str) -> String {
    let raw = format!("{username}:{password}");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(raw)
    )
}

/// What createMcpServer needs to expose + enforce the `login` tool for one
/// session. Faithful port of the TS `LoginGate` interface.
pub struct LoginGate {
    pub session: SessionAuthState,
    authorize: HeaderAuthorizer,
}

impl LoginGate {
    /// Validate `{username, password}` via the shared authorizer; on success
    /// mark the session authenticated. Returns whether the credentials were
    /// accepted. Faithful port of `LoginGate.login`.
    pub async fn login(&self, username: &str, password: &str) -> bool {
        let header = basic_auth_header(username, password);
        let ok = (self.authorize)(Some(header)).await;
        if ok {
            self.session.set_authenticated(true);
        }
        ok
    }
}

/// Make a [`LoginGate`] backed by the same [`HeaderAuthorizer`] the header
/// path uses, so login-tool credentials are validated identically. Faithful
/// port of `makeLoginGate`.
pub fn make_login_gate(authorize: HeaderAuthorizer, session: SessionAuthState) -> LoginGate {
    LoginGate { session, authorize }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{make_static_authorizer, HttpAuth};

    #[test]
    fn basic_auth_header_encodes_username_and_password() {
        let header = basic_auth_header("admin", "secret");
        assert_eq!(
            header,
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode("admin:secret")
            )
        );
    }

    #[test]
    fn session_auth_state_starts_at_the_given_value() {
        assert!(!SessionAuthState::new(false).is_authenticated());
        assert!(SessionAuthState::new(true).is_authenticated());
    }

    #[tokio::test]
    async fn login_with_correct_credentials_authenticates_the_session() {
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        };
        let session = SessionAuthState::new(false);
        let gate = make_login_gate(make_static_authorizer(auth), session.clone());

        let ok = gate.login("admin", "secret").await;

        assert!(ok);
        assert!(session.is_authenticated());
    }

    #[tokio::test]
    async fn login_with_wrong_credentials_does_not_authenticate() {
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        };
        let session = SessionAuthState::new(false);
        let gate = make_login_gate(make_static_authorizer(auth), session.clone());

        let ok = gate.login("admin", "wrong").await;

        assert!(!ok);
        assert!(!session.is_authenticated());
    }

    #[tokio::test]
    async fn a_session_already_authenticated_stays_authenticated_after_a_failed_login_attempt() {
        // Faithful-port edge case: the TS gate never DE-authenticates on a
        // failed login — it only ever sets true on success, never false on
        // failure. Confirm the Rust port preserves that (a session that got
        // in via the header path shouldn't be locked out by a later bad
        // in-band login attempt).
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        };
        let session = SessionAuthState::new(true); // already authenticated
        let gate = make_login_gate(make_static_authorizer(auth), session.clone());

        let ok = gate.login("admin", "wrong").await;

        assert!(!ok);
        assert!(session.is_authenticated()); // still true — unaffected
    }
}
