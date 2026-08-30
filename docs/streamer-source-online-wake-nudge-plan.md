# `source.online` wake-nudge fix — design (2026-08-30)

## Problem this fixes

`docs/rust-port-plan.md` §22-§26 (tonight, 2026-08-30): a live, root-caused,
repeatable bug. During any long idle window (no HID/screenshot traffic),
`streamer.source.online` flips `false` at a remarkably consistent
~10.6-10.7s, and the very next screenshot 503s. `fetch_snapshot_with_retry`'s
existing retry-once (`STREAMER_RESTART_GRACE_MS=1500ms`, added for a
DIFFERENT, narrower race — ustreamer's fork+exec+bind lag right after a
fresh WS stream client connects) does not help here, because it does not
send anything new to the device — it just waits and re-asks.

Four hypotheses were tested live and isolated cleanly (§22-§26):
- WS keepalive ping/pong staying healthy (`streamer_keepalive_connected()==true`
  throughout) — does NOT prevent or revive the flip. Real, valid fix for a
  real, separate zombie-connection bug; not this one.
- Periodic throwaway REST `/streamer/snapshot` pings during the hold — do NOT
  prevent the flip (REST-recency ruled out).
- A brand-new, fully independent `StreamerKeepalive`/WS connection to the
  same target — does NOT revive an already-flipped `source.online` (isolated
  with zero production-code changes, confirming it's not about connection
  bookkeeping at all).
- **A single wake keypress (`Space`) sent through the SAME already-stuck
  client/connection — DOES revive it**, confirmed both via `get_streamer_status()`
  and a direct follow-up screenshot succeeding.

Conclusion: the mechanism was never kvmd/ustreamer connection bookkeeping.
The iPad's own display needs a genuine redraw/refresh event during a long
idle window; nothing purely server-side substitutes for that.

## Known hazard this design must not reintroduce

A SECOND `Space` press dismisses an already-woken lock screen straight to
the Touch ID/passcode prompt (hit repeatedly this session — the entire
reason `cursor_anchor_corner_control_smoke.rs` carries a `--fallback-mouse-move`
flag as the safe alternative). A raw keypress is therefore not safe to fire
unconditionally from a generic client-layer retry path that has no idea
what UI state the device is currently in — `fetch_snapshot_with_retry`
underlies essentially every screenshot call in the whole system, including
calls made moments after this project's own lock-screen flows.

## Design

Escalate `fetch_snapshot_with_retry`'s existing two-attempt 503 handling
with a third, opt-in attempt:

1. First 503 → existing behavior unchanged: sleep `STREAMER_RESTART_GRACE_MS`,
   retry.
2. Second 503 → **new**: if `PiKVMConfig::source_online_wake_nudge` is
   `true`, send one relative mouse-move nudge via the existing, already
   belief-consistent `mouse_move_relative` (it already forward-predicts
   `CursorBelief` for the clamped emit — reusing it here costs nothing extra
   and keeps belief accurate), sleep a settle window, then retry a third
   time.
3. Still 503 (or the flag is off) → existing `StreamerUnavailable` error,
   text updated to say whether the nudge was attempted.

Mouse-move, not a keypress, is chosen deliberately: it carries none of the
same-key-twice/dismiss-to-Touch-ID hazard, and it's exactly the mechanism
`--fallback-mouse-move` already validates as safe against a genuine lock
screen. The nudge magnitude (5px) matches `--fallback-mouse-move`'s own
already-live-tested delta rather than the unrelated ±1px net-zero nudge
`screenshot_keeping_cursor_alive` uses (that one only keeps an already-awake
cursor visible in-frame; it is not attempting a display-wake event and has
never been tested for one).

**Direction is corner-aware, not a fixed `(+5,+5)`** — added after
nixos-dev's review (see below): a fixed direction isn't safe everywhere.
The call site that actually motivated this whole investigation is
`slam_to_corner`'s own "after" verification screenshot, which fires right
after the cursor has been intentionally parked AT a screen corner — and
iOS/iPadOS lock screens carry live quick-action affordances specifically in
the BOTTOM corners (flashlight bottom-left, camera bottom-right). A fixed
`(+5,+5)` nudge fired near a bottom corner could move FURTHER into it, not
away — exactly the class of incident (HID near a corner on a possibly-
locked device) this whole session has been fighting. Fixed by
`wake_nudge_toward_center`: reads the already-held `CursorBelief`'s
`position` + `bounds` and nudges 5px toward whichever half of the screen
center is on each axis — safe from any corner, not just `TopLeft`. Falls
back to the fixed `(+5,+5)` only when `bounds` is `None` (no direction to
compute from at all).

## Why gated behind an explicit opt-in, not default-on

This is new HID output as a side effect of a generic screenshot-retry path
used by nearly every call site in the system, in a failure state that,
before tonight, had no proven-safe automatic recovery. The manager's own
direction on this: "hold the actual live verification of this specific fix
for whenever you judge is right." So: implemented fully and unit-tested
offline now; shipped OFF by default (`PiKVMConfig::new` sets
`source_online_wake_nudge: false`, matching every other opt-in flag's
convention in this config struct) until a real live-hardware pass proves it
recovers the case without side effects. Flipping it on is a one-line,
reviewable, separately-timed decision, not bundled into landing the code.

## Implementation

- `PiKVMConfig.source_online_wake_nudge: bool` (default `false`).
- `fetch_snapshot_with_retry`: third attempt gated on the flag, using
  `WAKE_NUDGE_DELTA_PX = 5.0` / `WAKE_NUDGE_SETTLE_MS = 1500` (mirrors
  `--fallback-mouse-move`'s validated 5px delta and the corner-control
  harness's own post-wake settle time), with `wake_nudge_toward_center`
  computing the actual direction from the held belief.
- Unit tests (mock `RequestFn`, no live hardware):
  - flag off: unchanged two-attempt behavior (regression pin on the
    existing tests).
  - flag on, third attempt succeeds: `Ok`, exactly one
    `/hid/events/send_mouse_relative` call observed, no retry-storm.
  - flag on, all three snapshot attempts 503: `StreamerUnavailable`,
    still exactly one mouse-move call (never re-nudges past the one
    escalation).
  - the mouse-move call itself erroring doesn't crash the retry — falls
    through to the final snapshot attempt anyway, matching
    `screenshot_keeping_cursor_alive`'s existing best-effort
    (`let _ = ...`) convention for a nudge that isn't the primary
    operation.
  - `wake_nudge_toward_center` (pure function, 5 cases): from each of the
    four corners nudges toward center on both axes; with no known bounds,
    falls back to the fixed default.
  - end-to-end: with belief reset to a `BottomRight`-style position, the
    actual HID request sent carries negative deltas on both axes (toward
    center), not the corner-agnostic fixed `(+5,+5)` — the specific case
    nixos-dev's review flagged.

## Review (nixos-dev)

Two points raised, both addressed:
1. **Fixed-direction safety** (real safety concern) — fixed by
   `wake_nudge_toward_center`, above.
2. **Possible `verify_motion` measurement contamination** — if the
   escalation nudge fires during `slam_to_corner`'s "after" verification
   capture, the frame reflects a cursor position a few px away from where
   the slam itself actually left it. `verify_motion`'s own tolerance
   (default 80px, `mover/src/slam/motion.rs`) is already an order of
   magnitude larger than the nudge's 5px, and that function already sends
   its OWN small pre-verify nudge (`3.0 * vx, 3.0 * vy`) for an unrelated
   reason (keeping the cursor visible past its fade timer) — so this is
   very unlikely to move a matched cluster outside tolerance, but not
   proven. **Open item for live verification, not a code change**: check
   whether `verify_motion`'s reported residual/position differs
   measurably on a run where the escalation nudge fires vs. one where it
   doesn't, before ever enabling this flag for a `slam_to_corner`-adjacent
   call path.
3. (Minor, non-blocking) error-message wording — the "nudge tried and
   failed" branch now names `PiKVMConfig::source_online_wake_nudge`
   explicitly, matching the "disabled" branch's own wording.

## Status

Reviewed by nixos-dev; both substantive points addressed in code (item 2
is a live-verification checklist item, documented above, not a further
code change). Not live-verified yet — that is a deliberate, separate,
later decision per the manager's explicit direction.
