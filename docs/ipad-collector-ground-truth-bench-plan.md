# Plan: paired iPadCollector ground-truth bench (Rust port)

## RESULTS (2026-08-29, run live per manager's standing authorization)

**FINAL STATUS: N=20 COMPLETED SUCCESSFULLY — category 1
(task_37374b4bce6d) is done.** This section records the full arc: the
initial 0/20 run below, the architectural fix
(docs/ipad-collector-showscene-redesign-plan.md), a second real ordering
bug that fix's own first live attempt surfaced, and the final successful
run. Full final-run detail lives in the redesign plan doc's own RESULTS
section (not duplicated here) — summary: 20/20 trials, zero reconnects,
zero missing-ground-truth trials, 19/20 within the 5.9px tolerance, 1/20
marginally over (6.245px, noise-floor territory) confirmed visually as a
real, close, correct landing.

**Initial run, preserved for the record (below): RUN LIVE, 0/20 trials
completed** — NOT the bench's own success criteria, but real, valuable
findings: 2 real protocol bugs found+fixed (confirmed working end-to-end
via an isolated probe), plus a genuine architectural gap that blocked the
full N=20 run and needed a redesign + review before retrying, not a
quick patch.

### Bugs found and fixed in `rust/mover/src/ipad_collector.rs`

Both found via live, reproducible failures against the real app — not
guessed, not caught in offline review:

1. **`sessionId` (hello-ack) must be a real UUID-v4-shaped string.** The
   original `"rust-bench"` label made the app close the connection
   (broken pipe on the next write) almost immediately after hello-ack —
   consistent with a Swift-side `UUID` decode failing on a non-UUID
   string. Fixed with a hand-rolled UUID-v4 formatter (no new `uuid`
   dependency — only the wire SHAPE matters, not real uniqueness).
2. **The real root cause: every frame's `id` was a bare JSON number, not
   a string.** `ipad-app-ws.ts`'s reference protocol always uses
   `randomUUID()` (a string) for ids. An isolated probe (connect ->
   `get-cursor` immediately, before touching go-home/click-at) showed a
   clean 5s timeout with zero reply once (1) was fixed — consistent with
   the app silently dropping any frame it can't decode. Fixed by making
   `id` a `String` on the wire everywhere (kept the cheap internal `u64`
   counter, just stringified — only the wire TYPE needed to change).
3. **Bonus bug caught by the same probe once (1)+(2) were fixed**:
   `CursorPos.t_ipad` was typed `u64`; the real app sends a fractional-
   millisecond timestamp (`Date().timeIntervalSince1970 * 1000`-style),
   which failed to deserialize into an integer type. TS's own `t_ipad:
   number` was always a double — the `u64` was an unchecked assumption.
   Fixed to `f64`; would have silently broken EVERY real reading had the
   bench gotten this far without it.

All three confirmed fixed via `ipad_collector_ws_probe.rs` (new, small
diagnostic example, committed): connect -> `get_cursor()` immediately ->
clean `CursorPos { x: 0.0, y: 0.0, t_ipad: <real epoch ms>, tracked:
Some(false) }` — a real, correctly-decoded "not tracked yet" reading
(PointerTracker hadn't fired a hover yet), not an error.

### The remaining architectural gap (why the full N=20 run still didn't complete)

With all 3 bugs fixed, the FULL bench (`ipad_go_home` -> `click_at` ->
`get_tracked_cursor`) reproduced the EXACT SAME broken-pipe failure on
trial 1, unchanged. Root cause: `ipad_go_home` sends `Cmd+H` (backgrounds
iPadCollector) before every trial's `click_at`, so the app is not
foreground by the time `get_tracked_cursor` finally runs, several
seconds later. iOS almost certainly suspends the app's WebSocket shortly
after backgrounding (this app has no background-networking entitlement)
— confirmed live: the isolated probe (app stays foreground throughout,
no go-home/click-at in between) succeeds cleanly every time; the full
per-trial sequence (which backgrounds the app first) fails every time.

This is a genuine design mismatch, not a bug in the WS server code: this
bench's design assumed iPadCollector could provide ground truth for
clicks against the REAL home screen while backgrounded, but the app's
WS session cannot survive being backgrounded at all. iPadCollector's own
established historical usage (`bench-collect-synthetic.ts`,
`bench-collect-trajectory.ts`) keeps the app foreground THE WHOLE TIME
and renders its own synthetic `showScene` as the click surface — this
bench deliberately chose the real-home-screen approach instead (to catch
"the mover's self-report and its own diff both agree but are both wrong"
against the REAL production click path, not a synthetic scene) without
flagging that this requires the app to survive backgrounding, which it
provably does not.

**Not attempting a live patch for this today** — per this project's own
"best practice, not quick hacks" standing rule, a real fix here (most
likely: switch to iPadCollector's own `showScene` as the click target so
the app never leaves the foreground, at the cost of no longer testing
against the literal production home screen) is a genuine design change
that needs its own write-up and nixos-dev review, same as every other
design decision this session, before more live iPad time gets spent on
retries that will keep reproducing the same failure. Filing this as a
new follow-up item; task_37374b4bce6d stays open (not completed) pending
that redesign.

---

**Status: DRAFT, for review by pikvm-mcp-server@nixos-developer-system before
any implementation.** Not started, not run live today (task_37374b4bce6d).

## Why this exists

Follow-up to the N=80 click-bench (`click_at_n80_bench.rs`, PASSED 80/80,
`docs/rust-port-plan.md` §8 item 8). That bench's `verified` signal is
`click_at`'s OWN pre/post-click screenshot diff — the real production
signal `pikvm_mouse_click_at` gives a caller, but not an INDEPENDENT
ground-truth source. It can't catch "the mover's self-report and the diff
both agree but both are wrong" — the exact class of bug
`legacy_move_smoke.rs` caught by screenshot cross-check this same session
(claimed landing was on dock icons; the real cursor, confirmed visually,
was elsewhere). iPadCollector's `getCursor`/`onTapEvent` are the
project's own established independent ground truth for exactly this
reason (used for the TS mover's original validation numbers cited in
CLAUDE.md — median 9.1px vs 72.9px, N=80).

## What iPadCollector actually is (verified against real source, not assumed)

Read `src/pikvm/ipad-app-ws.ts` in full (439 lines) rather than working
from the earlier "minimal client" assumption. Key facts:

- **It's a WebSocket SERVER this process must host** — `startIpadAppServer
  ({port, onSession})` binds a `WebSocketServer` (via the `ws` npm
  package) and the iPadCollector APP running on the physical iPad
  connects IN as the client. This is inverted from a naive
  "minimal getCursor client" mental model.
- Real port: **8767** (confirmed in `scripts/diag-move-to-on-synth.ts`
  and matches this session's own memory of the port).
- Protocol (verbatim from the file's own header comment): app→collector
  messages are `hello`, `ack`, `cursor`, `cursor-event`, `time-pong`,
  `tap-event`, `lifecycle`, `error`; collector→app messages are
  `hello-ack`, `show-scene`, `get-cursor`, `subscribe-cursor`,
  `unsubscribe-cursor`, `set-effect`, `set-overlay`, `time-ping`, `ping`.
  Each frame is one JSON object; request/response pairs correlate via a
  `id` field the collector generates and the app echoes back (`ack`/
  `cursor`/`time-pong` responses reference it via `.ref` or `.id`).
- Handshake: server waits for the app's `hello` (payload: `logicalW`,
  `logicalH`, `model`) for up to 10s before handing the session to the
  caller; drops the connection if no `hello` arrives in that window.
- The ONE RPC this task's scope actually needs: `getCursor()` — sends
  `{type:'get-cursor', id, payload:{}}`, waits (5s timeout) for the
  correlated `cursor` response, returns `{x, y, t_ipad, tracked?}`.
  `getTrackedCursor()` (a thin wrapper already in the TS source) folds in
  the "is this reading real" decision: `tracked:false` → `null`,
  `tracked:undefined` (legacy) + `(0,0)` sentinel → `null`, otherwise the
  real reading. **Reuse this exact decision rule** in the Rust port —
  don't re-derive it, it already absorbs a documented legacy-vs-modern
  client quirk.
- Explicitly OUT of this task's scope (per its own description): `show-
  scene` (scene rendering for synthetic benches), `tap-event`/`lifecycle`
  subscriptions, `subscribe-cursor`/streaming — none of these are needed
  to pair a click landing against ground truth on the REAL home screen,
  only `hello` (handshake) + `get-cursor` (the one-shot ground-truth read).

## Minimal Rust WS server design

**No new crate dependency**: `tokio-tungstenite` is already a workspace
dependency (`rust/kvmd-client/Cargo.toml`, used client-side today for the
kvmd streamer WS connection). It supports server-side accept
(`tokio_tungstenite::accept_async` over a `tokio::net::TcpListener`) with
the exact same crate — satisfies the "library-first, no hand-rolling
wire protocol" ground rule (`docs/rust-port-plan.md` §6) without adding
anything new to the dependency graph.

Proposed shape, new module (crate TBD — likely `mover` alongside the
other live-bench-only examples, since this is bench/example
infrastructure, not a production tool):

```rust
pub struct IpadCollectorSession {
    // holds the accepted WebSocketStream, a pending-request map keyed by
    // generated request id (mirrors TS's `Map<string, PendingRequest>`),
    // and the parsed `hello` payload once received.
}

pub struct IpadCollectorHello {
    pub logical_w: f64,
    pub logical_h: f64,
    pub model: String,
}

pub struct CursorPos {
    pub x: f64,
    pub y: f64,
    pub t_ipad: u64,
    pub tracked: Option<bool>,
}

impl IpadCollectorSession {
    pub async fn get_cursor(&mut self) -> anyhow::Result<CursorPos> { ... }
    pub async fn get_tracked_cursor(&mut self) -> anyhow::Result<Option<CursorPos>> {
        // same decision rule as TS: tracked:false -> None;
        // tracked:None && x==0.0 && y==0.0 -> None; else Some(reading)
    }
}

pub async fn wait_for_ipad_collector_session(
    port: u16,
    timeout: Duration,
) -> anyhow::Result<IpadCollectorSession> {
    // bind a TcpListener, accept_async the first connection, read frames
    // until `hello` arrives (or timeout), return the session
}
```

Faithful-port framing: this is genuinely "not a TS port" for the
transport plumbing (TS uses the `ws` npm package + callback-style
`onSession`; Rust uses `tokio-tungstenite` + a request/response
`async fn`), but the WIRE PROTOCOL (message shapes, field names,
`get-cursor`/`cursor` request-response pairing via `id`) must match
`ipad-app-ws.ts` byte-for-byte — the real iPadCollector app binary is
the other end and won't be recompiled for this port.

## App relaunch dance

Confirmed real, previously-used command pattern (`docs/roadmap-2026-05-
31.md`, `docs/movement-accuracy-plan.md`):

```
xcrun devicectl device process launch --terminate-existing \
  --device <UDID> com.bb.iPadCollector
```

The device UDID has changed hardware/history across this project's
timeline — **do not hardcode a UDID into new code from an old doc
without confirming it live first** (`docs/movement-accuracy-plan.md`'s
own cited UDID may be stale). Confirm the current UDID via
`xcrun devicectl list devices` at implementation time, not from this
plan.

**Known real risk, already documented** (`docs/roadmap-2026-05-
31.md:690`): repeated `devicectl launch --terminate-existing` cycles in
one session have previously left the iPad's USB HID/pointer-tracking
state degraded (PointerTracker never firing `.onContinuousHover`,
`getCursor` stuck reporting `(0,0)`/`tracked:false`). Mitigation:
relaunch ONCE per bench run, not per-trial; if `getTrackedCursor()`
returns `None` after a reasonable nudge-and-retry (the TS source's own
`awaitPointerAlive` helper already implements this: nudge callback +
poll, default 8 attempts), treat that as a real, reportable finding —
not silently retry relaunching, which is exactly the pattern that
degraded state before.

## Pairing click landings against ground truth

Sequence per trial (mirrors `click_at_n80_bench.rs`'s existing trial
loop, adds the ground-truth read):

1. `ipad_go_home` (existing, safe, already-proven primitive).
2. Call `click_at()` (the real production function, same as the N=80
   bench) with `verify_click: true` as before.
3. **New**: immediately after, call `get_tracked_cursor()` against the
   held iPadCollector session. Convert its logical-pixel reading to HDMI
   pixels using the SAME iPad-bounds detection this port already has
   (`orientation.rs`'s `detect_ipad_bounds_from_buffer` /
   `ipad_content_region_from_buffer` — logical→HDMI scaling is exactly
   what those functions' callers already do elsewhere, e.g.
   `slam_origin_from_bounds`/`unlock_start_from_bounds`'s own coordinate
   mapping convention). **Cache-freshness requirement (nixos-dev's
   review, sourced from today's own `calibrate_crop_tolerance.rs`
   cache-staleness bug — a later frame silently inheriting an EARLIER
   frame's cached bounds because nothing cleared it between
   measurements)**: do NOT trust whatever bounds happen to be cached
   from `click_at()`'s own internal screenshot/detection cycle a moment
   earlier. Call `clear_orientation_cache()` and take a FRESH screenshot
   specifically for this mapping step before computing bounds for each
   trial's ground-truth read. It would be a real irony for the
   ground-truth side of this exact comparison to carry the same class of
   staleness bug this bench exists to catch on `click_at`'s side.
4. Record: target, `click_at`'s own self-reported final position (its
   existing screenshot-diff-based `verified`), AND iPadCollector's
   independent HDMI-mapped reading. Three numbers, not two — the whole
   point of this bench is comparing #2 (the port's own claim) against #3
   (independent truth), not just re-confirming #2 against itself.
5. Flag any trial where `click_at` reports `verified:true` (or a small
   residual) but iPadCollector's ground truth disagrees beyond a real
   tolerance (needs an actual number — start from the already-established
   detected→tap bias measurement, 5.9px, as the noise floor, not a
   guessed threshold) — THIS is the specific bug class this bench exists
   to catch, and it's exactly what the click-bench alone structurally
   cannot.

## Mid-bench WS disconnect policy (nixos-dev's review — was unaddressed)

Across N≥20 trials on real hardware, the iPadCollector app can plausibly
background or drop the WS connection mid-run (network blip, iPadOS
backgrounding it, etc.) — the pseudocode above didn't state a policy for
this, which risks it being decided live under time pressure when it
actually happens. Stated policy: on a detected disconnect (the session's
`connected` check going false, or a `get_cursor`/`get_tracked_cursor`
call erroring with a closed-socket error), attempt **exactly one**
reconnect (wait for a new `hello` on the same port, same 10s handoff
window the server already uses) before giving up. Any trial whose
ground-truth read spans a reconnect (i.e., the reconnect happened between
that trial's `click_at()` call and its `get_tracked_cursor()` call) gets
explicitly FLAGGED in the recorded results as "spans reconnect" rather
than silently trusted — a reading taken right after a fresh reconnect
carries its own uncertainty (clock re-sync not yet done, `hello`'s
logical dimensions not yet re-confirmed) that a mid-steady-state reading
doesn't. If the one reconnect attempt also fails, abort the whole bench
run rather than continuing with N-k stale/no-ground-truth trials silently
folded into the same result set.

## Scope and sample size

Given this project's own standing rule (no verdicts from small samples,
N≥80 for a real live A/B) but also that this is a NEW capability check
(does the port's self-report match independent truth) rather than a
fresh accuracy claim being established from scratch — recommend N≥20 as
the floor for a first real run (matching this task's own originally
negotiated minimum, `task_9bb80e84c948`), escalating to N≥80 only if the
first N≥20 pass shows any disagreement worth characterizing more
precisely. Every trial's three-way comparison gets logged structurally
(not just a pass/fail count), and any disagreeing trial gets its
screenshot saved for visual inspection — same discipline as every other
live gate this session.

## What this does and doesn't prove

Proves: the Rust port's click_at/move_to self-report agrees with
INDEPENDENT ground truth on real hardware, closing the specific gap the
N=80 bench (self-report vs its own diff) structurally cannot close.

Does not prove: anything about the legacy correction-loop path (separate
scope, tracked as `task_4b034fc4e018`/the wouldRejectAsStationary plan);
does not replace the N=80 bench (this is a smaller-N, deeper-signal
complement, not a superset).

## What I'm asking nixos-dev to review

1. Is `tokio-tungstenite`'s server-side accept API (vs. a lighter-weight
   alternative) the right choice, or is there a reason to prefer
   something else given this is bench-only infrastructure, not a
   production server?
2. Does the proposed `IpadCollectorSession`/`get_tracked_cursor` shape
   match the established DI/testability conventions this port already
   uses elsewhere (e.g. should this be behind a trait for offline
   testing, matching `CursorLocatorDeps`/`ClickAtDeps`'s pattern), or is
   a live-only bench tool (like `click_at_n80_bench.rs` itself) exempt
   from that convention since it has no offline unit-test surface to
   begin with?
3. Any concern with the logical→HDMI coordinate mapping reusing
   `orientation.rs`'s existing bounds-detection machinery, or should
   ground-truth mapping use a separately-calibrated conversion?
4. The relaunch-degradation risk above — is there a better mitigation
   than "relaunch once per run, treat post-relaunch tracking failure as
   a reportable finding, not a retry trigger"?
