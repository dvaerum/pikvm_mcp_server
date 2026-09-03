//! HTTP CONNECT proxy tunneling — this project's own established fix for
//! this Mac's TCC-restricted outbound network access (see the loopback
//! tinyproxy convention, `PIKVM_PROXY`), applied here so the offload
//! helper can reach a real server from an otherwise-restricted machine.
//! See `connection.rs`'s own call site for why this hands back a plain
//! `TcpStream` the WS/TLS handshake then treats identically to a direct
//! connection.

use anyhow::{bail, Context};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::handshake::client::Request;

/// A CONNECT response header block larger than this without terminating
/// is treated as a protocol error, not an unbounded read.
const MAX_HEADER_BYTES: usize = 8192;

/// Dial the real target — directly, or tunneled through an HTTP CONNECT
/// proxy when `proxy_url` is set.
pub(super) async fn dial(request: &Request, proxy_url: Option<&str>) -> anyhow::Result<TcpStream> {
    let uri = request.uri();
    let host = uri.host().context("server URL has no host")?;
    let default_port = match uri.scheme_str() {
        Some("wss") | Some("https") => 443,
        _ => 80,
    };
    let port = uri.port_u16().unwrap_or(default_port);

    match proxy_url {
        None => TcpStream::connect((host, port))
            .await
            .with_context(|| format!("connecting directly to {host}:{port}")),
        Some(proxy_url) => connect_via_proxy(proxy_url, host, port).await,
    }
}

async fn connect_via_proxy(
    proxy_url: &str,
    target_host: &str,
    target_port: u16,
) -> anyhow::Result<TcpStream> {
    let proxy_authority = proxy_url
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let mut stream = TcpStream::connect(proxy_authority)
        .await
        .with_context(|| format!("connecting to proxy {proxy_authority}"))?;

    let connect_request = format!(
        "CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\n\r\n"
    );
    stream
        .write_all(connect_request.as_bytes())
        .await
        .context("writing CONNECT request to proxy")?;

    let header = read_connect_response_headers(&mut stream).await?;
    let status_line = header_status_line(&header);
    if !connect_status_is_success(status_line) {
        bail!("proxy CONNECT to {target_host}:{target_port} was rejected: {status_line}");
    }

    Ok(stream)
}

/// Reads one byte at a time until the blank line (`\r\n\r\n`) that ends an
/// HTTP response's headers. Deliberately NOT a `BufReader` — a buffered
/// reader could pull in (and then silently discard on drop) bytes
/// belonging to the tunnel's own traffic if the proxy's response and the
/// target's first bytes happen to arrive in the same TCP segment. A
/// plain byte-at-a-time read over a few hundred bytes is a one-time cost
/// per connection attempt, not a hot path.
async fn read_connect_response_headers(stream: &mut TcpStream) -> anyhow::Result<Vec<u8>> {
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = stream
            .read(&mut byte)
            .await
            .context("reading CONNECT response from proxy")?;
        if n == 0 {
            bail!("proxy closed the connection before completing the CONNECT response");
        }
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            return Ok(header);
        }
        if header.len() > MAX_HEADER_BYTES {
            bail!("proxy's CONNECT response headers exceeded {MAX_HEADER_BYTES} bytes without terminating");
        }
    }
}

fn header_status_line(header: &[u8]) -> &str {
    let text = std::str::from_utf8(header).unwrap_or("");
    text.split("\r\n").next().unwrap_or("")
}

/// True for any 2xx status — tinyproxy's own exact wording is
/// `HTTP/1.1 200 Connection established`, but any 2xx is a legitimate
/// "tunnel is up" per RFC 7231.
fn connect_status_is_success(status_line: &str) -> bool {
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (200..300).contains(&code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_tinyproxys_own_exact_wording() {
        assert!(connect_status_is_success(
            "HTTP/1.1 200 Connection established"
        ));
    }

    #[test]
    fn accepts_any_2xx_status() {
        assert!(connect_status_is_success("HTTP/1.1 200 OK"));
        assert!(connect_status_is_success("HTTP/1.0 299 Whatever"));
    }

    #[test]
    fn rejects_non_2xx_status() {
        assert!(!connect_status_is_success(
            "HTTP/1.1 407 Proxy Authentication Required"
        ));
        assert!(!connect_status_is_success("HTTP/1.1 502 Bad Gateway"));
    }

    #[test]
    fn rejects_malformed_status_lines_rather_than_panicking() {
        assert!(!connect_status_is_success(""));
        assert!(!connect_status_is_success("garbage"));
        assert!(!connect_status_is_success("HTTP/1.1 not-a-number OK"));
    }

    #[test]
    fn header_status_line_extracts_just_the_first_line() {
        let header = b"HTTP/1.1 200 Connection established\r\nX-Something: value\r\n\r\n";
        assert_eq!(
            header_status_line(header),
            "HTTP/1.1 200 Connection established"
        );
    }

    #[tokio::test]
    async fn dial_without_a_proxy_connects_directly() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accept = tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let request: Request = format!("ws://{addr}/test").into_client_request_test();
        let result = dial(&request, None).await;
        assert!(result.is_ok(), "{result:?}");
        accept.await.unwrap();
    }

    #[tokio::test]
    async fn connect_via_proxy_succeeds_on_a_2xx_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();
        let fake_proxy = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            // Drain the CONNECT request line-by-line up to the blank line,
            // then answer with a real 200.
            let mut buf = [0u8; 1];
            let mut seen = Vec::new();
            loop {
                socket.read_exact(&mut buf).await.unwrap();
                seen.push(buf[0]);
                if seen.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            socket
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            // Keep the socket open briefly so the client's read doesn't
            // see EOF before it finishes parsing the status line.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        });

        let result =
            connect_via_proxy(&format!("http://{proxy_addr}"), "example.invalid", 443).await;
        assert!(result.is_ok(), "{result:?}");
        fake_proxy.await.unwrap();
    }

    #[tokio::test]
    async fn connect_via_proxy_fails_on_a_rejected_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();
        let fake_proxy = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1];
            let mut seen = Vec::new();
            loop {
                socket.read_exact(&mut buf).await.unwrap();
                seen.push(buf[0]);
                if seen.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            socket
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                .await
                .unwrap();
        });

        let result =
            connect_via_proxy(&format!("http://{proxy_addr}"), "example.invalid", 443).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("rejected"));
        fake_proxy.await.unwrap();
    }

    /// Test-only helper: `IntoClientRequest` isn't directly nameable as a
    /// trait bound conversion in a `let` binding without this shim.
    trait IntoClientRequestTest {
        fn into_client_request_test(self) -> Request;
    }
    impl IntoClientRequestTest for String {
        fn into_client_request_test(self) -> Request {
            use tokio_tungstenite::tungstenite::client::IntoClientRequest;
            self.into_client_request().unwrap()
        }
    }
}
