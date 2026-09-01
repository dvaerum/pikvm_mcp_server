//! Process-wide offload-inference client singleton
//! (docs/cursor-offload-inference-design.md, task_d06561d91f58).
//!
//! Same shape as this crate's existing `VERIFIER_SESSION`/`REGION_CACHE`
//! statics (`cursor_ml_detect.rs`) -- a process-global slot, set (or cleared)
//! by whatever owns the offload WS connection (`pikvm-mcp-server`'s
//! `offload` module, not this crate), read by `cursor_ml_detect.rs`'s
//! `run_cascade_inference_prefiltered` on every no-hint scan.
//!
//! `None` in the outer `Option` means "no offload client registered at all"
//! (offload disabled, or nothing has connected yet this process). Once
//! registered, calling the function itself and getting back `None` means
//! "asked, but no helper is connected right now, or it timed out" -- both
//! are normal, expected, silent-fallback-to-local outcomes, never errors.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};

use crate::cursor_ml_detect::{CascadeResult, RawCrop};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Attempt one offload inference round-trip for a full batch of crops.
/// Returns `None` when no helper is connected, the connection dropped
/// mid-request, or the request timed out -- the caller's only correct
/// response to `None` is falling back to local inference for this call,
/// never treating it as an error.
pub type OffloadInferenceFn = std::sync::Arc<
    dyn Fn(u32, u32, std::sync::Arc<Vec<RawCrop>>) -> BoxFuture<'static, Option<Vec<CascadeResult>>>
        + Send
        + Sync,
>;

static OFFLOAD_CLIENT: OnceLock<Mutex<Option<OffloadInferenceFn>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<OffloadInferenceFn>> {
    OFFLOAD_CLIENT.get_or_init(|| Mutex::new(None))
}

/// Register (or replace) the process-wide offload client. Called by
/// whatever owns the live WS connection when one comes up.
pub fn set_offload_client(f: OffloadInferenceFn) {
    *slot().lock().unwrap() = Some(f);
}

/// Clear the process-wide offload client. Called when the WS connection
/// drops, so `is_offload_client_registered`/`try_offload` correctly report
/// "nothing connected" again rather than calling a dead handle.
pub fn clear_offload_client() {
    *slot().lock().unwrap() = None;
}

/// Cheap, plain **synchronous** check -- no `block_in_place`, no runtime
/// requirement, safe to call from anywhere including a plain `#[test]` with
/// zero tokio runtime present. This is the gate `run_changed_crops` (in
/// `cursor_ml_detect.rs`) must check FIRST, before ever calling
/// `Handle::current()` inside its `block_in_place` bridge -- confirmed
/// directly against tokio's own source and live behavior (that function's
/// own doc comment has the details): `Handle::current()` panics with no
/// enclosing runtime, and this crate's detection functions have real
/// plain-sync callers today.
pub fn is_offload_client_registered() -> bool {
    slot().lock().unwrap().is_some()
}

/// Run one offload round-trip through the registered client, if any.
/// Caller must already have confirmed `is_offload_client_registered()` --
/// this function itself does not special-case the unregistered case any
/// differently from a registered-but-failed one; both correctly resolve to
/// `None`. Genuinely `async` -- calling this requires a tokio runtime,
/// which is exactly why callers gate on the plain sync check above first.
pub async fn try_offload(
    frame_w: u32,
    frame_h: u32,
    crops: std::sync::Arc<Vec<RawCrop>>,
) -> Option<Vec<CascadeResult>> {
    let client = slot().lock().unwrap().clone()?;
    client(frame_w, frame_h, crops).await
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    *slot().lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Serializes tests against this module's own process-global static --
    // mirrors crop_cache's/emit_clock's own TEST_LOCK convention, since a
    // shared `OnceLock<Mutex<...>>` would otherwise let parallel test
    // threads stomp each other's registered-client state. `tokio::sync::
    // Mutex` (not `std::sync::Mutex`) deliberately -- two of these tests
    // hold the guard across an `.await`, which clippy's own
    // `await_holding_lock` lint correctly flags as a real deadlock risk
    // for a std lock; an async-aware lock is designed to be held there.
    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn nothing_registered_by_default() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test();
        assert!(!is_offload_client_registered());
    }

    #[tokio::test]
    async fn set_then_clear_round_trips_the_registered_flag() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test();
        let f: OffloadInferenceFn = std::sync::Arc::new(|_, _, _| Box::pin(async { None }));
        set_offload_client(f);
        assert!(is_offload_client_registered());
        clear_offload_client();
        assert!(!is_offload_client_registered());
    }

    #[tokio::test]
    async fn try_offload_returns_none_when_nothing_registered() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test();
        let out = try_offload(100, 100, std::sync::Arc::new(vec![])).await;
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn try_offload_calls_the_registered_client_and_returns_its_result() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test();
        let f: OffloadInferenceFn = std::sync::Arc::new(|fw, fh, crops| {
            Box::pin(async move {
                assert_eq!(fw, 640);
                assert_eq!(fh, 480);
                assert_eq!(crops.len(), 0);
                Some(vec![CascadeResult {
                    x: 1,
                    y: 2,
                    presence: 0.9,
                    heatmap_peak: 0.9,
                }])
            })
        });
        set_offload_client(f);
        let out = try_offload(640, 480, std::sync::Arc::new(vec![])).await;
        reset_for_test();
        let results = out.expect("client was registered, should have answered");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].x, 1);
    }
}
