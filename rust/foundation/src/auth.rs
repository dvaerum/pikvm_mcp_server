//! HTTP authentication for the Streamable HTTP transport.
//!
//! Faithful port of `src/auth.ts`.
//!
//! The MCP HTTP endpoint drives real keyboard/mouse/screen input on a
//! physical machine, so anyone who can reach it can take over that machine.
//! When `--security yes` is chosen, every request to /mcp must present
//! credentials.
//!
//! Auth model ("Both"):
//!   - A request is authorized if it carries a valid HTTP Basic
//!     `Authorization` header (checked on EVERY request), OR
//!   - it carries an `Mcp-Session-Id` for a session that was opened with a
//!     valid header (a validated `initialize` authorizes the session for its
//!     lifetime).
//!
//! `initialize` has no session id yet, so it can only be authorized by the
//! header — you cannot open a session without credentials.

use base64::Engine as _;
use subtle::ConstantTimeEq;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpAuth {
    pub username: String,
    pub password: String,
}

/// Decides whether a request's `Authorization` header is acceptable.
/// Faithful port of the TS `HeaderAuthorizer` type — a boxed async closure
/// so a backend (e.g. `--security kvmd`, which asks kvmd) can be plugged in;
/// the static `--security yes` path resolves synchronously under the hood
/// but still returns the same future-returning shape for a uniform
/// call site.
pub type HeaderAuthorizer =
    std::sync::Arc<dyn Fn(Option<String>) -> futures_core_boxed::BoxFuture<bool> + Send + Sync>;

// A tiny local BoxFuture alias so this module doesn't need the full
// `futures` crate just for one type — matches the TS file's own
// minimalism (it didn't need to pull in any auth-specific framework either).
mod futures_core_boxed {
    use std::future::Future;
    use std::pin::Pin;
    pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
}

/// `--security yes`: authorize against fixed credentials (constant-time
/// compare). Faithful port of `makeStaticAuthorizer`.
pub fn make_static_authorizer(auth: HttpAuth) -> HeaderAuthorizer {
    std::sync::Arc::new(move |header: Option<String>| {
        let auth = auth.clone();
        Box::pin(async move { header_matches(&auth, header.as_deref()) })
    })
}

/// Constant-time byte compare that doesn't leak length via early return —
/// pads both inputs to the max length before comparing (matching the TS
/// `safeEqual`'s exact strategy), then separately folds in the REAL-length
/// equality via plain (non-constant-time) comparison so e.g. "pass" and
/// "pass\0" don't match. The TS original's own comment explains why this
/// two-step shape (constant-time content compare + plain length compare) is
/// intentional rather than a single simpler check — ported verbatim.
///
/// `pub` (not module-private) since the offload feature's bearer-token
/// check (docs/cursor-offload-inference-design.md §7, task_d06561d91f58)
/// reuses this directly against a raw token rather than constructing an
/// `HttpAuth`-shaped username+password pair for what's really a
/// single-value compare — `header_matches` above is already `pub` and was
/// the wrong promotion target (nothing to promote there); this is the
/// actually-private function the original review request meant.
pub fn safe_equal(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let len = ab.len().max(bb.len());
    let mut pa = vec![0u8; len];
    let mut pb = vec![0u8; len];
    pa[..ab.len()].copy_from_slice(ab);
    pb[..bb.len()].copy_from_slice(bb);
    let content_eq: bool = pa.ct_eq(&pb).into();
    content_eq && ab.len() == bb.len()
}

/// Parse an HTTP Basic `Authorization` header into its username/password.
/// Returns `None` for a missing/non-Basic/malformed header. Faithful port
/// of `parseBasicAuthHeader`.
pub fn parse_basic_auth_header(header: Option<&str>) -> Option<(String, String)> {
    let header = header?;
    let (scheme, encoded) = header.split_once(' ')?;
    if scheme.to_lowercase() != "basic" || encoded.is_empty() {
        return None;
    }
    let decoded_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoded = String::from_utf8(decoded_bytes).ok()?;
    // Only the FIRST colon separates user from pass (passwords may contain ':').
    let idx = decoded.find(':')?;
    Some((decoded[..idx].to_string(), decoded[idx + 1..].to_string()))
}

/// True when the supplied Basic-auth header matches the configured
/// credentials. Both fields are compared in constant time. Faithful port of
/// `headerMatches`.
pub fn header_matches(auth: &HttpAuth, header: Option<&str>) -> bool {
    let Some((username, password)) = parse_basic_auth_header(header) else {
        return false;
    };
    // Evaluate both comparisons (no short-circuit via `&&`'s eager operands
    // here — both safe_equal calls always run) so timing doesn't reveal
    // which field was wrong, matching the TS original's explicit comment
    // and structure.
    let user_ok = safe_equal(&username, &auth.username);
    let pass_ok = safe_equal(&password, &auth.password);
    user_ok && pass_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basic_header(username: &str, password: &str) -> String {
        let raw = format!("{username}:{password}");
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        )
    }

    #[test]
    fn parse_basic_auth_header_decodes_username_and_password() {
        let header = basic_header("admin", "secret");
        assert_eq!(
            parse_basic_auth_header(Some(&header)),
            Some(("admin".to_string(), "secret".to_string()))
        );
    }

    #[test]
    fn parse_basic_auth_header_returns_none_for_missing_header() {
        assert_eq!(parse_basic_auth_header(None), None);
    }

    #[test]
    fn parse_basic_auth_header_returns_none_for_non_basic_scheme() {
        let raw = base64::engine::general_purpose::STANDARD.encode("admin:secret");
        assert_eq!(
            parse_basic_auth_header(Some(&format!("Bearer {raw}"))),
            None
        );
    }

    #[test]
    fn parse_basic_auth_header_returns_none_for_malformed_base64() {
        assert_eq!(
            parse_basic_auth_header(Some("Basic not-valid-base64!!!")),
            None
        );
    }

    #[test]
    fn parse_basic_auth_header_returns_none_when_no_colon_present() {
        let raw = base64::engine::general_purpose::STANDARD.encode("nocolonhere");
        assert_eq!(parse_basic_auth_header(Some(&format!("Basic {raw}"))), None);
    }

    #[test]
    fn parse_basic_auth_header_password_may_contain_colons() {
        let header = basic_header("admin", "pass:with:colons");
        assert_eq!(
            parse_basic_auth_header(Some(&header)),
            Some(("admin".to_string(), "pass:with:colons".to_string()))
        );
    }

    #[test]
    fn header_matches_true_for_correct_credentials() {
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        };
        let header = basic_header("admin", "secret");
        assert!(header_matches(&auth, Some(&header)));
    }

    #[test]
    fn header_matches_false_for_wrong_password() {
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        };
        let header = basic_header("admin", "wrong");
        assert!(!header_matches(&auth, Some(&header)));
    }

    #[test]
    fn header_matches_false_for_wrong_username() {
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        };
        let header = basic_header("nope", "secret");
        assert!(!header_matches(&auth, Some(&header)));
    }

    #[test]
    fn header_matches_false_for_missing_header() {
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        };
        assert!(!header_matches(&auth, None));
    }

    #[test]
    fn header_matches_false_when_password_is_a_prefix_of_the_real_one() {
        // Regression target for the zero-padding scheme: a short guess padded
        // with zero bytes must NOT accidentally compare equal to a longer
        // real password whose own padding also introduces zero bytes.
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secretlong".into(),
        };
        let header = basic_header("admin", "secret");
        assert!(!header_matches(&auth, Some(&header)));
    }

    #[tokio::test]
    async fn make_static_authorizer_wraps_header_matches_as_an_async_authorizer() {
        let auth = HttpAuth {
            username: "admin".into(),
            password: "secret".into(),
        };
        let authorizer = make_static_authorizer(auth);
        let good = basic_header("admin", "secret");
        let bad = basic_header("admin", "wrong");
        assert!(authorizer(Some(good)).await);
        assert!(!authorizer(Some(bad)).await);
    }
}
