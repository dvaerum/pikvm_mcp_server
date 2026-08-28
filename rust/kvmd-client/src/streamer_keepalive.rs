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
//! proxy workaround), this connects through it via [`connect_via_proxy`] —
//! a hand-rolled CONNECT tunnel + TLS handshake, the same pattern as the TS
//! `ConnectTunnelAgent` (itself ported verbatim from georgs-mac-mini's
//! hardware-verified `scratch/ws-holder.mjs`). `tokio-tungstenite` has no
//! built-in HTTP(S) proxy support — the fix is to establish the tunnel by
//! hand and hand tokio-tungstenite an already-connected TLS stream, which
//! it accepts the same way `ws` accepted a custom `Agent`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};

const RECONNECT_BASE_MS: u64 = 1000;
const RECONNECT_MAX_MS: u64 = 30_000;

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
    closed: oneshot::Receiver<()>,
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

pub struct StreamerKeepalive {
    config: StreamerKeepaliveConfig,
    connect: ConnectFn,
    connected: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    reconnect_delay_ms: Arc<AtomicU64>,
    // Guards against concurrent ensure_started() calls each starting their
    // own connection attempt — the TS original's `this.connecting` promise-
    // sharing, adapted to Rust via a lock held for the duration of one
    // attempt rather than a shared in-flight Promise reference.
    connect_lock: Arc<Mutex<()>>,
}

impl StreamerKeepalive {
    pub fn new(config: StreamerKeepaliveConfig) -> Self {
        Self::with_connector(config, real_connector())
    }

    /// Test seam — inject a fake [`ConnectFn`] instead of the real
    /// networking connector.
    pub fn with_connector(config: StreamerKeepaliveConfig, connect: ConnectFn) -> Self {
        Self {
            config,
            connect,
            connected: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            reconnect_delay_ms: Arc::new(AtomicU64::new(RECONNECT_BASE_MS)),
            connect_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Idempotent: a no-op if already connected or stopped. Concurrent
    /// callers during a cold start serialize on `connect_lock` rather than
    /// each opening their own socket — behaviorally equivalent to the TS
    /// shared-in-flight-Promise approach (no caller returns before a
    /// connection attempt that was already started completes), even though
    /// the mechanism differs. Never returns an error — best-effort
    /// contract, matching the TS `ensureStarted()` doc.
    pub async fn ensure_started(&self) {
        if self.stopped.load(Ordering::SeqCst) || self.connected() {
            return;
        }
        let _guard = self.connect_lock.lock().await;
        // Re-check after acquiring the lock — another caller may have
        // already completed a connection attempt while this one waited.
        if self.stopped.load(Ordering::SeqCst) || self.connected() {
            return;
        }
        self.connect_once().await;
    }

    async fn connect_once(&self) {
        match (self.connect)(self.config.clone()).await {
            Ok(session) => {
                self.connected.store(true, Ordering::SeqCst);
                self.reconnect_delay_ms
                    .store(RECONNECT_BASE_MS, Ordering::SeqCst); // reset backoff on success
                self.spawn_close_watcher(session);
            }
            Err(()) => {
                self.schedule_reconnect();
            }
        }
    }

    /// Spawns a background task that waits for the session to close, then
    /// updates state and schedules a reconnect — the async equivalent of
    /// the TS `ws.once('close', ...)` handler.
    fn spawn_close_watcher(&self, session: WsSession) {
        let connected = self.connected.clone();
        let stopped = self.stopped.clone();
        let reconnect_delay_ms = self.reconnect_delay_ms.clone();
        let connect = self.connect.clone();
        let config = self.config.clone();
        let connect_lock = self.connect_lock.clone();
        tokio::spawn(async move {
            session.wait_closed().await;
            connected.store(false, Ordering::SeqCst);
            if stopped.load(Ordering::SeqCst) {
                return;
            }
            schedule_reconnect_task(
                connected,
                stopped,
                reconnect_delay_ms,
                connect,
                config,
                connect_lock,
            );
        });
    }

    fn schedule_reconnect(&self) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        schedule_reconnect_task(
            self.connected.clone(),
            self.stopped.clone(),
            self.reconnect_delay_ms.clone(),
            self.connect.clone(),
            self.config.clone(),
            self.connect_lock.clone(),
        );
    }

    /// Explicit teardown — cancels any future reconnect. Mainly for tests;
    /// a real MCP server process holds this for its full lifetime and never
    /// calls `stop()`.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.connected.store(false, Ordering::SeqCst);
    }
}

/// Free function (not a method) so it can be called from inside a spawned
/// task without borrowing `&self` past the task's lifetime. Exponential
/// backoff capped at RECONNECT_MAX_MS, faithful port of `scheduleReconnect`.
fn schedule_reconnect_task(
    connected: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    reconnect_delay_ms: Arc<AtomicU64>,
    connect: ConnectFn,
    config: StreamerKeepaliveConfig,
    connect_lock: Arc<Mutex<()>>,
) {
    let delay = reconnect_delay_ms.load(Ordering::SeqCst);
    reconnect_delay_ms.store((delay * 2).min(RECONNECT_MAX_MS), Ordering::SeqCst);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if stopped.load(Ordering::SeqCst) {
            return;
        }
        let guard = connect_lock.lock().await;
        if stopped.load(Ordering::SeqCst) || connected.load(Ordering::SeqCst) {
            return;
        }
        let result = connect(config.clone()).await;
        // Release the lock before scheduling any further work below — the
        // guard only needs to serialize concurrent connection ATTEMPTS
        // (the check-then-connect above), not the bookkeeping that follows.
        // Held past this point, it would alias `connect_lock` in the very
        // same scope this async block later needs to MOVE it into a
        // recursive schedule_reconnect_task call (the Err arm below).
        drop(guard);
        match result {
            Ok(session) => {
                connected.store(true, Ordering::SeqCst);
                reconnect_delay_ms.store(RECONNECT_BASE_MS, Ordering::SeqCst);
                let connected2 = connected.clone();
                let stopped2 = stopped.clone();
                let reconnect_delay_ms2 = reconnect_delay_ms.clone();
                let connect2 = connect.clone();
                let config2 = config.clone();
                let connect_lock2 = connect_lock.clone();
                tokio::spawn(async move {
                    session.wait_closed().await;
                    connected2.store(false, Ordering::SeqCst);
                    if stopped2.load(Ordering::SeqCst) {
                        return;
                    }
                    schedule_reconnect_task(
                        connected2,
                        stopped2,
                        reconnect_delay_ms2,
                        connect2,
                        config2,
                        connect_lock2,
                    );
                });
            }
            Err(()) => {
                schedule_reconnect_task(
                    connected,
                    stopped,
                    reconnect_delay_ms,
                    connect,
                    config,
                    connect_lock,
                );
            }
        }
    });
}

fn real_connector() -> ConnectFn {
    Arc::new(|config: StreamerKeepaliveConfig| Box::pin(real_connect(config)))
}

/// The real networking implementation — builds `wss://{host}/api/ws?stream=1`
/// (or `ws://` for an `http://` host, faithful port of the TS `wsUrl()`
/// protocol-mapping), connects through the CONNECT-tunnel proxy when
/// `proxy_url` is set, and hands the resulting stream to
/// `tokio_tungstenite`. Not independently unit-tested (real sockets, real
/// TLS, real kvmd auth headers) — covered by this crate's own hardware gate
/// once module 2 lands, the same "gate through the real entry point"
/// discipline as everything else this session; [`StreamerKeepalive`]'s
/// state-machine logic above is unit-tested via the injected [`ConnectFn`]
/// seam instead, which is where the actual reconnect/backoff/idempotency
/// risk lives.
async fn real_connect(config: StreamerKeepaliveConfig) -> ConnectResult {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;

    let mut url = url::Url::parse(&config.host).map_err(|_| ())?;
    url.set_path("/api/ws");
    url.set_query(Some("stream=1"));
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| ())?;

    let mut request = url.as_str().into_client_request().map_err(|_| ())?;
    request.headers_mut().insert(
        "X-KVMD-User",
        HeaderValue::from_str(&config.username).map_err(|_| ())?,
    );
    request.headers_mut().insert(
        "X-KVMD-Passwd",
        HeaderValue::from_str(&config.password).map_err(|_| ())?,
    );

    // Both the proxied and direct paths end up establishing our own TLS
    // stream by hand (rather than letting `connect_async` do it internally
    // for the direct case) so both branches produce the SAME concrete
    // `WebSocketStream<TlsStream<TcpStream>>` type — `connect_async`'s
    // auto-negotiated `MaybeTlsStream<TcpStream>` and a hand-built
    // `TlsStream<TcpStream>` are different types the compiler won't unify
    // across an if/else, and this codebase's target is always `wss://` in
    // practice anyway (PiKVM's own TLS, self-signed or not).
    let host = url.host_str().ok_or(())?.to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let tls_stream = match &config.proxy_url {
        Some(proxy_url) => connect_via_proxy(proxy_url, &host, port, config.verify_ssl)
            .await
            .map_err(|_| ())?,
        None => {
            let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
                .await
                .map_err(|_| ())?;
            let connector = build_tls_connector(config.verify_ssl);
            let server_name =
                rustls_pki_types::ServerName::try_from(host.clone()).map_err(|_| ())?;
            connector.connect(server_name, tcp).await.map_err(|_| ())?
        }
    };
    // `client_async`, NOT `client_async_tls` — `tls_stream` is already a
    // hand-established `tokio_rustls::client::TlsStream` (both the proxied
    // and direct branches above build their own TLS, see the comment
    // above). `client_async_tls` performs its OWN TLS wrap on whatever
    // stream it's handed, keyed off the request's `wss://` scheme, so
    // calling it here would perform a SECOND TLS handshake on top of the
    // already-encrypted stream. Live-caught against real hardware as
    // `IO error: received corrupt message of type InvalidContentType` —
    // rustls trying to parse outer-TLS ciphertext as a fresh ClientHello.
    // `client_async` does the WS handshake only, over whatever stream it's
    // given, which is what we actually want here.
    let (ws_stream, _resp) = tokio_tungstenite::client_async(request, tls_stream)
        .await
        .map_err(|_| ())?;

    let (close_tx, close_rx) = oneshot::channel();
    tokio::spawn(async move {
        use futures_util::StreamExt;
        let (_write, mut read) = ws_stream.split();
        while read.next().await.is_some() {
            // Drain incoming frames — this connection exists purely to
            // keep kvmd's stream-client count above zero, matching the TS
            // `ws.on('message', () => {})` drain. No data is consumed.
        }
        let _ = close_tx.send(());
    });

    Ok(WsSession { closed: close_rx })
}

/// CONNECT-tunnels through an HTTP(S) proxy, then TLS-wraps the resulting
/// socket against `target_host`. Faithful port of the TS
/// `ConnectTunnelAgent.createConnection` — raw TCP connect to the proxy,
/// hand-written `CONNECT host:port HTTP/1.1` request, wait for the `200`,
/// then negotiate TLS on the SAME socket before handing it onward.
async fn connect_via_proxy(
    proxy_url: &str,
    target_host: &str,
    target_port: u16,
    verify_ssl: bool,
) -> Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>, std::io::Error> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let proxy = url::Url::parse(proxy_url)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let proxy_host = proxy.host_str().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "proxy URL has no host")
    })?;
    let proxy_port = proxy.port_or_known_default().unwrap_or(80);

    let mut sock = tokio::net::TcpStream::connect((proxy_host, proxy_port)).await?;
    let connect_req = format!(
        "CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\n\r\n"
    );
    sock.write_all(connect_req.as_bytes()).await?;

    let mut buf = [0u8; 512];
    let n = sock.read(&mut buf).await?;
    let response = String::from_utf8_lossy(&buf[..n]);
    if !response.starts_with("HTTP/1.1 200") && !response.starts_with("HTTP/1.0 200") {
        let status_line = response.lines().next().unwrap_or("").to_string();
        return Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            format!("ConnectTunnelAgent: CONNECT failed: {status_line}"),
        ));
    }

    let tls_connector = build_tls_connector(verify_ssl);
    let server_name = rustls_pki_types::ServerName::try_from(target_host.to_string())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    tls_connector.connect(server_name, sock).await
}

/// rustls (as of the 0.23 line) needs a process-level `CryptoProvider`
/// installed explicitly before any `ClientConfig` can be built — it no
/// longer picks one automatically when multiple crypto backends could be
/// linked in. Caught live: this crate compiled and unit-tested cleanly
/// (the DI'd fake connector never touches real TLS), but the FIRST real
/// hardware run against the actual PiKVM panicked here — exactly the class
/// of bug this project's "gate through the real entry point" discipline
/// exists to catch. `Once`-guarded so calling this from multiple call
/// sites (or a caller that also installs a provider) doesn't panic on a
/// double-install.
fn ensure_crypto_provider() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

fn build_tls_connector(verify_ssl: bool) -> tokio_rustls::TlsConnector {
    ensure_crypto_provider();
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    if !verify_ssl {
        // The PiKVM's self-signed cert case — mirrors the TS
        // `rejectUnauthorized: this.config.verifySsl` (verify_ssl=false =>
        // don't reject unauthorized/self-signed certs).
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(NoCertVerification));
    }
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

/// Faithful equivalent of Node's `tls.connect({rejectUnauthorized: false})`
/// — accept any server certificate. Only used when `verify_ssl` is false
/// (the PiKVM's self-signed cert deployment case), never the default.
#[derive(Debug)]
struct NoCertVerification;

impl rustls::client::danger::ServerCertVerifier for NoCertVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &rustls_pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::aws_lc_rs::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    fn config() -> StreamerKeepaliveConfig {
        StreamerKeepaliveConfig {
            host: "https://192.168.1.50".into(),
            username: "admin".into(),
            password: "pw".into(),
            verify_ssl: false,
            proxy_url: None,
        }
    }

    type Closers = Arc<Mutex<Vec<oneshot::Sender<()>>>>;

    /// A fake connector whose sessions are closed by the TEST, not by real
    /// networking — the async equivalent of the TS `FakeSocket` DI seam.
    fn fake_connector_always_succeeds() -> (ConnectFn, Arc<AtomicU32>, Closers) {
        let calls = Arc::new(AtomicU32::new(0));
        let closers: Arc<Mutex<Vec<oneshot::Sender<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_c = calls.clone();
        let closers_c = closers.clone();
        let connect: ConnectFn = Arc::new(move |_config| {
            let calls = calls_c.clone();
            let closers = closers_c.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                let (tx, rx) = oneshot::channel();
                closers.lock().await.push(tx);
                Ok(WsSession { closed: rx })
            })
        });
        (connect, calls, closers)
    }

    fn fake_connector_always_fails() -> (ConnectFn, Arc<AtomicU32>) {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let connect: ConnectFn = Arc::new(move |_config| {
            let calls = calls_c.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(())
            })
        });
        (connect, calls)
    }

    #[tokio::test]
    async fn ensure_started_connects_and_reports_connected() {
        let (connect, calls, _closers) = fake_connector_always_succeeds();
        let ka = StreamerKeepalive::with_connector(config(), connect);

        ka.ensure_started().await;

        assert!(ka.connected());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ensure_started_is_idempotent_while_already_connected() {
        let (connect, calls, _closers) = fake_connector_always_succeeds();
        let ka = StreamerKeepalive::with_connector(config(), connect);

        ka.ensure_started().await;
        ka.ensure_started().await; // second call, already connected
        ka.ensure_started().await; // third call

        assert_eq!(calls.load(Ordering::SeqCst), 1); // only ONE real connection attempt
    }

    #[tokio::test]
    async fn concurrent_ensure_started_calls_share_one_in_flight_attempt() {
        let (connect, calls, _closers) = fake_connector_always_succeeds();
        let ka = Arc::new(StreamerKeepalive::with_connector(config(), connect));

        let ka1 = ka.clone();
        let ka2 = ka.clone();
        let ka3 = ka.clone();
        tokio::join!(
            async move { ka1.ensure_started().await },
            async move { ka2.ensure_started().await },
            async move { ka3.ensure_started().await },
        );

        assert!(ka.connected());
        assert_eq!(calls.load(Ordering::SeqCst), 1); // only one real connection attempt made
    }

    #[tokio::test]
    async fn a_connection_failure_never_panics_or_propagates_an_error() {
        let (connect, calls) = fake_connector_always_fails();
        let ka = StreamerKeepalive::with_connector(config(), connect);

        ka.ensure_started().await; // must not panic — best-effort contract

        assert!(!ka.connected());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_closed_connection_transitions_back_to_not_connected() {
        let (connect, _calls, closers) = fake_connector_always_succeeds();
        let ka = StreamerKeepalive::with_connector(config(), connect);
        ka.ensure_started().await;
        assert!(ka.connected());

        // Simulate the connection dropping — fire the fake session's close signal.
        let closer = closers.lock().await.pop().unwrap();
        let _ = closer.send(());
        // Give the spawned close-watcher task a chance to run.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(10)).await;

        assert!(!ka.connected());
    }

    #[tokio::test]
    async fn stop_prevents_any_further_reconnect_attempts() {
        let (connect, calls, closers) = fake_connector_always_succeeds();
        let ka = StreamerKeepalive::with_connector(config(), connect);
        ka.ensure_started().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        ka.stop();
        assert!(!ka.connected());

        // Even after stop(), calling ensure_started() again must be a no-op.
        ka.ensure_started().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1); // no new attempt

        // Drop the pending closer without firing it — stop() already marked
        // this keepalive terminal, so a late close signal (if it ever fired)
        // must not resurrect a reconnect either. Not exercised further here
        // since reconnect timing is covered by the dedicated backoff test
        // below with a controlled clock instead of a real sleep.
        drop(closers);
    }

    #[tokio::test(start_paused = true)]
    async fn reconnects_with_backoff_after_a_connection_failure() {
        let (connect, calls) = fake_connector_always_fails();
        let ka = StreamerKeepalive::with_connector(config(), connect);

        ka.ensure_started().await; // first attempt fails, schedules a reconnect
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Let the just-spawned reconnect task run up to its `sleep().await`
        // (registering the timer) before advancing the paused clock — a
        // freshly `tokio::spawn`'d task hasn't been polled yet at the point
        // `ensure_started()` returns, and `time::advance()` only affects
        // timers that are already registered.
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_millis(RECONNECT_BASE_MS - 1)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1); // not yet — one ms short

        tokio::time::advance(Duration::from_millis(2)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2); // reconnect fired
    }
}
