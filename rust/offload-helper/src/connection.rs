//! One connection attempt's full lifecycle: connect out to the server,
//! the `Hello`/`HelloAck` handshake, then serve `InferRequest`s using the
//! real local `ort::session::Session` until the connection ends for any
//! reason. `main.rs`'s reconnect loop calls this repeatedly.

use futures_util::{SinkExt, StreamExt};
use ort::session::Session;
use pikvm_mcp_detection_vision::cursor_ml_detect::run_cascade_inference_all_from_raw_crops;
use pikvm_mcp_offload_protocol::{decode, encode, Frame};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;

type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Whether this attempt ever reached an accepted handshake — the caller
/// uses this to decide whether to reset its reconnect backoff (mirrors
/// `StreamerKeepalive`'s own "connected" event resetting
/// `reconnect_delay_ms`, regardless of how the session later ends).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionOutcome {
    WasConnected,
    NeverConnected,
}

pub async fn run_one_session(
    server_url: &str,
    token: &str,
    label: &str,
    model_sha256: [u8; 32],
    session: &mut Session,
) -> SessionOutcome {
    let mut request = match server_url.into_client_request() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[offload-helper] invalid server URL {server_url:?}: {e}");
            return SessionOutcome::NeverConnected;
        }
    };
    let auth_value = match format!("Bearer {token}").parse() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[offload-helper] token isn't a valid header value: {e}");
            return SessionOutcome::NeverConnected;
        }
    };
    request.headers_mut().insert("Authorization", auth_value);

    let mut ws = match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _response)) => ws,
        Err(e) => {
            eprintln!("[offload-helper] connect to {server_url} failed: {e}");
            return SessionOutcome::NeverConnected;
        }
    };
    eprintln!("[offload-helper] connected to {server_url}");

    let hello = Frame::Hello {
        model_sha256,
        label: label.to_string(),
    };
    if send_frame(&mut ws, &hello).await.is_err() {
        eprintln!("[offload-helper] failed to send Hello");
        return SessionOutcome::NeverConnected;
    }

    match read_frame(&mut ws).await {
        Some(Ok(Frame::HelloAck { accepted: true, .. })) => {
            eprintln!("[offload-helper] handshake accepted — serving inference requests");
        }
        Some(Ok(Frame::HelloAck {
            accepted: false,
            reason,
        })) => {
            eprintln!("[offload-helper] handshake REJECTED by server: {reason}");
            return SessionOutcome::NeverConnected;
        }
        Some(Ok(other)) => {
            eprintln!("[offload-helper] expected HelloAck, got {other:?}");
            return SessionOutcome::NeverConnected;
        }
        Some(Err(e)) => {
            eprintln!("[offload-helper] malformed handshake response: {e}");
            return SessionOutcome::NeverConnected;
        }
        None => {
            eprintln!("[offload-helper] server closed the connection during handshake");
            return SessionOutcome::NeverConnected;
        }
    }

    serve_requests(&mut ws, session).await;
    SessionOutcome::WasConnected
}

/// The post-handshake loop: real inference per `InferRequest`, using the
/// SAME `run_cascade_inference_all_from_raw_crops` the server's own local
/// path calls (docs/cursor-offload-inference-design.md §4) — the
/// structural half of the correctness-parity guarantee, by construction.
async fn serve_requests(ws: &mut WsStream, session: &mut Session) {
    loop {
        match read_frame(ws).await {
            Some(Ok(Frame::InferRequest {
                request_id,
                frame_w,
                frame_h,
                crop_size: _,
                crops,
            })) => {
                let reply = match run_cascade_inference_all_from_raw_crops(
                    session, frame_w, frame_h, &crops,
                ) {
                    Ok(results) => Frame::InferResponse {
                        request_id,
                        results,
                    },
                    Err(e) => Frame::Error {
                        request_id,
                        message: e.to_string(),
                    },
                };
                if send_frame(ws, &reply).await.is_err() {
                    eprintln!("[offload-helper] failed to send a reply — connection likely gone");
                    break;
                }
            }
            Some(Ok(_unexpected)) => {
                // Hello/HelloAck/InferResponse from the server post-
                // handshake isn't part of this protocol's valid flow —
                // ignore rather than tear down the session over it.
            }
            Some(Err(e)) => {
                eprintln!("[offload-helper] connection error: {e}");
                break;
            }
            None => {
                eprintln!("[offload-helper] server closed the connection");
                break;
            }
        }
    }
}

async fn read_frame(ws: &mut WsStream) -> Option<anyhow::Result<Frame>> {
    loop {
        let msg = match ws.next().await? {
            Ok(m) => m,
            Err(e) => return Some(Err(e.into())),
        };
        match msg {
            Message::Binary(bytes) => return Some(decode(&bytes)),
            Message::Close(_) => return None,
            _ => continue,
        }
    }
}

async fn send_frame(ws: &mut WsStream, frame: &Frame) -> anyhow::Result<()> {
    let bytes = encode(frame)?;
    ws.send(Message::Binary(bytes.into())).await?;
    Ok(())
}
