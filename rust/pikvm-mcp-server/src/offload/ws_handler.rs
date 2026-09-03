//! axum WS upgrade handler for the offload-helper connection
//! (docs/cursor-offload-inference-design.md, task_d06561d91f58).
//!
//! Auth (the bearer token) already happened at HTTP-upgrade time, via
//! `mod.rs`'s `require_offload_auth` middleware layered in front of this
//! route. `Hello`'s model-hash check is a SEPARATE, later check: identity,
//! not authentication (§2 of the design doc).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use pikvm_mcp_detection_vision::cursor_ml_detect::{CascadeResult, CASCADE_CROP};
use pikvm_mcp_offload_protocol::{decode, encode, Frame, MAX_WS_MESSAGE_BYTES};
use tokio::sync::{mpsc, oneshot};

use super::registry::{OffloadState, PendingRequest};

/// How long to wait for the helper's `Hello` after the WS upgrade before
/// giving up on this connection attempt entirely.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Bounded so a helper that stops reading its own inbound channel (e.g.
/// stuck mid-inference) applies backpressure rather than letting
/// `try_offload` callers queue unboundedly.
const REQUEST_CHANNEL_CAPACITY: usize = 8;

pub async fn offload_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<OffloadState>>,
) -> impl IntoResponse {
    // See MAX_WS_MESSAGE_BYTES's own doc comment (offload-protocol) --
    // tungstenite's own defaults (64 MiB message / 16 MiB frame) are too
    // small for a real full-frame InferRequest, causing a silent
    // fallback-to-local for exactly the highest-value calls. Both limits
    // set explicitly (axum's own `max_message_size` alone isn't enough --
    // `max_frame_size` is the one that actually bound the real failure).
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_connection(socket, state))
}

async fn handle_connection(mut socket: WebSocket, state: Arc<OffloadState>) {
    let Some((model_sha256, label)) = read_hello(&mut socket).await else {
        return;
    };

    if model_sha256 != state.model_sha256 {
        let _ = send_frame(
            &mut socket,
            &Frame::HelloAck {
                accepted: false,
                reason: "model hash mismatch".to_string(),
            },
        )
        .await;
        return;
    }

    if send_frame(
        &mut socket,
        &Frame::HelloAck {
            accepted: true,
            reason: String::new(),
        },
    )
    .await
    .is_err()
    {
        return;
    }
    eprintln!("[offload] helper connected: {label}");

    let (req_tx, req_rx) = mpsc::channel::<PendingRequest>(REQUEST_CHANNEL_CAPACITY);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (generation, old) = state.replace(req_tx, shutdown_tx).await;
    if let Some(old) = old {
        // Fired OUTSIDE state's own lock (replace() already released it) --
        // the old connection's task will drain its own in-flight requests
        // as None on its way out, same as any other exit path below.
        let _ = old.shutdown.send(());
    }

    run_session(&mut socket, req_rx, shutdown_rx).await;

    state.clear_if_current(generation).await;
    eprintln!("[offload] helper disconnected");
}

/// The main per-connection loop: dispatch queued `InferRequest`s to the
/// socket, match incoming `InferResponse`s back to their waiting caller by
/// `request_id`. Exits on: an explicit shutdown signal (superseded by a
/// newer connection), the request channel closing (every `OffloadState`
/// handle to this connection dropped), a socket-level close/error, or an
/// unparseable frame.
async fn run_session(
    socket: &mut WebSocket,
    mut req_rx: mpsc::Receiver<PendingRequest>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let mut next_request_id: u32 = 0;
    // Only the reply channel is kept once a request is sent -- frame_w/
    // frame_h/crops already went out on the wire, nothing left to hold
    // onto for those.
    let mut in_flight: HashMap<u32, oneshot::Sender<Option<Vec<CascadeResult>>>> = HashMap::new();

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            pending = req_rx.recv() => {
                let Some(pending) = pending else { break };
                let request_id = next_request_id;
                next_request_id = next_request_id.wrapping_add(1);
                let frame = Frame::InferRequest {
                    request_id,
                    frame_w: pending.frame_w,
                    frame_h: pending.frame_h,
                    crop_size: CASCADE_CROP as u32,
                    crops: (*pending.crops).clone(),
                };
                if send_frame(socket, &frame).await.is_err() {
                    let _ = pending.reply.send(None);
                    break;
                }
                in_flight.insert(request_id, pending.reply);
            }
            incoming = read_frame(socket) => {
                match incoming {
                    Some(Ok(Frame::InferResponse { request_id, results })) => {
                        if let Some(reply) = in_flight.remove(&request_id) {
                            let _ = reply.send(Some(results));
                        }
                        // else: an unknown/late request_id -- the local
                        // caller already timed out and moved on; nothing
                        // to deliver it to, not a protocol error.
                    }
                    Some(Ok(Frame::Error { request_id, message })) => {
                        eprintln!("[offload] helper reported an error for request {request_id}: {message}");
                        if let Some(reply) = in_flight.remove(&request_id) {
                            let _ = reply.send(None);
                        }
                    }
                    Some(Ok(_unexpected)) => {
                        // Hello/HelloAck/InferRequest mid-session from the
                        // helper's side -- not part of this protocol's
                        // valid flow post-handshake; ignore rather than
                        // tear down a connection over a harmless surprise.
                    }
                    Some(Err(e)) => {
                        eprintln!("[offload] connection error: {e}");
                        break;
                    }
                    None => break, // socket closed
                }
            }
        }
    }

    // Every request still waiting for an answer (queued but never sent,
    // or sent but never answered) resolves to None -- the caller's
    // `try_offload` falls back to local inference, same as a timeout.
    // Never leave a `oneshot::Receiver` hanging on a connection that's
    // going away.
    for (_, reply) in in_flight {
        let _ = reply.send(None);
    }
    while let Ok(pending) = req_rx.try_recv() {
        let _ = pending.reply.send(None);
    }
}

/// Read frames until a `Hello` arrives (or the timeout elapses / the
/// connection drops / a malformed frame shows up) — any of those is a
/// failed handshake, reported best-effort and the connection dropped.
async fn read_hello(socket: &mut WebSocket) -> Option<([u8; 32], String)> {
    match tokio::time::timeout(HELLO_TIMEOUT, read_frame(socket)).await {
        Ok(Some(Ok(Frame::Hello {
            model_sha256,
            label,
        }))) => Some((model_sha256, label)),
        Ok(Some(Ok(_other))) => {
            let _ = send_frame(
                socket,
                &Frame::Error {
                    request_id: 0,
                    message: "expected Hello as the first frame".to_string(),
                },
            )
            .await;
            None
        }
        Ok(Some(Err(e))) => {
            eprintln!("[offload] malformed Hello frame: {e}");
            None
        }
        Ok(None) => None, // socket closed before sending Hello
        Err(_) => {
            let _ = send_frame(
                socket,
                &Frame::Error {
                    request_id: 0,
                    message: "timed out waiting for Hello".to_string(),
                },
            )
            .await;
            None
        }
    }
}

/// Read one `Frame` off the socket, transparently skipping non-Binary WS
/// messages (axum answers Ping with Pong automatically; Text/Pong/other
/// frames aren't part of this protocol and are just ignored rather than
/// treated as errors). `None` means the socket closed with nothing more
/// to read; `Some(Err(_))` means a real decode/transport failure.
async fn read_frame(socket: &mut WebSocket) -> Option<anyhow::Result<Frame>> {
    loop {
        let msg = match socket.recv().await {
            None => return None,
            Some(Err(e)) => return Some(Err(e.into())),
            Some(Ok(m)) => m,
        };
        match msg {
            Message::Binary(bytes) => return Some(decode(&bytes)),
            Message::Close(_) => return None,
            _ => continue,
        }
    }
}

async fn send_frame(socket: &mut WebSocket, frame: &Frame) -> anyhow::Result<()> {
    let bytes = encode(frame)?;
    socket.send(Message::Binary(bytes.into())).await?;
    Ok(())
}
