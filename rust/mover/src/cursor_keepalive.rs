//! Phase 187 (v0.5.177): cursor-keepalive wiggle.
//!
//! iPadOS auto-hides the on-screen pointer after ~1 s of mouse
//! inactivity. Cursor-detection code (motion-diff in moveToPixel,
//! template-match in click-verify, pre-click verification) takes
//! screenshots throughout the click pipeline; if the pipeline ever
//! pauses long enough for the cursor to fade, the next detection frame
//! is cursor-less and detection fails.
//!
//! This module provides `keep_cursor_alive`: if the elapsed gap since
//! the last recorded emit (`pikvm_mcp_kvmd_client::emit_clock`, stamped
//! by `PiKVMClient::mouse_move_relative`) exceeds `stale_threshold_ms`,
//! emits a minimal +1/-1 round-trip wiggle (net-zero displacement) so
//! the next screenshot has the pointer rendered. Cheap when called in
//! tight loops — does nothing if a recent emit already woke the cursor.
//! `should_wiggle` is the pure predicate, exposed for unit tests and
//! callers that want to gate on staleness without performing the
//! wiggle.
//!
//! Faithful port of the layer-4 half of `src/pikvm/cursor-keepalive.ts`
//! (`recordEmit`/the raw clock live in
//! `pikvm_mcp_kvmd_client::emit_clock` — see that module's header for
//! why the clock itself is module 2, not module 4).

use std::time::Duration;

use pikvm_mcp_kvmd_client::client::{ClientError, PiKVMClient};
use pikvm_mcp_kvmd_client::emit_clock;

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis() as u64
}

pub struct ShouldWiggleArgs {
    pub last_emit_ms: Option<u64>,
    pub now_ms: u64,
    pub stale_threshold_ms: u64,
}

/// Pure predicate. Returns true if `now_ms - last_emit_ms > threshold`,
/// meaning the cursor has likely faded out of view on iPadOS and the
/// next detection screenshot will see no cursor pixels.
///
/// Returns false when:
/// - No emit has ever been recorded (`last_emit_ms: None`) — the caller
///   is on a fresh process and we don't know the cursor's state; don't
///   wiggle speculatively.
/// - elapsed ≤ threshold — cursor still visible.
///
/// Boundary is strictly greater-than, not ≥, so `stale_threshold_ms`
/// reads as "wait this long before treating it as stale".
pub fn should_wiggle(args: ShouldWiggleArgs) -> bool {
    let Some(last) = args.last_emit_ms else {
        return false;
    };
    args.now_ms.saturating_sub(last) > args.stale_threshold_ms
}

#[derive(Debug, Clone, Copy)]
pub struct KeepCursorAliveOptions {
    /// Master switch. Default true. Set false to disable for tests or
    /// for desktop targets where the cursor doesn't auto-hide.
    pub enabled: bool,
    /// Minimum elapsed time since the last recorded emit before the
    /// wiggle fires. Default 700 ms — well below iPadOS's ~1 s
    /// auto-hide threshold so we wake BEFORE the cursor fades.
    pub stale_threshold_ms: u64,
    /// Settle delay after the wiggle. Default 200 ms — enough for the
    /// PiKVM streamer + iPadOS render pipeline (150-235 ms measured
    /// Phase 13) to render the woken cursor in the next screenshot.
    pub settle_ms: u64,
    pub verbose: bool,
}

impl Default for KeepCursorAliveOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            stale_threshold_ms: 700,
            settle_ms: 200,
            verbose: false,
        }
    }
}

/// When the elapsed time since the last mouse emit exceeds the stale
/// threshold, emit a minimal +1/-1 X-axis round-trip to keep the
/// iPadOS pointer rendered. Net-zero displacement. No-op when recent
/// activity makes the wiggle unnecessary or when `enabled: false`.
///
/// Production wiring: call before any screenshot used for cursor
/// detection. Cheap (one clock read and a branch) on the no-wiggle
/// path, so peppering the call sites is safe.
pub async fn keep_cursor_alive(
    client: &PiKVMClient,
    options: Option<KeepCursorAliveOptions>,
) -> Result<(), ClientError> {
    let options = options.unwrap_or_default();
    if !options.enabled {
        return Ok(());
    }

    if !should_wiggle(ShouldWiggleArgs {
        last_emit_ms: emit_clock::last_emit_ms(),
        now_ms: now_ms(),
        stale_threshold_ms: options.stale_threshold_ms,
    }) {
        return Ok(());
    }

    if options.verbose {
        let elapsed = match emit_clock::last_emit_ms() {
            None => "null".to_string(),
            Some(last) => format!("{}ms", now_ms().saturating_sub(last)),
        };
        eprintln!("[keepalive] wiggling ({elapsed} since last emit)");
    }

    client.mouse_move_relative(1.0, 0.0).await?;
    tokio::time::sleep(Duration::from_millis(30)).await;
    client.mouse_move_relative(-1.0, 0.0).await?;
    // Stamp the clock so a follow-up keepalive call within threshold is
    // a correct no-op (the wiggle is itself activity).
    emit_clock::record_emit();
    if options.settle_ms > 0 {
        tokio::time::sleep(Duration::from_millis(options.settle_ms)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};
    use std::sync::{Arc, Mutex as StdMutex};

    // emit_clock is a process-global static shared by every test in this
    // crate's test binary — serialize against the crate-wide lock, not a
    // file-local one, so this doesn't race against slam.rs's/
    // cursor_anchor.rs's own tests touching the same static. See
    // `crate::test_support::GLOBAL_STATE_LOCK`'s doc.
    use crate::test_support::GLOBAL_STATE_LOCK as TEST_LOCK;

    /// Records every `/hid/events/send_mouse_relative` path hit (which
    /// embeds `delta_x=.../delta_y=...`) so assertions can reconstruct
    /// the TS test's `calls: RecordedCall[]` — the DI seam here is
    /// `PiKVMClient`'s own injected `RequestFn` (client.rs's existing
    /// test seam), not a new mock layer.
    fn recording_client() -> (PiKVMClient, Arc<StdMutex<Vec<String>>>) {
        let calls: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let calls_bg = calls.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let calls = calls_bg.clone();
            Box::pin(async move {
                if args.path.starts_with("/hid/events/send_mouse_relative") {
                    calls.lock().unwrap().push(args.path.clone());
                }
                Ok(ResponseBody::Empty)
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://mock.local", "admin", "pw"),
            None,
            request_fn,
        );
        (client, calls)
    }

    fn parse_delta(path: &str) -> (i64, i64) {
        let mut dx = 0i64;
        let mut dy = 0i64;
        for pair in path.split('?').nth(1).unwrap_or("").split('&') {
            if let Some(v) = pair.strip_prefix("delta_x=") {
                dx = v.parse().unwrap();
            } else if let Some(v) = pair.strip_prefix("delta_y=") {
                dy = v.parse().unwrap();
            }
        }
        (dx, dy)
    }

    mod should_wiggle_pure {
        use super::*;

        #[test]
        fn returns_false_when_no_emit_has_been_recorded_yet() {
            assert!(!should_wiggle(ShouldWiggleArgs {
                last_emit_ms: None,
                now_ms: 1000,
                stale_threshold_ms: 700
            }));
        }

        #[test]
        fn returns_false_when_elapsed_is_less_than_threshold() {
            assert!(!should_wiggle(ShouldWiggleArgs {
                last_emit_ms: Some(1000),
                now_ms: 1500,
                stale_threshold_ms: 700
            }));
        }

        #[test]
        fn returns_false_at_exactly_the_threshold_boundary() {
            // Conservative — only wiggle when STRICTLY stale.
            assert!(!should_wiggle(ShouldWiggleArgs {
                last_emit_ms: Some(1000),
                now_ms: 1700,
                stale_threshold_ms: 700
            }));
        }

        #[test]
        fn returns_true_when_elapsed_exceeds_threshold() {
            assert!(should_wiggle(ShouldWiggleArgs {
                last_emit_ms: Some(1000),
                now_ms: 1701,
                stale_threshold_ms: 700
            }));
        }

        #[test]
        fn returns_true_on_a_long_gap() {
            assert!(should_wiggle(ShouldWiggleArgs {
                last_emit_ms: Some(1000),
                now_ms: 3000,
                stale_threshold_ms: 700
            }));
        }
    }

    /// `keep_cursor_alive`'s staleness check reads `emit_clock`'s REAL
    /// `SystemTime`-based clock (correctly matching TS's real
    /// `Date.now()`-based `lastEmitMs` — that's the faithful behavior,
    /// not a bug). That means `tokio::time::pause()`/`advance()` — a
    /// SEPARATE virtual clock used only by `tokio::time::sleep` — cannot
    /// be used to simulate staleness here the way the TS suite's unified
    /// `vi.useFakeTimers()` could (it fakes `Date.now()` too). So these
    /// tests use small REAL durations instead of virtual-clock stepping:
    /// slower than a paused-clock test, but actually exercises the real
    /// clock path rather than a mismatched one that silently never goes
    /// stale (caught live: the first version of these tests used
    /// `advance()` and every "stale" assertion failed because real
    /// elapsed time was ~0 regardless of how far the virtual clock
    /// moved).
    mod keep_cursor_alive_tests {
        use super::*;

        const FAST_STALE_MS: u64 = 40;
        const FAST_SETTLE_WAIT_MS: u64 = 60;

        #[tokio::test]
        async fn is_a_no_op_on_a_fresh_process_no_recorded_emit_yet() {
            let _guard = TEST_LOCK.lock().await;
            emit_clock::reset_for_test();
            let (client, calls) = recording_client();
            keep_cursor_alive(
                &client,
                Some(KeepCursorAliveOptions {
                    stale_threshold_ms: FAST_STALE_MS,
                    settle_ms: 0,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            assert_eq!(calls.lock().unwrap().len(), 0);
        }

        #[tokio::test]
        async fn does_not_wiggle_when_last_emit_was_recent() {
            let _guard = TEST_LOCK.lock().await;
            emit_clock::reset_for_test();
            let (client, calls) = recording_client();
            emit_clock::record_emit();
            // No wait — well inside the threshold.
            keep_cursor_alive(
                &client,
                Some(KeepCursorAliveOptions {
                    stale_threshold_ms: 10_000,
                    settle_ms: 0,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            assert_eq!(calls.lock().unwrap().len(), 0);
        }

        #[tokio::test]
        async fn wiggles_plus_1_minus_1_when_last_emit_is_stale() {
            let _guard = TEST_LOCK.lock().await;
            emit_clock::reset_for_test();
            let (client, calls) = recording_client();
            emit_clock::record_emit();
            tokio::time::sleep(Duration::from_millis(FAST_SETTLE_WAIT_MS)).await;
            keep_cursor_alive(
                &client,
                Some(KeepCursorAliveOptions {
                    stale_threshold_ms: FAST_STALE_MS,
                    settle_ms: 0,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            assert_eq!(recorded.len(), 2);
            assert_eq!(parse_delta(&recorded[0]), (1, 0));
            assert_eq!(parse_delta(&recorded[1]), (-1, 0));
        }

        #[tokio::test]
        async fn the_wiggle_nets_zero_displacement() {
            let _guard = TEST_LOCK.lock().await;
            emit_clock::reset_for_test();
            let (client, calls) = recording_client();
            emit_clock::record_emit();
            tokio::time::sleep(Duration::from_millis(FAST_SETTLE_WAIT_MS)).await;
            keep_cursor_alive(
                &client,
                Some(KeepCursorAliveOptions {
                    stale_threshold_ms: FAST_STALE_MS,
                    settle_ms: 0,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            let recorded = calls.lock().unwrap().clone();
            let (total_dx, total_dy) = recorded
                .iter()
                .map(|p| parse_delta(p))
                .fold((0i64, 0i64), |(ax, ay), (x, y)| (ax + x, ay + y));
            assert_eq!(total_dx, 0);
            assert_eq!(total_dy, 0);
        }

        #[tokio::test]
        async fn records_its_own_emit_so_a_follow_up_call_within_threshold_is_a_no_op() {
            let _guard = TEST_LOCK.lock().await;
            emit_clock::reset_for_test();
            let (client, calls) = recording_client();
            emit_clock::record_emit();
            tokio::time::sleep(Duration::from_millis(FAST_SETTLE_WAIT_MS)).await;
            keep_cursor_alive(
                &client,
                Some(KeepCursorAliveOptions {
                    stale_threshold_ms: FAST_STALE_MS,
                    settle_ms: 0,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            assert_eq!(calls.lock().unwrap().len(), 2);
            // Now an immediate re-call: should NOT wiggle again (we just woke it).
            keep_cursor_alive(
                &client,
                Some(KeepCursorAliveOptions {
                    stale_threshold_ms: FAST_STALE_MS,
                    settle_ms: 0,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            assert_eq!(calls.lock().unwrap().len(), 2);
        }

        #[tokio::test]
        async fn honours_the_settle_ms_argument() {
            let _guard = TEST_LOCK.lock().await;
            emit_clock::reset_for_test();
            let (client, _calls) = recording_client();
            emit_clock::record_emit();
            tokio::time::sleep(Duration::from_millis(FAST_SETTLE_WAIT_MS)).await;

            let start = std::time::Instant::now();
            keep_cursor_alive(
                &client,
                Some(KeepCursorAliveOptions {
                    stale_threshold_ms: FAST_STALE_MS,
                    settle_ms: 150,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            // Initial wiggle pair: 30 ms inter-pause, then settle_ms after —
            // generous lower-bound tolerance for scheduling jitter (same
            // discipline as client.rs's real streamer-retry tests).
            assert!(start.elapsed() >= Duration::from_millis(150));
        }

        #[tokio::test]
        async fn disabled_via_enabled_false_is_always_a_no_op_even_when_stale() {
            let _guard = TEST_LOCK.lock().await;
            emit_clock::reset_for_test();
            let (client, calls) = recording_client();
            emit_clock::record_emit();
            tokio::time::sleep(Duration::from_millis(FAST_SETTLE_WAIT_MS)).await;
            keep_cursor_alive(
                &client,
                Some(KeepCursorAliveOptions {
                    enabled: false,
                    stale_threshold_ms: FAST_STALE_MS,
                    settle_ms: 0,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            assert_eq!(calls.lock().unwrap().len(), 0);
        }
    }
}
