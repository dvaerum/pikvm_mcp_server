//! iPadCollector WS server + protocol client — the paired ground-truth
//! source for E2E validation category 1 (task_37374b4bce6d,
//! docs/ipad-collector-ground-truth-bench-plan.md, reviewed by
//! pikvm-mcp-server@nixos-developer-system before implementation).
//!
//! **Not a TS port of any production `src/pikvm/*.ts` file** — this
//! reimplements the WIRE PROTOCOL of `src/pikvm/ipad-app-ws.ts` (a
//! bench-only TS module, never part of the production MCP tool surface),
//! because the real iPadCollector app binary running on the physical
//! iPad is the other end of this connection and won't be recompiled for
//! this port. Message shapes and the `get-cursor`/`cursor` request-
//! response pairing (via a generated request id) must match
//! `ipad-app-ws.ts` byte-for-byte; the Rust-side transport plumbing
//! (`tokio-tungstenite` server-side accept, already a workspace
//! dependency via `kvmd-client`'s client-side use of the same crate — no
//! new dependency) and the request/response correlation mechanism (a
//! simple incrementing counter here, not a UUID — this is a LOCAL,
//! single-process correlation, not something that needs to be globally
//! unique, so pulling in a `uuid` crate for it would be over-engineering)
//! don't need to match TS's own implementation choices.
//!
//! Scope, per the reviewed plan: only the `hello` handshake +
//! `get-cursor`/`cursor` RPC. `show-scene`, `subscribe-cursor`,
//! `tap-event`/`lifecycle` streaming are explicitly OUT of scope — none
//! of them are needed to pair a click landing against ground truth on
//! the real home screen, only the one-shot cursor read is.
//!
//! Real port: **8767** (matches `scripts/diag-move-to-on-synth.ts` and
//! this project's own established iPadCollector convention).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

/// The app's `hello` payload — logical (points, not HDMI pixels) screen
/// dimensions + a model string. Matches `AppHello` in `ipad-app-ws.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct IpadCollectorHello {
    #[serde(rename = "logicalW")]
    pub logical_w: f64,
    #[serde(rename = "logicalH")]
    pub logical_h: f64,
    pub model: String,
}

/// A `getCursor()` reading. `tracked` follows `CursorPos`'s own TS
/// contract: `Some(false)` = a real "not tracked yet" signal (post-
/// 2026-06-18 app builds); `None` = a legacy client that predates the
/// field, discriminated from a real reading by the `(0,0)` sentinel in
/// `get_tracked_cursor`.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CursorPos {
    pub x: f64,
    pub y: f64,
    /// App-side wall-clock, ms since epoch.
    pub t_ipad: u64,
    pub tracked: Option<bool>,
}

/// The "is this reading real" decision, exactly matching
/// `ipad-app-ws.ts`'s `getTrackedCursor()` rule so this port doesn't
/// re-derive it: `tracked:false` -> not tracked; `tracked:None` (legacy
/// client, predates the field) with the `(0,0)` sentinel -> not tracked;
/// otherwise a real reading. A free function (not a method) specifically
/// so it's unit-testable without a real socket/session.
fn is_tracked_reading(cur: &CursorPos) -> bool {
    if cur.tracked == Some(false) {
        return false;
    }
    if cur.tracked.is_none() && cur.x == 0.0 && cur.y == 0.0 {
        return false;
    }
    true
}

#[derive(Debug, Serialize)]
struct OutgoingFrame<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    id: u64,
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct IncomingFrame {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    payload: serde_json::Value,
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// One connected iPad app session — the accepted WS stream, a pending-
/// request map keyed by the generated request id (mirrors
/// `ipad-app-ws.ts`'s `Map<string, PendingRequest>`, keyed by a `u64`
/// counter here instead of a UUID string), and the parsed `hello`
/// payload.
pub struct IpadCollectorSession {
    pub hello: IpadCollectorHello,
    write: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpStream>, WsMessage>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: Arc<AtomicU64>,
    /// Background task reading frames off the socket and resolving
    /// `pending` entries — held so it's dropped (and stops) when the
    /// session is.
    _reader_task: tokio::task::JoinHandle<()>,
}

impl IpadCollectorSession {
    /// `getCursor()` — send `get-cursor`, wait (5s timeout) for the
    /// correlated `cursor` response. Faithful to `ipad-app-ws.ts`'s own
    /// RPC shape and timeout.
    pub async fn get_cursor(&self) -> anyhow::Result<CursorPos> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let frame = OutgoingFrame {
            kind: "get-cursor",
            id,
            payload: serde_json::json!({}),
        };
        let text = serde_json::to_string(&frame)?;
        self.write
            .lock()
            .await
            .send(WsMessage::Text(text.into()))
            .await?;

        let payload = tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| anyhow::anyhow!("get-cursor timed out after {REQUEST_TIMEOUT:?}"))?
            .map_err(|_| anyhow::anyhow!("get-cursor: session closed before a response arrived"))?;
        Ok(serde_json::from_value(payload)?)
    }

    /// `getTrackedCursor()` — `get_cursor()` + the "is this reading real"
    /// decision folded in (`is_tracked_reading`, a free function so it's
    /// unit-testable without a real socket).
    pub async fn get_tracked_cursor(&self) -> anyhow::Result<Option<CursorPos>> {
        let cur = self.get_cursor().await?;
        Ok(is_tracked_reading(&cur).then_some(cur))
    }
}

/// Bind `port`, accept the FIRST connection, wait for its `hello` (up to
/// `HELLO_TIMEOUT`), and return the ready session. Faithful to
/// `startIpadAppServer`'s own handoff semantics (poll for `hello`, drop
/// the connection if it never arrives) — reimplemented as a single
/// `async fn` returning one session rather than TS's persistent
/// multi-connection server, since this bench only ever needs one.
pub async fn wait_for_ipad_collector_session(
    port: u16,
    timeout: Duration,
) -> anyhow::Result<IpadCollectorSession> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    let (stream, _addr) = tokio::time::timeout(timeout, listener.accept())
        .await
        .map_err(|_| anyhow::anyhow!("no iPad app connection within {timeout:?}"))??;
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (write, mut read) = ws.split();
    let write = Arc::new(Mutex::new(write));
    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Wait for `hello` inline (not yet spawning the steady-state reader
    // task — no requests are pending yet, so there's nothing to
    // correlate before the session is handed back to the caller).
    let hello = tokio::time::timeout(HELLO_TIMEOUT, async {
        loop {
            let Some(msg) = read.next().await else {
                anyhow::bail!("iPad app closed the connection before sending hello");
            };
            let WsMessage::Text(text) = msg? else {
                continue;
            };
            let Ok(frame) = serde_json::from_str::<IncomingFrame>(&text) else {
                continue;
            };
            if frame.kind == "hello" {
                return Ok(serde_json::from_value::<IpadCollectorHello>(frame.payload)?);
            }
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("iPad app never sent hello within {HELLO_TIMEOUT:?}"))??;

    // hello-ack, matching ipad-app-ws.ts's own IpadSession constructor.
    {
        let ack = OutgoingFrame {
            kind: "hello-ack",
            id: 0,
            payload: serde_json::json!({"sessionId": "rust-bench"}),
        };
        write
            .lock()
            .await
            .send(WsMessage::Text(serde_json::to_string(&ack)?.into()))
            .await?;
    }

    let pending_for_reader = pending.clone();
    let reader_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = read.next().await {
            let WsMessage::Text(text) = msg else { continue };
            let Ok(frame) = serde_json::from_str::<IncomingFrame>(&text) else {
                continue;
            };
            // Only `cursor` (the `get-cursor` response) is in scope —
            // ack/time-pong/cursor-event/tap-event/lifecycle/error are
            // all explicitly out of scope per the reviewed plan.
            if frame.kind == "cursor" {
                if let Some(id) = frame.id {
                    if let Some(tx) = pending_for_reader.lock().await.remove(&id) {
                        let _ = tx.send(frame.payload);
                    }
                }
            }
        }
    });

    Ok(IpadCollectorSession {
        hello,
        write,
        pending,
        next_id: Arc::new(AtomicU64::new(1)),
        _reader_task: reader_task,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cur(x: f64, y: f64, tracked: Option<bool>) -> CursorPos {
        CursorPos {
            x,
            y,
            t_ipad: 0,
            tracked,
        }
    }

    #[test]
    fn tracked_true_is_a_real_reading() {
        assert!(is_tracked_reading(&cur(123.0, 456.0, Some(true))));
    }

    #[test]
    fn tracked_false_is_not_a_real_reading_even_at_a_nonzero_position() {
        // A post-2026-06-18 app explicitly saying "not tracked yet" —
        // must not be treated as real regardless of x/y.
        assert!(!is_tracked_reading(&cur(500.0, 500.0, Some(false))));
    }

    #[test]
    fn legacy_client_zero_zero_sentinel_is_not_a_real_reading() {
        assert!(!is_tracked_reading(&cur(0.0, 0.0, None)));
    }

    #[test]
    fn legacy_client_nonzero_position_is_a_real_reading() {
        // A pre-2026-06-18 client has no `tracked` field at all, but a
        // genuine non-(0,0) reading is still real — only the exact
        // sentinel is treated as "not yet tracked."
        assert!(is_tracked_reading(&cur(42.0, 0.0, None)));
        assert!(is_tracked_reading(&cur(0.0, 42.0, None)));
    }

    #[test]
    fn hello_deserializes_camel_case_fields() {
        let json = r#"{"logicalW": 820.0, "logicalH": 1180.0, "model": "iPad14,2"}"#;
        let hello: IpadCollectorHello = serde_json::from_str(json).unwrap();
        assert_eq!(hello.logical_w, 820.0);
        assert_eq!(hello.logical_h, 1180.0);
        assert_eq!(hello.model, "iPad14,2");
    }

    #[test]
    fn outgoing_get_cursor_frame_serializes_with_the_expected_shape() {
        let frame = OutgoingFrame {
            kind: "get-cursor",
            id: 7,
            payload: serde_json::json!({}),
        };
        let text = serde_json::to_string(&frame).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["type"], "get-cursor");
        assert_eq!(parsed["id"], 7);
        assert_eq!(parsed["payload"], serde_json::json!({}));
    }

    #[test]
    fn incoming_cursor_frame_deserializes_with_id_and_payload() {
        let json = r#"{"type":"cursor","id":3,"payload":{"x":100.0,"y":200.0,"t_ipad":1234,"tracked":true}}"#;
        let frame: IncomingFrame = serde_json::from_str(json).unwrap();
        assert_eq!(frame.kind, "cursor");
        assert_eq!(frame.id, Some(3));
        let pos: CursorPos = serde_json::from_value(frame.payload).unwrap();
        assert_eq!(pos.x, 100.0);
        assert_eq!(pos.y, 200.0);
        assert_eq!(pos.tracked, Some(true));
    }

    #[tokio::test]
    async fn wait_for_ipad_collector_session_times_out_with_no_connection() {
        // A real, if narrow, integration check: bind a real port, no app
        // ever connects, confirm the timeout fires rather than hanging.
        let result = wait_for_ipad_collector_session(0, Duration::from_millis(50)).await;
        assert!(result.is_err());
    }
}
