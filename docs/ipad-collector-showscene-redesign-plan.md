# Plan: iPadCollector bench redesign — click against `showScene`, not the real home screen

**Status: IMPLEMENTED (2026-08-29)** — `show-scene`/`ack` + `error`
handling added to `ipad_collector.rs` (8 new unit tests, all passing),
`ipad_collector_ground_truth_bench.rs` updated to send the health-check
screenshot as a one-time scene instead of calling `ipad_go_home()` per
trial. 345/345 mover tests, workspace clippy `-D warnings` clean, fmt
clean. **NOT run live yet** — code-complete and offline-tested only,
deferring live execution per today's accumulated live-hardware volume
(own judgment call, per the standing authorization). Follow-up to
`docs/ipad-collector-ground-truth-bench-plan.md`'s RESULTS section
(2026-08-29) — that doc's own protocol-bug fixes (sessionId format, `id`
as a wire string, `t_ipad` as `f64`) all stand and are NOT touched here;
this plan only addresses the architectural gap that fix didn't close.

## The gap this closes

The current bench (`ipad_collector_ground_truth_bench.rs`) calls
`ipad_go_home()` (`Cmd+H` + slam+swipe) before every trial's `click_at`,
which backgrounds iPadCollector. Confirmed live: the app's WS session
does not survive being backgrounded (an isolated foreground-only probe
succeeds every time; the full per-trial sequence, which backgrounds the
app first, fails every time with a broken pipe on the very next
`get_tracked_cursor` call). This is a genuine design mismatch, not a
protocol bug — the bench's plan assumed ground truth could be pulled
from a backgrounded app while clicking the real home screen underneath
it; the app can't do that.

## The fix: click against the app's own rendered scene instead

`ipad-app-ws.ts`'s reference protocol already has a `show-scene` message
(`SceneSpec`, kind=`image`, a base64-encoded JPEG/PNG) — this is how
this project's OWN established historical usage
(`bench-collect-synthetic.ts`, `bench-collect-trajectory.ts`) already
gets a "realistic detector surface + ground truth together" without ever
backgrounding the app: render a real screenshot of the home screen
*inside* iPadCollector's own view, and interact with THAT instead of the
literal home screen underneath. iPadCollector stays foreground for the
entire bench run — its WS session never dies.

### What changes, concretely

1. **`ipad_collector.rs`**: add `show-scene` to the (currently
   deliberately narrow, `hello`+`get-cursor` only) scope. New outgoing
   message: `{type: "show-scene", id: "<n>", payload: {kind: "image",
   image: "<base64>"}}`, sent via the same `request<T>`-style
   pattern already used for `get-cursor` (this module's `get_cursor()`
   is the template — same pending-map/oneshot-correlation approach).
   Per the reference implementation, the app's own reply is a generic
   `ack` (`{type: "ack", payload: {ref: "<id>"}}`), not an echoed
   `show-scene` — the correlation switch needs a case for `ack` keyed
   by `payload.ref`, distinct from `cursor` keyed by the top-level `id`
   (see `ipad-app-ws.ts`'s own `onMessage` switch for the exact
   distinction — `ack`/`cursor` are correlated differently). This is
   new wire-protocol surface, not a tweak to existing code.
2. **The bench harness**: replace the per-trial `ipad_go_home()` call
   with a ONE-TIME setup step: capture a real screenshot of the actual
   home screen (the existing pre-flight health-check screenshot can
   likely be reused directly — same image, already taken), convert it
   to the base64 payload `show-scene` needs, and send it once,
   immediately after the `hello`/`hello-ack` handshake, before any
   trials run. No per-trial backgrounding, no per-trial re-sending —
   the scene stays static for all N=20 trials, matching the original
   plan's "20 trials against the real, stable home screen" framing as
   closely as possible while never leaving the app foreground.
3. **What `click_at` actually clicks**: the same target pixel
   coordinates as before (the Settings icon's established location),
   now landing on a STATIC IMAGE of that icon rather than the live,
   interactive icon. This is a real, honest trade-off to flag plainly:
   the bench no longer proves anything about the REAL home screen's tap
   responsiveness or app-launch behavior — only about detection/landing
   ACCURACY (comparing `click_at`'s own self-reported landing position
   against iPadCollector's independent `getTrackedCursor()` ground
   truth), which is what category 1's own sign-off criterion actually
   asks for (a paired ground-truth bench for MOVER correctness, not an
   app-interaction test). `click_at`'s own post-click verify-diff
   should still work fine against a static image (cursor movement is
   still real, visible pixel change), but any UI-specific feedback
   (icon press animation, app actually launching) obviously won't
   appear — flag this so `click_at`'s own `verified` field is read as
   "cursor visibly there," not "the icon was actually pressed."
4. **Cache-freshness requirement carries over unchanged**: the
   logical→HDMI mapping step still needs `clear_orientation_cache()` +
   a fresh screenshot before each trial's `getTrackedCursor()` reading,
   exactly as the original plan's review already established — nothing
   about the backgrounding fix changes that requirement.
5. **WS-disconnect policy carries over unchanged**: one reconnect
   attempt, abort on a second consecutive failure — if the app
   disconnects for some OTHER reason now (network blip, app crash),
   that's still a real failure worth surfacing, not something this
   redesign should paper over.

### What this does NOT fix / known limitation to state plainly

This redesign trades "tests the literal production home screen" for
"the app never leaves foreground." That's the right trade for category
1's actual sign-off bar (mover/detection correctness against independent
ground truth), but it means this bench can no longer also serve as an
implicit regression check on `ipad_go_home`/real-app-interaction
behavior — those are already covered elsewhere (`click_at_n80_bench.rs`
already validates the real production click path against the real home
screen, just without independent ground truth). Worth stating in the
bench's own header comment so a future reader doesn't assume this bench
covers both.

## Scope check: is this still a small, additive change?

Real new work, not a quick patch — same honest framing as the
backgrounding gap itself: a new outgoing message type + `ack`/`error`
correlation cases in `ipad_collector.rs` (both keyed by `payload.ref`,
distinct from `cursor`/`time-pong`'s top-level `id`), the `base64` crate
(new normal dependency, decided per review — small/single-purpose,
doesn't need a separate evaluation doc) for the image payload, and
removing the per-trial `ipad_go_home()` call plus the trial-count/timing
implications of that removal (trials should run FASTER now with no
per-trial Cmd+H/swipe/slam overhead — worth noting as a secondary
benefit, not the goal).

## Review (nixos-dev, incorporated below) — status: REVIEWED, ready to build

1. **Q1 (reusing the health-check screenshot)**: fine as-is — confirmed
   the bench's existing health-check call is `client.screenshot(None)`
   (no `ScreenshotOptions.max_width`/`max_height`), i.e. the RAW captured
   frame, not a downscaled preview. No change needed.
2. **Q2 (ack/ref correlation)**: confirmed exactly right against
   `src/pikvm/ipad-app-ws.ts:198-227` directly — `ack` computes `ref` from
   `payload.ref`; `cursor`/`time-pong` compute it from the top-level `id`.
   Genuinely separate branches needed, as described.
3. **Q3 (framing matches category 1's bar)**: agreed, right trade —
   category 1 is a detection/landing question (self-report vs.
   independent ground truth), `click_at_n80_bench.rs` already covers
   real-home-screen interaction without independent ground truth.
   Complementary, not overlapping.
4. **Q4 (base64 dependency)**: use the `base64` crate (small,
   single-purpose, near-zero transitive deps) rather than hand-rolling.
   Doesn't need the heavier `ort`/`axum`/`tokio-tungstenite`-style
   evaluation — those added real long-term runtime capabilities; this is
   encoding one static payload once per bench run. Decided inline, no
   separate evaluation doc.
5. **New gap nixos-dev caught, not in the original plan: the `error`
   case.** Same TS source, lines 248-259 — if the app rejects a request
   (malformed payload, etc.), it sends `{type:'error', payload:{ref,
   reason}}`, rejecting the pending promise with the real reason.
   `ipad_collector.rs`'s reader task doesn't handle `error` at all
   (explicitly out of scope in its own original comment). Without it, a
   `show-scene` failure would just report a generic 5s timeout instead of
   the app's actual rejection reason. Not launch-blocking (the existing
   `REQUEST_TIMEOUT` still fires, nothing hangs), but cheap to wire
   alongside the `ack` branch already being added — **incorporated**:
   implementation adds an `error`→reject branch alongside `ack`, not just
   `ack` alone as the original plan described.

All 5 points incorporated below / in the implementation. No open
questions remaining.
