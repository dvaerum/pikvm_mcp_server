//! Pure liveness-decision helper for the held `/api/ws` connection's
//! active ping/pong loop (`connection.rs`).
//!
//! See docs/streamer-keepalive-liveness-ping-plan.md for the full
//! history: `real_connect`'s read loop used to be purely passive (the
//! write half was dropped entirely, no active probe ever sent) —
//! consistent with a zombie-connection failure class where an
//! intermediate NAT/proxy silently drops the mapping during a long idle
//! window without ever delivering a close frame back to this side,
//! leaving `StreamerKeepalive::connected()` reporting `true` for a
//! connection whose actual capability is gone. Once zombied that way,
//! `ensure_started()`'s own "no-op if already connected()" check means
//! it could NEVER self-heal for the rest of the process's life.
//!
//! This module holds only the pure "has too much time passed since the
//! connection last proved itself alive?" decision — no networking, no
//! async — so it's trivially unit-testable with plain
//! `Instant`/`Duration` arithmetic. The real ping/pong I/O loop that
//! feeds it lives in `connection.rs`, deliberately left untested there
//! per this module's own established convention (real sockets/TLS,
//! covered by the crate's hardware gate instead — see that file's own
//! header comment).

use std::time::{Duration, Instant};

/// `true` if `now` is more than `timeout` past `last_proof_of_life` —
/// i.e. the connection hasn't proven itself alive (a received frame, or
/// the connection's own handshake if none has arrived yet) recently
/// enough to still be trusted.
pub(super) fn is_stale(last_proof_of_life: Instant, now: Instant, timeout: Duration) -> bool {
    now.duration_since(last_proof_of_life) > timeout
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_stale_well_within_the_timeout() {
        let last = Instant::now();
        let now = last + Duration::from_secs(1);
        assert!(!is_stale(last, now, Duration::from_secs(5)));
    }

    #[test]
    fn not_stale_exactly_at_the_boundary() {
        let last = Instant::now();
        let now = last + Duration::from_secs(5);
        // Strictly-greater-than semantics: exactly at the timeout is NOT
        // yet stale (matches `is_stale`'s doc: "MORE than timeout").
        assert!(!is_stale(last, now, Duration::from_secs(5)));
    }

    #[test]
    fn stale_just_past_the_boundary() {
        let last = Instant::now();
        let now = last + Duration::from_millis(5001);
        assert!(is_stale(last, now, Duration::from_secs(5)));
    }

    #[test]
    fn stale_well_past_the_timeout() {
        let last = Instant::now();
        let now = last + Duration::from_secs(30);
        assert!(is_stale(last, now, Duration::from_secs(5)));
    }

    #[test]
    fn not_stale_when_now_equals_last_proof_of_life() {
        let now = Instant::now();
        assert!(!is_stale(now, now, Duration::from_secs(5)));
    }
}
