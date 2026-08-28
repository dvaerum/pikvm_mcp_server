//! Module-level "last mouse emit" timestamp. Faithful port of the state
//! slice of `src/pikvm/cursor-keepalive.ts` that `client.ts` itself
//! touches: `recordEmit()` and the raw `lastEmitMs` clock.
//!
//! The REST of cursor-keepalive.ts (`keepCursorAlive`, `shouldWiggle`) is
//! layer-4 HID-orchestration logic that takes a `PiKVMClient` — an
//! ordinary forward dependency (layer 4 already depends on this crate for
//! the client type), not a coupling problem like the CursorBelief/
//! ipad-primitives cases. So only the clock lives here; layer 4's port
//! reads it via [`last_emit_ms`] when it's built.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LAST_EMIT_MS: Mutex<Option<u64>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis() as u64
}

/// Stamp the last-emit clock to now. Call after every mouse emit so the
/// keepalive guard (layer 4) knows when the cursor was last "active".
pub fn record_emit() {
    *LAST_EMIT_MS.lock().unwrap() = Some(now_ms());
}

/// Read the last-recorded emit timestamp. `None` = no emit recorded
/// since process start.
pub fn last_emit_ms() -> Option<u64> {
    *LAST_EMIT_MS.lock().unwrap()
}

/// Reset the module state. ONLY for unit tests — production callers
/// should never reset, because that would falsely report "no recent
/// activity" and trigger an unwanted wiggle on the next call.
pub fn reset_for_test() {
    *LAST_EMIT_MS.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // The clock is a process-global static, so tests that touch it must
    // not interleave with each other — serialize via a dedicated lock
    // rather than relying on cargo test's (non-guaranteed) ordering.
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    #[test]
    fn starts_unset() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_for_test();
        assert_eq!(last_emit_ms(), None);
    }

    #[test]
    fn record_emit_stamps_a_recent_timestamp() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_for_test();
        let before = now_ms();
        record_emit();
        let stamped = last_emit_ms().expect("record_emit should have set a timestamp");
        assert!(stamped >= before);
        assert!(stamped - before < 1000); // sanity: not stale, not from the future
    }

    #[test]
    fn reset_for_test_clears_back_to_unset() {
        let _guard = TEST_LOCK.lock().unwrap();
        record_emit();
        reset_for_test();
        assert_eq!(last_emit_ms(), None);
    }
}
