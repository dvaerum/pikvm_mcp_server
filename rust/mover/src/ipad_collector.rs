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
//! Scope, per the reviewed plan (widened 2026-08-29, see
//! docs/ipad-collector-showscene-redesign-plan.md): `hello` handshake,
//! `get-cursor`/`cursor`, and `show-scene`/`ack` RPCs, plus `error`
//! (rejection) handling for any request. `show-scene` was added because
//! `ipad_go_home()`'s `Cmd+H` backgrounds the app and kills its WS
//! session (found live) — sending a static home-screen image AS a scene
//! keeps the app foreground for the whole bench run instead. This trades
//! "click the literal live home screen" for "click a static rendering of
//! it," which only affects detection/landing-accuracy claims, not app-
//! interaction ones (already covered elsewhere, see the redesign plan).
//! `subscribe-cursor`/`tap-event`/`lifecycle` streaming remain explicitly
//! OUT of scope — not needed for a one-shot cursor read paired against
//! one click.
//!
//! Real port: **8767** (matches `scripts/diag-move-to-on-synth.ts` and
//! this project's own established iPadCollector convention).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
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
    /// App-side wall-clock, ms since epoch. `f64`, not an integer type —
    /// found live 2026-08-29: the real app sends a fractional value
    /// (`Date().timeIntervalSince1970 * 1000`-style, sub-millisecond
    /// precision), and TS's own `t_ipad: number` was always a double too;
    /// an earlier `u64` here was an unchecked assumption that rejected
    /// every real reading with a deserialize error.
    pub t_ipad: f64,
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

// `id` is a STRING on the wire, not a bare JSON number — found live
// 2026-08-29: `ipad-app-ws.ts`'s reference protocol always uses
// `randomUUID()` (a string) for request ids, and the real app's decode
// almost certainly types its message-id field as `String`. Sending a
// bare number here didn't error visibly, but the app never replied
// (every `get-cursor` call timed out) — consistent with the app silently
// dropping a message it couldn't decode. The u64 COUNTER underneath is
// still fine to keep (this module's own header comment already
// justifies not using real UUIDs for LOCAL correlation) — only the ON-
// WIRE TYPE needs to match, so the counter is just stringified.
#[derive(Debug, Serialize)]
struct OutgoingFrame<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    id: String,
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct IncomingFrame {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    payload: serde_json::Value,
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// A random UUID-v4-SHAPED string (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`,
/// `y` in `{8,9,a,b}` per the RFC 4122 variant bits). Hand-rolled rather
/// than pulling in the `uuid` crate: nothing here needs real global
/// uniqueness guarantees, only a shape the app's `UUID(uuidString:)`
/// decode will accept — see the call site's comment for why that matters.
fn random_uuid_v4_string() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

/// Decide which pending request (if any) an incoming frame resolves or
/// rejects, and how — a free function (not inlined in the reader task)
/// specifically so the `ack`/`cursor`/`error` correlation rules are
/// unit-testable without a real socket, matching `is_tracked_reading`'s
/// pattern above. Confirmed against `ipad-app-ws.ts`'s own `onMessage`
/// switch (nixos-dev review, 2026-08-29): `cursor` correlates via the
/// top-level `id`; `ack` (show-scene's response) correlates via
/// `payload.ref` instead — a genuinely different field, not a bug if
/// they don't match. `error` can reject either kind of request, so it
/// checks `payload.ref` first and falls back to the top-level `id`.
/// `time-pong`/`cursor-event`/`tap-event`/`lifecycle` are out of scope
/// (this module never sends `time-ping`/`subscribe-cursor`, so the app
/// has no reason to send them back) and fall through to `None`.
fn correlate_incoming_frame(frame: IncomingFrame) -> Option<(String, PendingResponse)> {
    match frame.kind.as_str() {
        "cursor" => frame.id.map(|id| (id, Ok(frame.payload))),
        "ack" => frame
            .payload
            .get("ref")
            .and_then(|v| v.as_str())
            .map(|r| (r.to_string(), Ok(frame.payload.clone()))),
        "error" => {
            let ref_id = frame
                .payload
                .get("ref")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or(frame.id)?;
            let reason = frame
                .payload
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown app error")
                .to_string();
            Some((ref_id, Err(reason)))
        }
        _ => None,
    }
}

/// One connected iPad app session — the accepted WS stream, a pending-
/// request map keyed by the generated request id (mirrors
/// `ipad-app-ws.ts`'s `Map<string, PendingRequest>`, keyed by a `u64`
/// counter here instead of a UUID string), and the parsed `hello`
/// payload.
/// A resolved (`cursor`/`ack` payload) or rejected (`error` reason)
/// response, keyed by the request id/`ref` it correlates to.
type PendingResponse = Result<serde_json::Value, String>;
/// The shared table of in-flight requests awaiting a correlated response.
type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<PendingResponse>>>>;

pub struct IpadCollectorSession {
    pub hello: IpadCollectorHello,
    write: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpStream>, WsMessage>>>,
    pending: PendingMap,
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
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

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
            .map_err(|_| anyhow::anyhow!("get-cursor: session closed before a response arrived"))?
            .map_err(|reason| anyhow::anyhow!("get-cursor: app rejected: {reason}"))?;
        Ok(serde_json::from_value(payload)?)
    }

    /// `getTrackedCursor()` — `get_cursor()` + the "is this reading real"
    /// decision folded in (`is_tracked_reading`, a free function so it's
    /// unit-testable without a real socket).
    pub async fn get_tracked_cursor(&self) -> anyhow::Result<Option<CursorPos>> {
        let cur = self.get_cursor().await?;
        Ok(is_tracked_reading(&cur).then_some(cur))
    }

    /// `showScene()` — send `show-scene` with a base64-encoded image,
    /// wait for the app's `ack` (correlated via `payload.ref`, NOT the
    /// top-level `id` — see this module's header comment on why `ack`'s
    /// correlation differs from `cursor`'s). One-time setup call (not a
    /// hot path): sending the real home screen as a static scene keeps
    /// iPadCollector in the FOREGROUND for the whole bench run, unlike
    /// `ipad_go_home()`'s `Cmd+H`, which backgrounds it and kills the WS
    /// session (found live 2026-08-29, see
    /// docs/ipad-collector-showscene-redesign-plan.md).
    pub async fn show_scene_image(&self, jpeg_or_png_bytes: &[u8]) -> anyhow::Result<()> {
        use base64::Engine;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let image_b64 = base64::engine::general_purpose::STANDARD.encode(jpeg_or_png_bytes);
        let frame = OutgoingFrame {
            kind: "show-scene",
            id,
            payload: serde_json::json!({"kind": "image", "image": image_b64}),
        };
        let text = serde_json::to_string(&frame)?;
        self.write
            .lock()
            .await
            .send(WsMessage::Text(text.into()))
            .await?;

        tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| anyhow::anyhow!("show-scene timed out after {REQUEST_TIMEOUT:?}"))?
            .map_err(|_| anyhow::anyhow!("show-scene: session closed before an ack arrived"))?
            .map_err(|reason| anyhow::anyhow!("show-scene: app rejected: {reason}"))?;
        Ok(())
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
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

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
    //
    // Two real bugs found live 2026-08-29, in order of discovery (kept
    // both fixes; see docs/rust-port-plan.md's journal for the fuller
    // live-debugging trace):
    // 1. `sessionId` MUST be a real UUID-v4-shaped string — a plain
    //    "rust-bench" label made every subsequent get-cursor write fail
    //    with a broken pipe almost immediately after hello-ack, most
    //    likely because the app's Swift-side decode expects `UUID`.
    //    Formatted by hand below (not the `uuid` crate — this module's
    //    own header comment already explains why no `uuid` dependency)
    //    since only the on-wire SHAPE matters, not real uniqueness.
    // 2. The real underlying bug: every frame's top-level `id` (this
    //    hello-ack's `id: 0` included, and get-cursor's request id) was
    //    a bare JSON NUMBER. `ipad-app-ws.ts`'s reference protocol always
    //    uses `randomUUID()` — a STRING — for ids; a live probe (connect
    //    -> get-cursor immediately, no intervening app-backgrounding)
    //    showed a clean 5s timeout with no reply at all once (1) was
    //    fixed, consistent with the app silently dropping any frame it
    //    can't decode because `id` doesn't match its expected `String`
    //    type. Fixed by making `id` a `String` on the wire everywhere
    //    (see `OutgoingFrame`/`IncomingFrame` above) while keeping the
    //    cheap internal `u64` counter — only the wire TYPE needed to
    //    match, not real global uniqueness.
    {
        let ack = OutgoingFrame {
            kind: "hello-ack",
            id: "0".to_string(),
            payload: serde_json::json!({"sessionId": random_uuid_v4_string()}),
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
            // `cursor` (get-cursor's response) and `error` (a rejected
            // request, any kind) correlate via the top-level `id`; `ack`
            // (show-scene's response) correlates via `payload.ref`
            // instead — a genuinely different field, confirmed against
            // `ipad-app-ws.ts`'s own `onMessage` switch (nixos-dev
            // review, 2026-08-29). time-pong/cursor-event/tap-event/
            // lifecycle remain explicitly out of scope per the reviewed
            // plan — this module only speaks hello/get-cursor/show-scene.
            if let Some((key, outcome)) = correlate_incoming_frame(frame) {
                if let Some(tx) = pending_for_reader.lock().await.remove(&key) {
                    let _ = tx.send(outcome);
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

    fn incoming(kind: &str, id: Option<&str>, payload: serde_json::Value) -> IncomingFrame {
        IncomingFrame {
            kind: kind.to_string(),
            id: id.map(str::to_string),
            payload,
        }
    }

    #[test]
    fn cursor_correlates_via_top_level_id() {
        let frame = incoming("cursor", Some("7"), serde_json::json!({"x": 1.0}));
        let (key, outcome) = correlate_incoming_frame(frame).expect("should correlate");
        assert_eq!(key, "7");
        assert_eq!(outcome.unwrap(), serde_json::json!({"x": 1.0}));
    }

    #[test]
    fn cursor_with_no_id_does_not_correlate() {
        // Real-world: shouldn't happen (the app always echoes an id for
        // cursor responses), but the reader task must not panic if it
        // somehow does.
        let frame = incoming("cursor", None, serde_json::json!({}));
        assert!(correlate_incoming_frame(frame).is_none());
    }

    #[test]
    fn ack_correlates_via_payload_ref_not_top_level_id() {
        // The real regression this test guards: ack's correlation key is
        // payload.ref, NOT the top-level id (which the app may even
        // leave absent on an ack) — confirmed against ipad-app-ws.ts's
        // own onMessage switch during review.
        let frame = incoming("ack", None, serde_json::json!({"ref": "3"}));
        let (key, outcome) = correlate_incoming_frame(frame).expect("should correlate");
        assert_eq!(key, "3");
        assert!(outcome.is_ok());
    }

    #[test]
    fn ack_with_no_ref_does_not_correlate() {
        let frame = incoming("ack", Some("3"), serde_json::json!({}));
        // Deliberately NOT keyed by the top-level id "3" — ack must use
        // payload.ref, and there isn't one here, so no correlation.
        assert!(correlate_incoming_frame(frame).is_none());
    }

    #[test]
    fn error_correlates_via_payload_ref_and_rejects_with_the_reason() {
        let frame = incoming(
            "error",
            None,
            serde_json::json!({"ref": "5", "reason": "bad base64"}),
        );
        let (key, outcome) = correlate_incoming_frame(frame).expect("should correlate");
        assert_eq!(key, "5");
        assert_eq!(outcome.unwrap_err(), "bad base64");
    }

    #[test]
    fn error_falls_back_to_top_level_id_when_payload_has_no_ref() {
        let frame = incoming("error", Some("9"), serde_json::json!({}));
        let (key, outcome) = correlate_incoming_frame(frame).expect("should correlate");
        assert_eq!(key, "9");
        assert_eq!(outcome.unwrap_err(), "unknown app error");
    }

    #[test]
    fn unrecognized_frame_kind_does_not_correlate() {
        let frame = incoming(
            "lifecycle",
            Some("1"),
            serde_json::json!({"state": "active"}),
        );
        assert!(correlate_incoming_frame(frame).is_none());
    }

    #[test]
    fn show_scene_frame_serializes_with_the_expected_shape() {
        let frame = OutgoingFrame {
            kind: "show-scene",
            id: "2".to_string(),
            payload: serde_json::json!({"kind": "image", "image": "aGVsbG8="}),
        };
        let text = serde_json::to_string(&frame).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["type"], "show-scene");
        assert_eq!(parsed["id"], "2");
        assert_eq!(parsed["payload"]["kind"], "image");
        assert_eq!(parsed["payload"]["image"], "aGVsbG8=");
    }

    #[test]
    fn random_uuid_v4_string_has_the_right_shape() {
        for _ in 0..50 {
            let id = random_uuid_v4_string();
            assert_eq!(id.len(), 36, "wrong length: {id}");
            let parts: Vec<&str> = id.split('-').collect();
            assert_eq!(
                parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
                vec![8, 4, 4, 4, 12],
                "wrong group lengths: {id}"
            );
            assert!(parts[2].starts_with('4'), "not version 4: {id}");
            let variant_nibble = parts[3].chars().next().unwrap();
            assert!(
                matches!(variant_nibble, '8' | '9' | 'a' | 'b'),
                "wrong RFC 4122 variant nibble: {id}"
            );
            assert!(
                id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
                "non-hex character: {id}"
            );
        }
    }

    fn cur(x: f64, y: f64, tracked: Option<bool>) -> CursorPos {
        CursorPos {
            x,
            y,
            t_ipad: 0.0,
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
            id: "7".to_string(),
            payload: serde_json::json!({}),
        };
        let text = serde_json::to_string(&frame).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["type"], "get-cursor");
        // `id` must be a JSON STRING on the wire, not a bare number —
        // found live 2026-08-29 (see the hello-ack call site's comment):
        // the real app silently drops any frame whose `id` doesn't
        // decode as `String`, so this shape check is real regression
        // coverage, not incidental.
        assert_eq!(parsed["id"], "7");
        assert_eq!(parsed["payload"], serde_json::json!({}));
    }

    #[test]
    fn incoming_cursor_frame_deserializes_with_id_and_payload() {
        let json = r#"{"type":"cursor","id":"3","payload":{"x":100.0,"y":200.0,"t_ipad":1234,"tracked":true}}"#;
        let frame: IncomingFrame = serde_json::from_str(json).unwrap();
        assert_eq!(frame.kind, "cursor");
        assert_eq!(frame.id, Some("3".to_string()));
        let pos: CursorPos = serde_json::from_value(frame.payload).unwrap();
        assert_eq!(pos.x, 100.0);
        assert_eq!(pos.y, 200.0);
        assert_eq!(pos.tracked, Some(true));
    }

    #[test]
    fn t_ipad_accepts_a_fractional_millisecond_timestamp() {
        // Found live 2026-08-29: the real app sends fractional ms
        // (`Date().timeIntervalSince1970 * 1000`-style), not a whole
        // number — an earlier `u64` field type rejected every real
        // reading with a deserialize error. Regression coverage for
        // that specific shape, not just a round whole-number fixture.
        let json = r#"{"x":1.0,"y":2.0,"t_ipad":1788010742940.043,"tracked":true}"#;
        let pos: CursorPos = serde_json::from_str(json).unwrap();
        assert!((pos.t_ipad - 1788010742940.043).abs() < 0.001);
    }

    #[tokio::test]
    async fn wait_for_ipad_collector_session_times_out_with_no_connection() {
        // A real, if narrow, integration check: bind a real port, no app
        // ever connects, confirm the timeout fires rather than hanging.
        let result = wait_for_ipad_collector_session(0, Duration::from_millis(50)).await;
        assert!(result.is_err());
    }
}
