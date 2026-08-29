# Plan: paired iPadCollector ground-truth bench (Rust port)

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
   mapping convention).
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
