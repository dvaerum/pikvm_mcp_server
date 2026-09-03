//! The offload feature's connection registry
//! (docs/cursor-offload-inference-design.md, task_d06561d91f58): tracks the
//! single active offload-helper WS connection and bridges detection-
//! vision's own generic `OffloadInferenceFn` interface to it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_detection_vision::cursor_ml_detect::{CascadeResult, RawCrop};
use tokio::sync::{mpsc, oneshot, Mutex};

/// One inference request handed to a connection's own task via its mpsc
/// channel. `reply` is fulfilled (or dropped, which resolves the same as
/// a timeout) by that task once it has -- or gives up on -- an answer.
pub struct PendingRequest {
    pub frame_w: u32,
    pub frame_h: u32,
    pub crops: Arc<Vec<RawCrop>>,
    pub reply: oneshot::Sender<Option<Vec<CascadeResult>>>,
}

/// A live offload-helper connection: just enough to hand it a request and
/// to ask it to shut down. `generation` disambiguates a superseded
/// connection's own (possibly slow) shutdown from a newer connection that
/// has since taken over the registry slot.
pub(crate) struct ActiveConnection {
    pub generation: u64,
    pub sender: mpsc::Sender<PendingRequest>,
    pub shutdown: oneshot::Sender<()>,
}

/// Process-wide offload state: the dedicated bearer token, the expected
/// model hash, the per-request timeout, and the single active connection
/// slot (design decision #6: a new connection always replaces the old
/// one; #7: a per-request timeout applies even while connected).
pub struct OffloadState {
    pub token: String,
    pub model_sha256: [u8; 32],
    pub request_timeout: Duration,
    active: Mutex<Option<ActiveConnection>>,
    next_generation: AtomicU64,
}

impl OffloadState {
    pub fn new(token: String, model_sha256: [u8; 32], request_timeout: Duration) -> Self {
        Self {
            token,
            model_sha256,
            request_timeout,
            active: Mutex::new(None),
            next_generation: AtomicU64::new(0),
        }
    }

    /// Register a new connection, superseding any prior one. Returns the
    /// new connection's generation id (for the caller's own shutdown
    /// bookkeeping) and the OLD connection, if any -- deliberately handed
    /// back to the caller rather than shut down here, so its shutdown
    /// signal fires OUTSIDE this lock (design decision #6's own "swaps in
    /// new connection, returns old so its shutdown fires outside the
    /// lock").
    pub(crate) async fn replace(
        &self,
        sender: mpsc::Sender<PendingRequest>,
        shutdown: oneshot::Sender<()>,
    ) -> (u64, Option<ActiveConnection>) {
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
        let new = ActiveConnection {
            generation,
            sender,
            shutdown,
        };
        let mut guard = self.active.lock().await;
        let old = guard.replace(new);
        (generation, old)
    }

    /// Clear the active slot only if it's still occupied by `generation`
    /// -- a connection's own shutdown path must never clear a NEWER
    /// connection that has since taken over the slot (the exact race
    /// `replace()`'s generation-tagging exists to prevent).
    pub(crate) async fn clear_if_current(&self, generation: u64) {
        let mut guard = self.active.lock().await;
        if guard.as_ref().map(|c| c.generation) == Some(generation) {
            *guard = None;
        }
    }

    /// Whether a helper is currently connected -- used by the
    /// discoverability hint/status tool, not by the inference path itself
    /// (which just calls `try_offload` and treats "nothing connected"
    /// identically to "timed out").
    pub async fn is_connected(&self) -> bool {
        self.active.lock().await.is_some()
    }

    /// One offload inference round-trip. `None` covers every non-success
    /// outcome uniformly (nothing connected, the connection's own task
    /// already exited, no reply within `request_timeout`, or a reply
    /// that never arrived because the connection died mid-request) --
    /// design decision #6/#7: all of these are silent local-fallback
    /// signals to the caller, never errors.
    pub async fn try_offload(
        &self,
        frame_w: u32,
        frame_h: u32,
        crops: Arc<Vec<RawCrop>>,
    ) -> Option<Vec<CascadeResult>> {
        let sender = {
            let guard = self.active.lock().await;
            guard.as_ref()?.sender.clone()
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        let request = PendingRequest {
            frame_w,
            frame_h,
            crops,
            reply: reply_tx,
        };
        if sender.send(request).await.is_err() {
            // The connection's own task already exited (its receiver
            // dropped) -- identical outcome to "nothing connected".
            return None;
        }
        match tokio::time::timeout(self.request_timeout, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => None, // reply sender dropped without answering
            Err(_) => None,     // timed out
        }
    }
}

/// Adapt an [`OffloadState`] into detection-vision's generic
/// `OffloadInferenceFn` closure interface, for registration via
/// `pikvm_mcp_detection_vision::offload::set_offload_client`. Kept as a
/// free function (not an `OffloadState` method) since it's purely about
/// bridging two crates' interfaces, not core registry behavior.
pub fn as_offload_inference_fn(
    state: Arc<OffloadState>,
) -> pikvm_mcp_detection_vision::offload::OffloadInferenceFn {
    Arc::new(move |frame_w, frame_h, crops| {
        let state = state.clone();
        Box::pin(async move { state.try_offload(frame_w, frame_h, crops).await })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> OffloadState {
        OffloadState::new(
            "test-token".to_string(),
            [0u8; 32],
            Duration::from_millis(200),
        )
    }

    #[tokio::test]
    async fn try_offload_returns_none_when_nothing_connected() {
        let state = state();
        assert!(!state.is_connected().await);
        let out = state.try_offload(100, 100, Arc::new(vec![])).await;
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn replace_registers_a_connection_is_connected_becomes_true() {
        let state = state();
        let (tx, _rx) = mpsc::channel(1);
        let (shutdown_tx, _shutdown_rx) = oneshot::channel();
        let (generation, old) = state.replace(tx, shutdown_tx).await;
        assert_eq!(generation, 0);
        assert!(old.is_none());
        assert!(state.is_connected().await);
    }

    #[tokio::test]
    async fn replace_returns_the_superseded_connection_rather_than_dropping_it_silently() {
        let state = state();
        let (tx1, _rx1) = mpsc::channel(1);
        let (shutdown1, _s1) = oneshot::channel();
        let (gen1, old1) = state.replace(tx1, shutdown1).await;
        assert!(old1.is_none());

        let (tx2, _rx2) = mpsc::channel(1);
        let (shutdown2, _s2) = oneshot::channel();
        let (gen2, old2) = state.replace(tx2, shutdown2).await;
        assert_ne!(gen1, gen2);
        let old2 = old2.expect("the first connection should come back, not be dropped");
        assert_eq!(old2.generation, gen1);
    }

    #[tokio::test]
    async fn clear_if_current_only_clears_a_still_current_generation() {
        let state = state();
        let (tx1, _rx1) = mpsc::channel(1);
        let (shutdown1, _s1) = oneshot::channel();
        let (gen1, _old1) = state.replace(tx1, shutdown1).await;

        let (tx2, _rx2) = mpsc::channel(1);
        let (shutdown2, _s2) = oneshot::channel();
        let (_gen2, _old2) = state.replace(tx2, shutdown2).await;

        // gen1 has already been superseded by gen2 -- clearing it must be
        // a no-op, not accidentally clear the NEWER connection.
        state.clear_if_current(gen1).await;
        assert!(state.is_connected().await);
    }

    #[tokio::test]
    async fn clear_if_current_clears_the_actually_current_generation() {
        let state = state();
        let (tx, _rx) = mpsc::channel(1);
        let (shutdown, _s) = oneshot::channel();
        let (generation, _old) = state.replace(tx, shutdown).await;

        state.clear_if_current(generation).await;
        assert!(!state.is_connected().await);
    }

    #[tokio::test]
    async fn try_offload_returns_none_when_the_connections_own_receiver_was_dropped() {
        let state = state();
        let (tx, rx) = mpsc::channel(1);
        drop(rx); // simulate the connection task having already exited
        let (shutdown, _s) = oneshot::channel();
        state.replace(tx, shutdown).await;

        let out = state.try_offload(100, 100, Arc::new(vec![])).await;
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn try_offload_returns_none_on_timeout_when_nobody_replies() {
        let state = state();
        let (tx, mut rx) = mpsc::channel(1);
        let (shutdown, _s) = oneshot::channel();
        state.replace(tx, shutdown).await;

        // Receive the request but never reply -- the timeout must fire
        // rather than hang forever.
        let recv_task = tokio::spawn(async move { rx.recv().await });
        let out = state.try_offload(100, 100, Arc::new(vec![])).await;
        assert!(out.is_none());
        recv_task.abort();
    }

    #[tokio::test]
    async fn try_offload_returns_the_real_result_when_a_reply_arrives_in_time() {
        let state = state();
        let (tx, mut rx) = mpsc::channel(1);
        let (shutdown, _s) = oneshot::channel();
        state.replace(tx, shutdown).await;

        let responder = tokio::spawn(async move {
            let pending = rx.recv().await.expect("request should arrive");
            let _ = pending.reply.send(Some(vec![CascadeResult {
                x: 5,
                y: 6,
                presence: 0.8,
                heatmap_peak: 0.8,
            }]));
        });
        let out = state.try_offload(640, 480, Arc::new(vec![])).await;
        responder.await.unwrap();
        let results = out.expect("a reply arrived in time");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].x, 5);
    }

    #[tokio::test]
    async fn as_offload_inference_fn_bridges_into_the_detection_vision_interface() {
        let state = Arc::new(state());
        let f = as_offload_inference_fn(state.clone());
        let out = f(100, 100, Arc::new(vec![])).await;
        assert!(out.is_none()); // nothing connected -- same contract as try_offload directly
    }
}
