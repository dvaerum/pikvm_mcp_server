//! Reusable relative-mouse HID gestures.
//!
//! The "emit a total displacement as a train of ≤chunk-magnitude relative
//! deltas, optionally paced" pattern was hand-inlined in several places —
//! move-to's correction/open-loop emits and ipad-unlock's positioning +
//! swipe loops. This module is the single home for that primitive so the
//! loop lives once and every caller shares the same clamping/pacing/sign
//! handling.
//!
//! Faithful port of `src/pikvm/gesture.ts`.
//!
//! Crate placement: NOT `pikvm-mcp-ipad-primitives` despite that crate's
//! original plan to host this (see its own header comment) — that plan
//! assumed `emit_chunked`'s callers spanned modules 4 and 5. The real
//! import graph shows both real callers (`move-to.ts`, `ipad-unlock.ts`)
//! are `rust/mover` files, so this lives here directly.

use std::time::Duration;

use pikvm_mcp_kvmd_client::client::{ClientError, PiKVMClient};

/// Emit `(total_x, total_y)` relative mickeys as a sequence of per-call
/// deltas each no larger than `chunk_mag` in magnitude, sleeping
/// `chunk_pace_ms` between calls (but not after the final call). Sign of
/// the total is preserved per axis; a zero axis emits nothing on that
/// axis. Returns the number of emit calls made.
pub async fn emit_chunked(
    client: &PiKVMClient,
    total_x: f64,
    total_y: f64,
    chunk_mag: f64,
    chunk_pace_ms: u64,
) -> Result<u32, ClientError> {
    let mut rem_x = total_x.abs();
    let mut rem_y = total_y.abs();
    let sx = total_x.signum();
    let sy = total_y.signum();
    let mut chunks = 0u32;
    while rem_x > 0.0 || rem_y > 0.0 {
        let step_x = if rem_x > 0.0 {
            rem_x.min(chunk_mag) * sx
        } else {
            0.0
        };
        let step_y = if rem_y > 0.0 {
            rem_y.min(chunk_mag) * sy
        } else {
            0.0
        };
        client.mouse_move_relative(step_x, step_y).await?;
        rem_x = (rem_x - step_x.abs()).max(0.0);
        rem_y = (rem_y - step_y.abs()).max(0.0);
        chunks += 1;
        if chunk_pace_ms > 0 && (rem_x > 0.0 || rem_y > 0.0) {
            tokio::time::sleep(Duration::from_millis(chunk_pace_ms)).await;
        }
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};
    use std::sync::{Arc, Mutex};

    type Moves = Arc<Mutex<Vec<(f64, f64)>>>;

    fn stub_client() -> (PiKVMClient, Moves) {
        let moves: Moves = Arc::new(Mutex::new(Vec::new()));
        let moves_bg = moves.clone();
        let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
            let moves = moves_bg.clone();
            Box::pin(async move {
                if args.path.starts_with("/hid/events/send_mouse_relative") {
                    let mut dx = 0.0;
                    let mut dy = 0.0;
                    for pair in args.path.split('?').nth(1).unwrap_or("").split('&') {
                        if let Some(v) = pair.strip_prefix("delta_x=") {
                            dx = v.parse().unwrap();
                        } else if let Some(v) = pair.strip_prefix("delta_y=") {
                            dy = v.parse().unwrap();
                        }
                    }
                    moves.lock().unwrap().push((dx, dy));
                }
                Ok(ResponseBody::Empty)
            })
        });
        let client = PiKVMClient::with_request_fn(
            PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
            None,
            request_fn,
        );
        (client, moves)
    }

    #[tokio::test]
    async fn emits_a_single_call_when_the_total_fits_in_one_chunk() {
        let (client, moves) = stub_client();
        let chunks = emit_chunked(&client, 50.0, -30.0, 127.0, 0).await.unwrap();
        assert_eq!(chunks, 1);
        assert_eq!(*moves.lock().unwrap(), vec![(50.0, -30.0)]);
    }

    #[tokio::test]
    async fn splits_a_large_total_into_chunk_mag_sized_calls() {
        let (client, moves) = stub_client();
        let chunks = emit_chunked(&client, 300.0, 0.0, 127.0, 0).await.unwrap();
        // 300 = 127 + 127 + 46
        assert_eq!(chunks, 3);
        assert_eq!(
            *moves.lock().unwrap(),
            vec![(127.0, 0.0), (127.0, 0.0), (46.0, 0.0)]
        );
    }

    #[tokio::test]
    async fn preserves_sign_per_axis_independently() {
        let (client, moves) = stub_client();
        emit_chunked(&client, -200.0, 50.0, 100.0, 0).await.unwrap();
        for (dx, dy) in moves.lock().unwrap().iter() {
            assert!(*dx <= 0.0);
            assert!(*dy >= 0.0);
        }
    }

    #[tokio::test]
    async fn a_zero_axis_emits_nothing_on_that_axis() {
        let (client, moves) = stub_client();
        emit_chunked(&client, 0.0, 250.0, 100.0, 0).await.unwrap();
        for (dx, _dy) in moves.lock().unwrap().iter() {
            assert_eq!(*dx, 0.0);
        }
    }

    #[tokio::test]
    async fn zero_total_on_both_axes_emits_no_calls() {
        let (client, moves) = stub_client();
        let chunks = emit_chunked(&client, 0.0, 0.0, 100.0, 0).await.unwrap();
        assert_eq!(chunks, 0);
        assert!(moves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn different_axis_magnitudes_finish_independently_shorter_axis_stops_emitting() {
        let (client, moves) = stub_client();
        // x needs 2 chunks (100,100), y needs 3 chunks (100,100,50) — once x
        // is exhausted it must emit 0 on that axis for the remaining calls.
        let chunks = emit_chunked(&client, 200.0, 250.0, 100.0, 0).await.unwrap();
        assert_eq!(chunks, 3);
        let recorded = moves.lock().unwrap().clone();
        assert_eq!(recorded, vec![(100.0, 100.0), (100.0, 100.0), (0.0, 50.0)]);
    }

    #[tokio::test]
    async fn does_not_sleep_after_the_final_call() {
        // chunk_pace_ms > 0 but with a single-chunk total: if the
        // implementation slept unconditionally this test would still pass
        // functionally, but the real regression this guards is a hang on
        // multi-chunk totals under a mocked clock — covered qualitatively
        // by the total elapsed time staying near-zero for a real (short)
        // pace value in the fast single-chunk case.
        let (client, moves) = stub_client();
        let start = std::time::Instant::now();
        emit_chunked(&client, 10.0, 0.0, 127.0, 50).await.unwrap();
        assert!(start.elapsed() < std::time::Duration::from_millis(40));
        assert_eq!(moves.lock().unwrap().len(), 1);
    }
}
