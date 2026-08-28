//! Low-level HTTP request seam: the injectable `RequestFn` DI point (same
//! test-seam pattern as `streamer_keepalive`'s `ConnectFn`) plus its real
//! networking implementation.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::error::{ClientError, PiKVMApiError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone)]
pub enum RequestBody {
    Json(serde_json::Value),
    Text(String),
}

#[derive(Debug, Clone)]
pub struct RequestArgs {
    pub method: HttpMethod,
    /// Path + query string, e.g. `/hid/events/send_mouse_move?to_x=0&to_y=0`.
    /// Resolved against `/api` on the configured host, matching TS's
    /// `new URL('/api'+path, this.config.host)`.
    pub path: String,
    pub body: Option<RequestBody>,
}

/// What a successful request resolves to — mirrors TS `request<T>()`'s
/// runtime content-type dispatch (image bytes / parsed JSON / empty body)
/// collapsed to a fixed enum since Rust has no `T = unknown`. The TS
/// "not valid JSON, wrap as `{ result: text } `" fallback is modelled by
/// constructing that same shape as a `Json` value here, so it's
/// indistinguishable to callers either way.
#[derive(Debug, Clone)]
pub enum ResponseBody {
    Image(Vec<u8>),
    Json(serde_json::Value),
    Empty,
}

pub type RequestFn = Arc<
    dyn Fn(RequestArgs) -> Pin<Box<dyn Future<Output = Result<ResponseBody, ClientError>> + Send>>
        + Send
        + Sync,
>;

fn sanitize_error_text(text: &str) -> String {
    // Faithful port of the TS regex sanitization
    // (`/password[=:][^\s,"]*/gi`, `/X-KVMD-Passwd[^,\s"]*/gi`,
    // `.substring(0, 200)`). `regex` (not hand-rolled) because this is
    // genuine case-insensitive pattern-replace, not a simple
    // word-boundary scan (contrast operator_hints's hand-rolled
    // `contains_word_503`) — and it redacts credentials before they
    // might reach logs, which is exactly the wrong place to risk a
    // hand-rolled bug.
    use std::sync::OnceLock;
    static PASSWORD_RE: OnceLock<regex::Regex> = OnceLock::new();
    static KVMD_PASSWD_RE: OnceLock<regex::Regex> = OnceLock::new();
    let password_re = PASSWORD_RE.get_or_init(|| {
        regex::RegexBuilder::new(r#"password[=:][^\s,"]*"#)
            .case_insensitive(true)
            .build()
            .expect("static regex is valid")
    });
    let kvmd_passwd_re = KVMD_PASSWD_RE.get_or_init(|| {
        regex::RegexBuilder::new(r#"X-KVMD-Passwd[^,\s"]*"#)
            .case_insensitive(true)
            .build()
            .expect("static regex is valid")
    });
    let redacted = password_re.replace_all(text, "password=[REDACTED]");
    let redacted = kvmd_passwd_re.replace_all(&redacted, "X-KVMD-Passwd=[REDACTED]");
    redacted.chars().take(200).collect()
}

/// The real networking implementation of the request seam — builds
/// `{host}/api{path}`, sets the `X-KVMD-User`/`X-KVMD-Passwd` auth
/// headers, dispatches on the response content-type, and sanitizes error
/// bodies before wrapping them in `PiKVMApiError`. Faithful port of
/// `PiKVMClient.request`.
pub(super) fn real_request_fn(
    http: reqwest::Client,
    host: String,
    username: String,
    password: String,
) -> RequestFn {
    Arc::new(move |args: RequestArgs| {
        let http = http.clone();
        let host = host.clone();
        let username = username.clone();
        let password = password.clone();
        Box::pin(async move {
            let url = format!("{}/api{}", host.trim_end_matches('/'), args.path);
            let mut builder = match args.method {
                HttpMethod::Get => http.get(&url),
                HttpMethod::Post => http.post(&url),
            };
            builder = builder
                .header("X-KVMD-User", &username)
                .header("X-KVMD-Passwd", &password);
            if let Some(body) = &args.body {
                builder = match body {
                    RequestBody::Json(v) => {
                        builder.header("Content-Type", "application/json").json(v)
                    }
                    RequestBody::Text(t) => {
                        builder.header("Content-Type", "text/plain").body(t.clone())
                    }
                };
            }
            let response = builder
                .send()
                .await
                .map_err(|e| ClientError::Other(format!("request to {url} failed: {e}")))?;

            let status = response.status();
            if !status.is_success() {
                let status_code = status.as_u16();
                let error_text = response.text().await.unwrap_or_default();
                let sanitized = sanitize_error_text(&error_text);
                return Err(ClientError::Api(PiKVMApiError {
                    status: status_code,
                    message: format!("PiKVM API error {status_code}: {sanitized}"),
                }));
            }

            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let content_length_zero = response
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == "0")
                .unwrap_or(false);
            let status_no_content = status.as_u16() == 204;

            if content_type.contains("image/") {
                let bytes = response.bytes().await.map_err(|e| {
                    ClientError::Other(format!("failed to read response body: {e}"))
                })?;
                return Ok(ResponseBody::Image(bytes.to_vec()));
            }

            if status_no_content || content_length_zero {
                return Ok(ResponseBody::Empty);
            }

            let text = response
                .text()
                .await
                .map_err(|e| ClientError::Other(format!("failed to read response body: {e}")))?;
            if text.is_empty() {
                return Ok(ResponseBody::Empty);
            }
            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(v) => Ok(ResponseBody::Json(v)),
                Err(_) => Ok(ResponseBody::Json(serde_json::json!({ "result": text }))),
            }
        })
    })
}

pub(super) fn build_http_client(verify_ssl: bool, proxy_url: Option<&str>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder().danger_accept_invalid_certs(!verify_ssl);
    if let Some(proxy_url) = proxy_url {
        if !proxy_url.is_empty() {
            builder =
                builder.proxy(reqwest::Proxy::all(proxy_url).expect("proxy URL should be valid"));
        }
    }
    builder
        .build()
        .expect("reqwest client config should be valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::core::PiKVMClient;
    use crate::client::types::PiKVMConfig;

    // Proves `PiKVMClient` routes its outbound requests through the
    // configured proxy when `proxy_url` is set, and goes direct
    // otherwise. Faithful port of `client-proxy.test.ts`'s intent
    // (loopback origin + loopback proxy, no PiKVM, no TLS needed) —
    // this is the unit-level guard for the loopback-proxy workaround
    // (see `PiKVMConfig::proxy_url`'s doc).
    //
    // Adapted, not copied verbatim: the TS test's fake proxy only
    // implements CONNECT tunnelling because undici's `ProxyAgent`
    // CONNECT-tunnels even plain-HTTP origins (documented in that
    // file's header) — reqwest instead forward-proxies plain `http://`
    // targets (absolute-URI request line straight to the proxy, no
    // CONNECT). This fixture's fake proxy handles BOTH wire forms so
    // the test asserts the actual contract that matters ("does the
    // client's traffic reach the proxy") rather than one library's
    // specific wire-level choice.
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Mutex as TokioMutex;

    async fn read_request_head(sock: &mut TcpStream) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        buf
    }

    /// Stands in for the PiKVM: answers `/api/auth/check` with 200,
    /// everything else 404. Tolerates both origin-form
    /// (`/api/auth/check`) and absolute-URI (`http://host/api/auth/check`)
    /// request lines, since it may be reached directly OR through
    /// the fake forward-proxy below.
    async fn spawn_origin() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let buf = read_request_head(&mut sock).await;
                    let text = String::from_utf8_lossy(&buf);
                    let path = text
                        .lines()
                        .next()
                        .unwrap_or("")
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("");
                    if path.ends_with("/api/auth/check") {
                        let body = b"{}";
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = sock.write_all(resp.as_bytes()).await;
                        let _ = sock.write_all(body).await;
                    } else {
                        let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    }
                });
            }
        });
        addr
    }

    /// Minimal proxy: records the target of every connection it
    /// handles, then blindly tunnels bytes to it — either via a real
    /// CONNECT response (CONNECT method) or by forwarding the
    /// already-buffered absolute-URI request verbatim (any other
    /// method), matching a real forward proxy either way.
    async fn spawn_fake_proxy() -> (SocketAddr, Arc<TokioMutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let targets: Arc<TokioMutex<Vec<String>>> = Arc::new(TokioMutex::new(Vec::new()));
        let targets_bg = targets.clone();
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(handle_proxy_conn(sock, targets_bg.clone()));
            }
        });
        (addr, targets)
    }

    async fn handle_proxy_conn(mut sock: TcpStream, targets: Arc<TokioMutex<Vec<String>>>) {
        let buf = read_request_head(&mut sock).await;
        let text = String::from_utf8_lossy(&buf);
        let first_line = text.lines().next().unwrap_or("").to_string();
        let mut parts = first_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target_field = parts.next().unwrap_or("");

        let target = if method == "CONNECT" {
            let (h, p) = target_field.split_once(':').unwrap_or((target_field, "80"));
            Some((h.to_string(), p.parse::<u16>().unwrap_or(80)))
        } else {
            url::Url::parse(target_field).ok().and_then(|u| {
                u.host_str()
                    .map(|h| (h.to_string(), u.port_or_known_default().unwrap_or(80)))
            })
        };
        let Some((host, port)) = target else { return };
        targets.lock().await.push(format!("{host}:{port}"));

        let Ok(mut upstream) = TcpStream::connect((host.as_str(), port)).await else {
            return;
        };
        if method == "CONNECT" {
            let _ = sock
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await;
        } else {
            let _ = upstream.write_all(&buf).await;
        }
        let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
    }

    #[tokio::test]
    async fn routes_requests_through_the_proxy_when_proxy_url_is_set() {
        let origin_addr = spawn_origin().await;
        let (proxy_addr, targets) = spawn_fake_proxy().await;
        let config = PiKVMConfig {
            proxy_url: Some(format!("http://{proxy_addr}")),
            ..PiKVMConfig::new(format!("http://{origin_addr}"), "admin", "pw")
        };
        let client = PiKVMClient::new(config, None);
        assert!(client.check_auth().await);
        let seen = targets.lock().await;
        assert!(seen.iter().any(|t| t == &origin_addr.to_string()));
    }

    #[tokio::test]
    async fn connects_directly_no_proxy_when_proxy_url_is_unset() {
        let origin_addr = spawn_origin().await;
        let config = PiKVMConfig::new(format!("http://{origin_addr}"), "admin", "pw");
        let client = PiKVMClient::new(config, None);
        assert!(client.check_auth().await);
    }
}
