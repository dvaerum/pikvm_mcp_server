//! Faded-cursor wake (M2). A fully-faded iPad pointer is invisible, so
//! V8 start-detection fails and curve-one-shot can't compute its move.
//! A net-neutral relative jiggle un-fades the pointer in place (absolute
//! moves are a no-op on iPad — M1), after which detection succeeds.
//! Params validated live on the real rig (georgs 2026-07-27, full-fade
//! 15s A/B: control 0/20 → wake 20/20): 8 alternating emits of ±35px X /
//! ±25px Y, ~70ms apart, ~200ms settle, then re-detect. Fired ONLY on a
//! detection failure, so the visible-cursor hot path (detects first
//! try) adds zero motion/latency.

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_kvmd_client::client::PiKVMClient;

use super::super::move_to::Point;
use super::types::DetectFn;

pub const WAKE_EMIT_COUNT: u32 = 8;
pub const WAKE_EMIT_DX: f64 = 35.0;
pub const WAKE_EMIT_DY: f64 = 25.0;
const WAKE_EMIT_PACE_MS: u64 = 70;
const WAKE_SETTLE_MS: u64 = 200;

/// The relative-emit sequence for the faded-cursor wake:
/// `WAKE_EMIT_COUNT` alternating-sign emits of (±`WAKE_EMIT_DX`,
/// ±`WAKE_EMIT_DY`). The alternation sums to a NET-ZERO displacement
/// (even count) so the pointer un-fades in place — the subsequent
/// detect finds it where it faded, not somewhere new. Pure so the
/// pattern is unit-tested without a live rig.
pub fn plan_wake_emits() -> Vec<(f64, f64)> {
    (0..WAKE_EMIT_COUNT)
        .map(|i| {
            let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
            (sign * WAKE_EMIT_DX, sign * WAKE_EMIT_DY)
        })
        .collect()
}

/// Apply the wake jiggle then re-detect once. Returns the detected
/// cursor, or `None` if the pointer is genuinely absent (not merely
/// faded) — the caller then fails honestly rather than clicking blind.
pub(super) async fn wake_cursor_and_redetect(
    client: &Arc<PiKVMClient>,
    min_presence: f64,
    detect_fn: &DetectFn,
) -> anyhow::Result<Option<Point>> {
    for (dx, dy) in plan_wake_emits() {
        client.mouse_move_relative(dx, dy).await?;
        tokio::time::sleep(Duration::from_millis(WAKE_EMIT_PACE_MS)).await;
    }
    tokio::time::sleep(Duration::from_millis(WAKE_SETTLE_MS)).await;
    detect_fn(client.clone(), min_presence, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_wake_emit_count_alternating_sign_dx_dy_relative_moves() {
        let emits = plan_wake_emits();
        assert_eq!(emits.len(), WAKE_EMIT_COUNT as usize);
        for (dx, dy) in &emits {
            assert_eq!(dx.abs(), WAKE_EMIT_DX);
            assert_eq!(dy.abs(), WAKE_EMIT_DY);
        }
        // Alternating sign: [+,+], [-,-], [+,+], ...
        assert_eq!(emits[0], (WAKE_EMIT_DX, WAKE_EMIT_DY));
        assert_eq!(emits[1], (-WAKE_EMIT_DX, -WAKE_EMIT_DY));
    }

    #[test]
    fn sums_to_a_net_zero_displacement_un_fades_in_place_does_not_relocate() {
        let (sx, sy) = plan_wake_emits()
            .into_iter()
            .fold((0.0, 0.0), |(ax, ay), (dx, dy)| (ax + dx, ay + dy));
        assert_eq!((sx, sy), (0.0, 0.0));
    }

    #[test]
    fn uses_the_live_validated_magnitudes_35px_x_25px_y_8_emits() {
        assert_eq!(WAKE_EMIT_COUNT, 8);
        assert_eq!(WAKE_EMIT_DX, 35.0);
        assert_eq!(WAKE_EMIT_DY, 25.0);
    }
}
