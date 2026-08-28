//! The real networking implementation: builds the `/api/ws` request,
//! establishes TLS by hand (directly or through the macOS loopback
//! CONNECT-tunnel proxy), and hands the resulting stream to
//! `tokio_tungstenite`. Not independently unit-tested (real sockets, real
//! TLS, real kvmd auth headers) — covered by this crate's own hardware
//! gate; `keepalive`'s state-machine logic is unit-tested via the
//! injected `ConnectFn` seam instead, which is where the actual
//! reconnect/backoff/idempotency risk lives.

use std::sync::Arc;
use tokio::sync::oneshot;

use super::tls::build_tls_connector;
use super::types::{ConnectFn, ConnectResult, StreamerKeepaliveConfig, WsSession};

pub(super) fn real_connector() -> ConnectFn {
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
