//! `StreamerKeepalive` itself: the reconnect/backoff state machine that
//! holds one persistent `/api/ws` connection open for the life of the
//! MCP server process.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
#[cfg(test)]
use tokio::sync::oneshot;
use tokio::sync::Mutex;

use super::connection::real_connector;
use super::types::{
    ConnectFn, StreamerKeepaliveConfig, WsSession, RECONNECT_BASE_MS, RECONNECT_MAX_MS,
};

pub struct StreamerKeepalive {
    config: StreamerKeepaliveConfig,
    connect: ConnectFn,
    connected: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    reconnect_delay_ms: Arc<AtomicU64>,
    // Guards against concurrent ensure_started() calls each starting their
    // own connection attempt — the TS original's `this.connecting` promise-
    // sharing, adapted to Rust via a lock held for the duration of one
    // attempt rather than a shared in-flight Promise reference.
    connect_lock: Arc<Mutex<()>>,
}

impl StreamerKeepalive {
    pub fn new(config: StreamerKeepaliveConfig) -> Self {
        Self::with_connector(config, real_connector())
    }

    /// Test seam — inject a fake [`ConnectFn`] instead of the real
    /// networking connector.
    pub fn with_connector(config: StreamerKeepaliveConfig, connect: ConnectFn) -> Self {
        Self {
            config,
            connect,
            connected: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            reconnect_delay_ms: Arc::new(AtomicU64::new(RECONNECT_BASE_MS)),
            connect_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Idempotent: a no-op if already connected or stopped. Concurrent
    /// callers during a cold start serialize on `connect_lock` rather than
    /// each opening their own socket — behaviorally equivalent to the TS
    /// shared-in-flight-Promise approach (no caller returns before a
    /// connection attempt that was already started completes), even though
    /// the mechanism differs. Never returns an error — best-effort
    /// contract, matching the TS `ensureStarted()` doc.
    pub async fn ensure_started(&self) {
        if self.stopped.load(Ordering::SeqCst) || self.connected() {
            return;
        }
        let _guard = self.connect_lock.lock().await;
        // Re-check after acquiring the lock — another caller may have
        // already completed a connection attempt while this one waited.
        if self.stopped.load(Ordering::SeqCst) || self.connected() {
            return;
        }
        self.connect_once().await;
    }

    async fn connect_once(&self) {
        match (self.connect)(self.config.clone()).await {
            Ok(session) => {
                self.connected.store(true, Ordering::SeqCst);
                self.reconnect_delay_ms
                    .store(RECONNECT_BASE_MS, Ordering::SeqCst); // reset backoff on success
                self.spawn_close_watcher(session);
            }
            Err(()) => {
                self.schedule_reconnect();
            }
        }
    }

    /// Spawns a background task that waits for the session to close, then
    /// updates state and schedules a reconnect — the async equivalent of
    /// the TS `ws.once('close', ...)` handler.
    fn spawn_close_watcher(&self, session: WsSession) {
        let connected = self.connected.clone();
        let stopped = self.stopped.clone();
        let reconnect_delay_ms = self.reconnect_delay_ms.clone();
        let connect = self.connect.clone();
        let config = self.config.clone();
        let connect_lock = self.connect_lock.clone();
        tokio::spawn(async move {
            session.wait_closed().await;
            connected.store(false, Ordering::SeqCst);
            if stopped.load(Ordering::SeqCst) {
                return;
            }
            schedule_reconnect_task(
                connected,
                stopped,
                reconnect_delay_ms,
                connect,
                config,
                connect_lock,
            );
        });
    }

    fn schedule_reconnect(&self) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        schedule_reconnect_task(
            self.connected.clone(),
            self.stopped.clone(),
            self.reconnect_delay_ms.clone(),
            self.connect.clone(),
            self.config.clone(),
            self.connect_lock.clone(),
        );
    }

    /// Explicit teardown — cancels any future reconnect. Mainly for tests;
    /// a real MCP server process holds this for its full lifetime and never
    /// calls `stop()`.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.connected.store(false, Ordering::SeqCst);
    }
}

/// Free function (not a method) so it can be called from inside a spawned
/// task without borrowing `&self` past the task's lifetime. Exponential
/// backoff capped at RECONNECT_MAX_MS, faithful port of `scheduleReconnect`.
fn schedule_reconnect_task(
    connected: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    reconnect_delay_ms: Arc<AtomicU64>,
    connect: ConnectFn,
    config: StreamerKeepaliveConfig,
    connect_lock: Arc<Mutex<()>>,
) {
    let delay = reconnect_delay_ms.load(Ordering::SeqCst);
    reconnect_delay_ms.store((delay * 2).min(RECONNECT_MAX_MS), Ordering::SeqCst);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if stopped.load(Ordering::SeqCst) {
            return;
        }
        let guard = connect_lock.lock().await;
        if stopped.load(Ordering::SeqCst) || connected.load(Ordering::SeqCst) {
            return;
        }
        let result = connect(config.clone()).await;
        // Release the lock before scheduling any further work below — the
        // guard only needs to serialize concurrent connection ATTEMPTS
        // (the check-then-connect above), not the bookkeeping that follows.
        // Held past this point, it would alias `connect_lock` in the very
        // same scope this async block later needs to MOVE it into a
        // recursive schedule_reconnect_task call (the Err arm below).
        drop(guard);
        match result {
            Ok(session) => {
                connected.store(true, Ordering::SeqCst);
                reconnect_delay_ms.store(RECONNECT_BASE_MS, Ordering::SeqCst);
                let connected2 = connected.clone();
                let stopped2 = stopped.clone();
                let reconnect_delay_ms2 = reconnect_delay_ms.clone();
                let connect2 = connect.clone();
                let config2 = config.clone();
                let connect_lock2 = connect_lock.clone();
                tokio::spawn(async move {
                    session.wait_closed().await;
                    connected2.store(false, Ordering::SeqCst);
                    if stopped2.load(Ordering::SeqCst) {
                        return;
                    }
                    schedule_reconnect_task(
                        connected2,
                        stopped2,
                        reconnect_delay_ms2,
                        connect2,
                        config2,
                        connect_lock2,
                    );
                });
            }
            Err(()) => {
                schedule_reconnect_task(
                    connected,
                    stopped,
                    reconnect_delay_ms,
                    connect,
                    config,
                    connect_lock,
                );
            }
        }
    });
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    fn config() -> StreamerKeepaliveConfig {
        StreamerKeepaliveConfig {
            host: "https://192.168.1.50".into(),
            username: "admin".into(),
            password: "pw".into(),
            verify_ssl: false,
            proxy_url: None,
        }
    }

    type Closers = Arc<Mutex<Vec<oneshot::Sender<()>>>>;

    /// A fake connector whose sessions are closed by the TEST, not by real
    /// networking — the async equivalent of the TS `FakeSocket` DI seam.
    fn fake_connector_always_succeeds() -> (ConnectFn, Arc<AtomicU32>, Closers) {
        let calls = Arc::new(AtomicU32::new(0));
        let closers: Arc<Mutex<Vec<oneshot::Sender<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_c = calls.clone();
        let closers_c = closers.clone();
        let connect: ConnectFn = Arc::new(move |_config| {
            let calls = calls_c.clone();
            let closers = closers_c.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                let (tx, rx) = oneshot::channel();
                closers.lock().await.push(tx);
                Ok(WsSession { closed: rx })
            })
        });
        (connect, calls, closers)
    }

    fn fake_connector_always_fails() -> (ConnectFn, Arc<AtomicU32>) {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let connect: ConnectFn = Arc::new(move |_config| {
            let calls = calls_c.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(())
            })
        });
        (connect, calls)
    }

    #[tokio::test]
    async fn ensure_started_connects_and_reports_connected() {
        let (connect, calls, _closers) = fake_connector_always_succeeds();
        let ka = StreamerKeepalive::with_connector(config(), connect);

        ka.ensure_started().await;

        assert!(ka.connected());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ensure_started_is_idempotent_while_already_connected() {
        let (connect, calls, _closers) = fake_connector_always_succeeds();
        let ka = StreamerKeepalive::with_connector(config(), connect);

        ka.ensure_started().await;
        ka.ensure_started().await; // second call, already connected
        ka.ensure_started().await; // third call

        assert_eq!(calls.load(Ordering::SeqCst), 1); // only ONE real connection attempt
    }

    #[tokio::test]
    async fn concurrent_ensure_started_calls_share_one_in_flight_attempt() {
        let (connect, calls, _closers) = fake_connector_always_succeeds();
        let ka = Arc::new(StreamerKeepalive::with_connector(config(), connect));

        let ka1 = ka.clone();
        let ka2 = ka.clone();
        let ka3 = ka.clone();
        tokio::join!(
            async move { ka1.ensure_started().await },
            async move { ka2.ensure_started().await },
            async move { ka3.ensure_started().await },
        );

        assert!(ka.connected());
        assert_eq!(calls.load(Ordering::SeqCst), 1); // only one real connection attempt made
    }

    #[tokio::test]
    async fn a_connection_failure_never_panics_or_propagates_an_error() {
        let (connect, calls) = fake_connector_always_fails();
        let ka = StreamerKeepalive::with_connector(config(), connect);

        ka.ensure_started().await; // must not panic — best-effort contract

        assert!(!ka.connected());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_closed_connection_transitions_back_to_not_connected() {
        let (connect, _calls, closers) = fake_connector_always_succeeds();
        let ka = StreamerKeepalive::with_connector(config(), connect);
        ka.ensure_started().await;
        assert!(ka.connected());

        // Simulate the connection dropping — fire the fake session's close signal.
        let closer = closers.lock().await.pop().unwrap();
        let _ = closer.send(());
        // Give the spawned close-watcher task a chance to run.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(10)).await;

        assert!(!ka.connected());
    }

    #[tokio::test]
    async fn stop_prevents_any_further_reconnect_attempts() {
        let (connect, calls, closers) = fake_connector_always_succeeds();
        let ka = StreamerKeepalive::with_connector(config(), connect);
        ka.ensure_started().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        ka.stop();
        assert!(!ka.connected());

        // Even after stop(), calling ensure_started() again must be a no-op.
        ka.ensure_started().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1); // no new attempt

        // Drop the pending closer without firing it — stop() already marked
        // this keepalive terminal, so a late close signal (if it ever fired)
        // must not resurrect a reconnect either. Not exercised further here
        // since reconnect timing is covered by the dedicated backoff test
        // below with a controlled clock instead of a real sleep.
        drop(closers);
    }

    #[tokio::test(start_paused = true)]
    async fn reconnects_with_backoff_after_a_connection_failure() {
        let (connect, calls) = fake_connector_always_fails();
        let ka = StreamerKeepalive::with_connector(config(), connect);

        ka.ensure_started().await; // first attempt fails, schedules a reconnect
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Let the just-spawned reconnect task run up to its `sleep().await`
        // (registering the timer) before advancing the paused clock — a
        // freshly `tokio::spawn`'d task hasn't been polled yet at the point
        // `ensure_started()` returns, and `time::advance()` only affects
        // timers that are already registered.
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_millis(RECONNECT_BASE_MS - 1)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1); // not yet — one ms short

        tokio::time::advance(Duration::from_millis(2)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2); // reconnect fired
    }
}
