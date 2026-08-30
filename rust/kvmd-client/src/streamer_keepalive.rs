//! Streamer idle-stop workaround.
//!
//! Faithful port of `src/pikvm/streamer-keepalive.ts`.
//!
//! kvmd (PiKVM's daemon) lazily starts ustreamer: it spawns the process
//! when a video WS client connects (`GET /api/ws` — the `stream` query
//! param defaults to `true`, so a bare connection counts) and stops it
//! ~10s after the last one disconnects (kvmd's own `shutdown_delay`,
//! default 10.0). The MCP server calls `/streamer/snapshot` over plain
//! REST without ever being a stream client itself, so any screenshot
//! request arriving more than ~10s after the previous one races a dead
//! unix socket and 503s. HID is unaffected — this is video-only.
//!
//! [`StreamerKeepalive`] holds ONE persistent `/api/ws` connection open for
//! the life of the MCP server process, so kvmd's own stream-client count
//! never drops back to zero and ustreamer never idle-stops after the first
//! screenshot of a session. This does NOT fully close the race on its own:
//! kvmd's stream-client count going 0→1 still has to propagate through its
//! own poll loop and then actually fork+exec+bind ustreamer before
//! `/streamer/snapshot` can succeed, so the very first snapshot of a cold
//! session can still hit the dead socket once — the eventual `client.rs`'s
//! retry-once-on-503 covers that remaining window; this module's job is
//! narrower — make sure that after the first successful connect, ustreamer
//! never idle-stops again for the rest of the session.
//!
//! Best-effort by design: nothing here ever returns an error out of
//! [`StreamerKeepalive::ensure_started`]. A connection failure just means
//! the caller falls through to the retry-once safety net, same as if this
//! module didn't exist — capture must never become LESS reliable than the
//! pre-fix baseline, only more.
//!
//! PROXY: when `proxy_url` is set (the macOS Local Network loopback-CONNECT-
//! proxy workaround), this connects through it via `connect_via_proxy` —
//! a hand-rolled CONNECT tunnel + TLS handshake, the same pattern as the TS
//! `ConnectTunnelAgent` (itself ported verbatim from georgs-mac-mini's
//! hardware-verified `scratch/ws-holder.mjs`). `tokio-tungstenite` has no
//! built-in HTTP(S) proxy support — the fix is to establish the tunnel by
//! hand and hand tokio-tungstenite an already-connected TLS stream, which
//! it accepts the same way `ws` accepted a custom `Agent`.
//!
//! Split into `types` (config/handle/DI-seam types shared by the other
//! two), `keepalive` (the `StreamerKeepalive` reconnect/backoff state
//! machine + its tests), `connection` (the real `/api/ws` networking,
//! including an active ping/pong liveness probe — see its own header
//! comment for why passive close-detection alone isn't enough), `tls`
//! (crypto-provider install + the self-signed-cert bypass), and
//! `liveness` (the pure staleness DECISION `connection`'s ping/pong loop
//! feeds — no networking, unit-tested directly) — idiomatic Rust 2018+
//! module layout, one responsibility per file, rather than one file
//! mirroring the single TS source.

mod connection;
mod keepalive;
mod liveness;
mod tls;
mod types;

pub use keepalive::StreamerKeepalive;
pub use types::{ConnectFn, ConnectResult, StreamerKeepaliveConfig, WsSession};
