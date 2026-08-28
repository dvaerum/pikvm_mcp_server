//! Shared config/handle/DI-seam types: the caller-facing config, a live
//! connection handle, and the injectable connector type both the state
//! machine (`keepalive`) and the real networking (`connection`) build on.

use std::sync::Arc;
use tokio::sync::oneshot;

pub(super) const RECONNECT_BASE_MS: u64 = 1000;
pub(super) const RECONNECT_MAX_MS: u64 = 30_000;

#[derive(Clone, Debug)]
pub struct StreamerKeepaliveConfig {
    /// Origin, e.g. "https://192.168.1.50" — same shape as the eventual
    /// PikvmConfig::host (module 1's `config::PikvmConfig`).
    pub host: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
    /// Same shape as PikvmConfig::proxy_url. Empty = connect directly.
    pub proxy_url: Option<String>,
}

/// A live connection handle: resolves when the connection closes (cleanly
/// or on error) — the async equivalent of the TS `MinimalWebSocket`'s
/// `once('close', ...)` event, collapsed into one future since Rust's
/// ownership model makes a single "this is now closed" signal more natural
/// than three separate event registrations for the same eventual outcome.
pub struct WsSession {
    pub(super) closed: oneshot::Receiver<()>,
}

impl WsSession {
    /// Waits for the connection to close, however it happens (clean close,
    /// error, or the connector's own read loop ending). Faithful behavioral
    /// equivalent of the TS `ws.once('close', ...)` firing.
    pub async fn wait_closed(self) {
        let _ = self.closed.await;
    }
}

/// Result of one connection attempt. `Ok` means the WS reached the OPEN
/// state at least once; the caller awaits `session.wait_closed()`
/// separately to learn when it later drops.
pub type ConnectResult = Result<WsSession, ()>;

/// Injectable connector — the test seam this module needs, mirroring the TS
/// `WebSocketFactory` injection point. Production code uses
/// [`real_connector`]; tests inject a fake that resolves/rejects on
/// command instead of touching a real socket.
pub type ConnectFn = Arc<
    dyn Fn(
            StreamerKeepaliveConfig,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ConnectResult> + Send>>
        + Send
        + Sync,
>;
