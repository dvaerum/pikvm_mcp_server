//! Shared iPad key-recovery sequences.
//!
//! Faithful port of `src/pikvm/ipad-keys.ts`.
//!
//! F7 (Round 2 Phase 4, TS history): the Phase-217 unlock triad and
//! Phase-231 defensive pair were duplicated verbatim in two places —
//! ipad-unlock.ts's own `unlockIpad`/`ipadGoHome` call sites, and
//! cursor-anchor.ts's `key-sequence-retry`/`defensive-keys` recovery kinds —
//! with the tuned-constant rationale living on only one of the two copies
//! each time. Extracted here rather than into either consuming module: the
//! same "pure mechanism, no policy about when to call these" role the TS
//! file documents.
//!
//! `send_key` is narrowed to exactly what these two sequences need (a bare
//! key press, no down/up `state` split) — other module 5 files that need
//! `sendKey`'s state-param form define their own closure shape, matching
//! this codebase's own per-file `Pick<PiKVMClient, ...>` convention rather
//! than a premature monolithic client trait.

use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `Fn(key_name) -> Future<Output = ()>` — a bare key press, no down/up split.
pub type SendKeyFn<'a> =
    &'a (dyn Fn(&'static str) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync);
/// `Fn(millis) -> Future<Output = ()>`.
pub type SleepFn<'a> = &'a (dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync);

/// Esc → Enter → Space, the Phase-217 (v0.5.x) iPad unlock/dismiss key
/// sequence:
///
/// - Escape closes any Control Center/Notification overlay a prior failed
///   gesture may have left open.
/// - Enter is the actual unlock key on iPadOS 26 lock screens.
/// - Space was the working unlock key on older iPadOS revisions and is
///   kept as a fallback for targets on an older OS.
///
/// The pacing (200ms / 600ms / 400ms) is empirically tuned, not arbitrary —
/// don't compress it without re-verifying live. Callers decide what to do
/// on failure (this function doesn't swallow errors — that's caller-specific
/// fallthrough logic, e.g. unlockIpad falling through to the swipe-based
/// unlock).
pub async fn ipad_unlock_key_sequence(
    send_key: SendKeyFn<'_>,
    sleep: SleepFn<'_>,
) -> anyhow::Result<()> {
    send_key("Escape").await?;
    sleep(200).await;
    send_key("Enter").await?;
    sleep(600).await;
    send_key("Space").await?;
    sleep(400).await;
    Ok(())
}

/// Esc → Enter, the Phase-231 (v0.5.207) defensive belt-and-suspenders
/// pair: a swipe-up gesture sometimes re-locks an already-unlocked iPad
/// (live-verified 2026-05-10) — the same hazard Phase 219 fixed for
/// unlockIpad's own swipe path. Esc + Enter is a no-op on an already-home
/// screen but unlocks again if the swipe accidentally re-locked. Cheap
/// (~800ms), no re-attempt of whatever triggered it — the caller inspects
/// its own returned screenshot to judge whether it worked.
///
/// Pacing (200ms / 600ms) is the same tuned rationale as
/// [`ipad_unlock_key_sequence`] minus the Space fallback (this pair runs
/// post-swipe, not pre-unlock, so the older-iPadOS Space fallback doesn't
/// apply here).
pub async fn ipad_defensive_keys(
    send_key: SendKeyFn<'_>,
    sleep: SleepFn<'_>,
) -> anyhow::Result<()> {
    send_key("Escape").await?;
    sleep(200).await;
    send_key("Enter").await?;
    sleep(600).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    struct Recorder {
        keys: Arc<std::sync::Mutex<Vec<&'static str>>>,
        sleeps: Arc<std::sync::Mutex<Vec<u64>>>,
        total_sleep_ms: Arc<AtomicU64>,
    }

    // Test-only helper; the verbose closure-tuple return type is inherent to
    // returning two distinct `impl Fn` closures together, not a real
    // complexity smell worth restructuring for.
    #[allow(clippy::type_complexity)]
    fn recorder() -> (
        Recorder,
        impl Fn(&'static str) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync,
        impl Fn(u64) -> BoxFuture<'static, ()> + Send + Sync,
    ) {
        let keys = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sleeps = Arc::new(std::sync::Mutex::new(Vec::new()));
        let total_sleep_ms = Arc::new(AtomicU64::new(0));

        let keys_for_fn = keys.clone();
        let send_key = move |k: &'static str| {
            keys_for_fn.lock().unwrap().push(k);
            Box::pin(async { Ok(()) }) as BoxFuture<'static, anyhow::Result<()>>
        };

        let sleeps_for_fn = sleeps.clone();
        let total_for_fn = total_sleep_ms.clone();
        let sleep = move |ms: u64| {
            sleeps_for_fn.lock().unwrap().push(ms);
            total_for_fn.fetch_add(ms, Ordering::SeqCst);
            Box::pin(async {}) as BoxFuture<'static, ()>
        };

        (
            Recorder {
                keys,
                sleeps,
                total_sleep_ms,
            },
            send_key,
            sleep,
        )
    }

    #[tokio::test]
    async fn ipad_unlock_key_sequence_sends_escape_enter_space_with_tuned_pacing() {
        let (rec, send_key, sleep) = recorder();
        ipad_unlock_key_sequence(&send_key, &sleep).await.unwrap();
        assert_eq!(*rec.keys.lock().unwrap(), vec!["Escape", "Enter", "Space"]);
        assert_eq!(*rec.sleeps.lock().unwrap(), vec![200, 600, 400]);
        assert_eq!(rec.total_sleep_ms.load(Ordering::SeqCst), 1200);
    }

    #[tokio::test]
    async fn ipad_defensive_keys_sends_escape_enter_only_no_space() {
        let (rec, send_key, sleep) = recorder();
        ipad_defensive_keys(&send_key, &sleep).await.unwrap();
        assert_eq!(*rec.keys.lock().unwrap(), vec!["Escape", "Enter"]);
        assert_eq!(*rec.sleeps.lock().unwrap(), vec![200, 600]);
    }

    #[tokio::test]
    async fn ipad_unlock_key_sequence_propagates_a_send_key_error_and_stops() {
        let keys: Arc<std::sync::Mutex<Vec<&'static str>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let keys_for_fn = keys.clone();
        let send_key = move |k: &'static str| {
            keys_for_fn.lock().unwrap().push(k);
            if k == "Enter" {
                Box::pin(async { anyhow::bail!("HID write failed") })
                    as BoxFuture<'static, anyhow::Result<()>>
            } else {
                Box::pin(async { Ok(()) })
            }
        };
        let sleep = |_ms: u64| Box::pin(async {}) as BoxFuture<'static, ()>;
        let result = ipad_unlock_key_sequence(&send_key, &sleep).await;
        assert!(result.is_err());
        // Stopped after Enter failed -- Space was never sent.
        assert_eq!(*keys.lock().unwrap(), vec!["Escape", "Enter"]);
    }
}
