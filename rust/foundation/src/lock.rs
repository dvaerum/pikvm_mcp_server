//! Simple busy lock to prevent concurrent tool calls during long-running
//! operations.
//!
//! Faithful port of `src/pikvm/lock.ts`. Deliberately NOT `std::sync::Mutex`
//! or an async lock — the TS original is a plain flag with an explicit
//! `acquire`/`release` pair (a caller-visible advisory lock, not a
//! mutual-exclusion primitive guarding shared data), and the port preserves
//! that exact shape: `acquire()` panics like the original throws when
//! already held, rather than blocking.

pub struct BusyLock {
    busy: bool,
    holder: Option<String>,
}

impl BusyLock {
    pub fn new() -> Self {
        Self {
            busy: false,
            holder: None,
        }
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    pub fn holder(&self) -> Option<&str> {
        self.holder.as_deref()
    }

    /// Faithful port of `acquire(holder)`: panics if already held, matching
    /// the TS original's `throw new Error(...)`. Callers that need a
    /// non-panicking check should test `is_busy()` first (same discipline
    /// the TS call sites already follow — see index.ts's `lock.isBusy` guard
    /// before calling `acquire`).
    pub fn acquire(&mut self, holder: impl Into<String>) {
        let holder = holder.into();
        if self.busy {
            panic!(
                "Lock already held by \"{}\"",
                self.holder.as_deref().unwrap_or("")
            );
        }
        self.busy = true;
        self.holder = Some(holder);
    }

    pub fn release(&mut self) {
        self.busy = false;
        self.holder = None;
    }
}

impl Default for BusyLock {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_unheld() {
        let lock = BusyLock::new();
        assert!(!lock.is_busy());
        assert_eq!(lock.holder(), None);
    }

    #[test]
    fn acquire_marks_busy_and_records_the_holder() {
        let mut lock = BusyLock::new();
        lock.acquire("test-operation");
        assert!(lock.is_busy());
        assert_eq!(lock.holder(), Some("test-operation"));
    }

    #[test]
    #[should_panic(expected = "Lock already held by \"first\"")]
    fn acquiring_an_already_held_lock_panics_with_the_holder_name() {
        let mut lock = BusyLock::new();
        lock.acquire("first");
        lock.acquire("second"); // must panic before overwriting the holder
    }

    #[test]
    fn release_clears_busy_and_holder() {
        let mut lock = BusyLock::new();
        lock.acquire("test-operation");
        lock.release();
        assert!(!lock.is_busy());
        assert_eq!(lock.holder(), None);
    }

    #[test]
    fn release_then_acquire_again_succeeds() {
        let mut lock = BusyLock::new();
        lock.acquire("first");
        lock.release();
        lock.acquire("second"); // must not panic — lock was released
        assert_eq!(lock.holder(), Some("second"));
    }
}
