# Plan: active liveness ping/pong for `StreamerKeepalive`

## Problem, with real evidence

Categories 2/5's guarded slam has hit the same transient 503 6 times
today (`docs/rust-port-plan.md` §13-§20,
`docs/slam-verify-screenshot-retry-plan.md`). Two retry-budget fixes
(after-only, then before matched to after's 3-attempt/1000ms budget)
each helped in some individual runs but were fully exhausted in others
— most recently, a full 3-attempt/~6.5s retry window still failed.

Diagnostic added and run live (`PiKVMClient::streamer_keepalive_connected()`,
committed `ac0370f`): `StreamerKeepalive::connected()` reported `true`
both immediately before AND after a screenshot attempt that still
503'd, on two separate live occurrences. This rules out "the keepalive
is mid-reconnect" as the explanation — it was reporting itself
connected the whole time.

**Root cause hypothesis (nixos-dev, high confidence, not yet
independently verified against real hardware)**: `StreamerKeepalive`'s
liveness check is PURELY PASSIVE. Read `real_connect`
(`rust/kvmd-client/src/streamer_keepalive/connection.rs`): after the WS
handshake, it `.split()`s the stream, keeps only the READ half, and
runs `while read.next().await.is_some() {}` — draining frames until the
stream ends, then firing the close signal. **The write half is
dropped** — this connection can never send anything after the initial
handshake, and nothing ever actively probes whether the path is still
open. During the ~30s of total silence while a human reviews the
confirmation screenshot (no traffic in either direction), an
intermediate NAT/proxy/load-balancer layer could silently drop the
connection's state without ever delivering a clean close frame back to
this side. `connected()` would then report `true` — a socket handle
that still technically exists locally — for a connection whose actual
end-to-end capability is gone. This is a well-known failure class for
idle WebSocket connections without active pings, not a stretch, and it
is consistent with every measured data point so far.

## Design

### Core idea

Send a WS-protocol `Ping` frame on the held connection at a regular
interval; require a `Pong` echo within a bounded window. If none
arrives, treat the connection as dead — fire the SAME close signal
(`close_tx`) the natural-EOF path already fires today. Every downstream
consumer of `WsSession::wait_closed()` (i.e. `StreamerKeepalive`'s
entire reconnect/backoff state machine in `keepalive.rs`) is UNCHANGED
— it already reacts correctly to a close signal, however it's
triggered. This is a minimal-blast-radius fix: only `connection.rs`'s
internals change; `keepalive.rs`'s state machine, `PiKVMClient`'s
public surface (beyond the new diagnostic accessor already shipped),
and every caller are untouched.

### Split ownership: keep the write half

`real_connect` currently does `let (_write, mut read) = ws_stream.split();`
and drops `_write` immediately. Change to keep both halves alive for
the lifetime of the read loop.

### Testable core, untested real-IO wrapper — matching this module's own established convention

`connection.rs`'s own header comment already documents the convention
this codebase uses here: real socket/TLS code is "not independently
unit-tested... covered by this crate's own hardware gate," while the
STATE MACHINE (`keepalive.rs`) is unit-tested via an injected seam
(`ConnectFn`). Extending real ping/pong I/O into `connection.rs` without
a further seam would leave the actual liveness DECISION (has too much
time passed since the last pong?) completely untested until the next
live hardware run — a worse position than today, where at least the
reconnect logic itself is unit tested.

Fix: extract the DECISION into a tiny, pure, synchronously-testable
helper — no networking, no async, just time arithmetic:

```rust
// New file: rust/kvmd-client/src/streamer_keepalive/liveness.rs

/// Pure decision: has too much time passed since the connection last
/// proved itself alive (a received Pong, or the connection's own
/// handshake if no pong has arrived yet)? No I/O — trivially unit
/// testable with plain Instant/Duration arithmetic, unlike the real
/// ping/pong loop it feeds (connection.rs, untested per this module's
/// established convention — see its own header comment).
pub(super) fn is_stale(last_proof_of_life: std::time::Instant, now: std::time::Instant, timeout: std::time::Duration) -> bool {
    now.duration_since(last_proof_of_life) > timeout
}
```

`connection.rs`'s read loop becomes (sketch, not final):

```rust
let (mut write, mut read) = ws_stream.split();
let mut last_proof_of_life = std::time::Instant::now();
let mut ping_interval = tokio::time::interval(Duration::from_millis(PING_INTERVAL_MS));
loop {
    tokio::select! {
        msg = read.next() => {
            match msg {
                Some(Ok(Message::Pong(_))) => { last_proof_of_life = std::time::Instant::now(); }
                Some(Ok(_)) => { /* any other frame also proves the path is alive */
                    last_proof_of_life = std::time::Instant::now();
                }
                Some(Err(_)) | None => break, // natural close/error, unchanged today
            }
        }
        _ = ping_interval.tick() => {
            if is_stale(last_proof_of_life, std::time::Instant::now(), Duration::from_millis(PONG_TIMEOUT_MS)) {
                break; // presumed dead — same close_tx.send(()) as a natural EOF
            }
            let _ = write.send(Message::Ping(vec![].into())).await; // best-effort; a failed send is itself evidence of death, next tick (or the read side erroring) will catch it
        }
    }
}
let _ = close_tx.send(());
```

Any inbound frame (not just `Pong`) resets `last_proof_of_life` —
kvmd may push other frame types on this WS, and any successful receive
already proves the path is alive; `Pong` isn't privileged, it's just
the frame type WE can reliably elicit on demand when nothing else is
flowing.

### Starting values — honestly uncalibrated, flagged for review

- `PING_INTERVAL_MS`: propose **5000** (5s). Well within kvmd's own
  documented ustreamer idle-stop window (~10s after the last stream
  client disconnects, per this project's existing troubleshooting
  notes) — pinging at 5s keeps this connection looking alive to kvmd
  faster than that window could ever close on it, independent of
  whether the zombie-detection ever needs to fire.
- `PONG_TIMEOUT_MS`: propose **5000** (5s) from the last proof-of-life,
  checked once per ping-interval tick — worst-case detection latency
  ~10s (one full ping interval + one timeout window) before this side
  notices a zombie connection and reconnects.
- No real measurement backs these specific numbers (same honest
  calibration-continues-from-real-data posture as every other constant
  touched today) — they're chosen to comfortably clear kvmd's own
  documented ~10s idle-stop window, which is the one real number
  available to anchor against.

## Test plan

- `is_stale` (pure function): direct unit tests — before timeout, at
  the boundary, after timeout, with an already-elapsed duration.
  Trivial, no async needed.
- `connection.rs`'s real ping/pong loop stays untested here, consistent
  with the file's own documented convention — verified against real
  hardware via a dedicated live check (see below), not a new unit-test
  seam. Extracting a further seam (fake `Stream`+`Sink`) was
  considered; deferred as disproportionate scope for this fix given the
  module's own established "real-IO untested, state-machine tested"
  line, unless review disagrees.
- `keepalive.rs`'s existing test suite (idempotency, backoff, stop())
  needs NO changes — it's driven entirely through the `ConnectFn` seam
  and never touches `connection.rs`'s internals.

### Live verification (once implemented)

A dedicated diagnostic run: hold the connection idle for the same ~30s
window the real confirmation-wait imposes, WITHOUT any screenshot
traffic, then attempt a screenshot — if the fix works, this should
either (a) never have gone stale in the first place (the periodic ping
kept it alive, from kvmd's perspective, the whole time) or (b) show a
clean, fast reconnect via the existing backoff path before the
screenshot fires. This is a good next targeted diagnostic, not the
categories-2/5 guarded slam itself — no need to risk a live slam to
validate this fix; a standalone idle-hold-then-screenshot check
exercises exactly the mechanism in question with less blast radius.

## Review (nixos-dev) — resolved, implement as reviewed

**Framing point, added per review, not a design change**: this fix
BOUNDS the zombie-connection problem, it doesn't fully eliminate 503s.
kvmd's own idle-stop timer starts from whenever the connection actually
died on ITS side, not from whenever this side detects it — in the
worst case (our ~10-15s detection+reconnect window), kvmd could still
idle-stop ustreamer before reconnection completes, so a screenshot
could still occasionally 503 even post-fix. The real, large
improvement: TODAY, once zombied, `ensure_started()`'s own
"no-op if `connected()`" check means a zombie connection can NEVER
self-heal for the rest of the process's life — every future
`ensure_started()` call sees `connected()==true` and does nothing, so
today's failure mode is effectively PERMANENT until process restart.
The fix makes it SELF-HEALING within a bounded ~10-15s window instead.
That's the real value — a rare 503 still occurring post-fix isn't the
fix failing, it's the bound working as designed.

**Also note**: `StreamerKeepalive` is core `PiKVMClient` infrastructure,
not harness-only test scaffolding — this fix affects every future real
deployment once the port ships, not just today's live-testing session.

1. **5s/5s confirmed reasonable** — anchoring against kvmd's ~10s
   window is the only real number available; comfortably clears it.
2. **Reset on ANY inbound frame confirmed** — any successful receive is
   reasonable proof of bidirectional liveness for this failure class (a
   NAT/proxy dropping the whole mapping), no reason to require the
   stricter Pong-only signal.
3. **Test scope confirmed as proposed** — matches the module's existing
   convention; the live-verification path is well-scoped and low-risk,
   not worth a fuller fake-stream seam tonight.
4. **Failed Ping send = immediate evidence of death.** Fire `close_tx`
   right on a failed `write.send()`, don't wait for the next tick's
   staleness check — a write failing is a stronger, faster signal than
   a read-side timeout. Only tightens the already-broken/write-fails-
   immediately case; the harder silent-NAT-drop case still needs the
   full timeout cycle.

## Implementation

Done, as reviewed. New `streamer_keepalive::liveness` module (`is_stale`,
pure, 5 unit tests). `connection.rs`'s `real_connect` now keeps both
split WS halves and runs `run_liveness_loop`: a periodic 5s `Ping`,
staleness checked against a 5s pong-timeout via `is_stale`, any inbound
frame (not just `Pong`) resets the liveness clock, a failed `Ping` send
is treated as immediate death (no wait for the next tick). All three
death paths (natural EOF, staleness, failed send) fire the same
`close_tx` the old passive drain loop already used — `keepalive.rs`'s
reconnect/backoff state machine is completely untouched.

Full workspace: 65/65 kvmd-client (60 existing + 5 new liveness),
350/350 mover, 966/966 total across all crates, zero failures. Clippy
`-D warnings` and fmt clean across the whole workspace.

Not yet exercised live. Per the plan's own test-plan section, the right
next live check is the low-risk idle-hold-then-screenshot diagnostic
(not risking an actual guarded slam) — holding on that until directed,
same live-hardware discipline as the rest of tonight.
