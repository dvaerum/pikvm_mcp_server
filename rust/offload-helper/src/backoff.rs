//! Reconnect backoff — deliberately mirrors
//! `kvmd-client/src/streamer_keepalive`'s own shape exactly (per the
//! design doc's §9 rollout: "reconnect modeled on
//! kvmd-client/src/streamer_keepalive/'s backoff shape"), rather than
//! reinventing a different curve for what's the same underlying problem
//! (a long-lived process that should keep trying a flaky/absent peer
//! without hammering it or giving up).

use std::time::Duration;

/// Same values as `kvmd-client/src/streamer_keepalive/types.rs`'s own
/// `RECONNECT_BASE_MS`/`RECONNECT_MAX_MS` (confirmed in source,
/// `docs/rust-port-plan.md` §63/§65) — not independently chosen.
pub const RECONNECT_BASE_MS: u64 = 1000;
pub const RECONNECT_MAX_MS: u64 = 30_000;

/// Doubles on each failed attempt, capped at `RECONNECT_MAX_MS` — the
/// exact `(delay * 2).min(RECONNECT_MAX_MS)` formula
/// `schedule_reconnect_task` uses. Pure function (no I/O, no shared
/// state) so the curve itself is unit-testable without a fake clock or a
/// real connection.
pub fn next_delay_ms(current_ms: u64) -> u64 {
    (current_ms.saturating_mul(2)).min(RECONNECT_MAX_MS)
}

/// Tracks the current backoff delay across repeated failures, resetting
/// to the base delay on any success — mirrors
/// `StreamerKeepalive.reconnect_delay_ms`'s own reset-on-success
/// behavior (`connect_once`'s `Ok(session)` branch).
pub struct Backoff {
    current_ms: u64,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub fn new() -> Self {
        Self {
            current_ms: RECONNECT_BASE_MS,
        }
    }

    /// The delay to wait before the NEXT attempt, given the current one
    /// just failed — also advances internal state for the attempt after
    /// that.
    pub fn on_failure(&mut self) -> Duration {
        let delay = self.current_ms;
        self.current_ms = next_delay_ms(self.current_ms);
        Duration::from_millis(delay)
    }

    /// Reset to the base delay — call after a successful connection.
    pub fn on_success(&mut self) {
        self.current_ms = RECONNECT_BASE_MS;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_delay_doubles_each_time() {
        assert_eq!(next_delay_ms(1000), 2000);
        assert_eq!(next_delay_ms(2000), 4000);
        assert_eq!(next_delay_ms(4000), 8000);
    }

    #[test]
    fn next_delay_caps_at_the_max() {
        assert_eq!(next_delay_ms(20_000), 30_000); // 40_000 would overshoot
        assert_eq!(next_delay_ms(30_000), 30_000); // already at the cap
    }

    #[test]
    fn backoff_starts_at_the_base_delay() {
        let mut b = Backoff::new();
        assert_eq!(b.on_failure(), Duration::from_millis(RECONNECT_BASE_MS));
    }

    #[test]
    fn backoff_doubles_across_repeated_failures_and_caps() {
        let mut b = Backoff::new();
        let delays: Vec<u64> = (0..8).map(|_| b.on_failure().as_millis() as u64).collect();
        assert_eq!(
            delays,
            vec![1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]
        );
    }

    #[test]
    fn on_success_resets_to_the_base_delay() {
        let mut b = Backoff::new();
        b.on_failure();
        b.on_failure();
        b.on_failure(); // now at 4000ms internally
        b.on_success();
        assert_eq!(b.on_failure(), Duration::from_millis(RECONNECT_BASE_MS));
    }
}
