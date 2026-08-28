//! Error types for the kvmd REST client.

/// Thrown by `request()` instead of a bare error so callers that need to
/// distinguish "the server said no" (and specifically which status) from
/// any other failure don't have to parse the message. `.message` is
/// UNCHANGED from the pre-existing "PiKVM API error N: ..." text —
/// operator-hints.ts's pattern matching and its test suite both key off
/// that exact string; this is additive (a `.status`), not a format change.
#[derive(Debug, Clone)]
pub struct PiKVMApiError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for PiKVMApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for PiKVMApiError {}

/// Faithful port of `ClientError`'s union of failure shapes: a structured
/// API error (`PiKVMApiError`), the streamer-idle-stop-retry-exhausted
/// case (`StreamerUnavailableError`), and everything else (`Other`, e.g.
/// "Invalid or missing resolution data...", "Failed to read screenshot
/// dimensions"). Rust has no `instanceof`, so callers that need to
/// discriminate (the retry-once logic) match on this enum instead.
#[derive(Debug, Clone)]
pub enum ClientError {
    Api(PiKVMApiError),
    StreamerUnavailable(String),
    Other(String),
}

impl ClientError {
    /// `err instanceof PiKVMApiError` equivalent.
    pub fn api_status(&self) -> Option<u16> {
        match self {
            ClientError::Api(e) => Some(e.status),
            _ => None,
        }
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Api(e) => write!(f, "{e}"),
            ClientError::StreamerUnavailable(m) => write!(f, "{m}"),
            ClientError::Other(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for ClientError {}
