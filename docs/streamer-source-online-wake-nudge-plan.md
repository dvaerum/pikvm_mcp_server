# `source.online` wake-nudge fix — design (2026-08-30)

> **STATUS (2026-08-30, updated after live verification): the v1 fix's
> core mechanism is DISPROVEN, not just unverified.** A real live test
> found the mouse-move escalation this fix relies on does NOT reliably
> revive `source.online` — a genuine current 503-idle episode survived
> the full flag-on escalation path, then was immediately recovered by a
> Space keypress on the exact same stuck state. This is not "implemented,
> pending a routine live-verification pass" — it is "built, reviewed for
> safety, and its central assumption failed its first real test." The
> flag stays off. See "Live verification result" and "Status" near the
> bottom for the full v1 account.
>
> **v2 design added below** ("Context-aware keypress escalation"): a
> keypress-based escalation, gated on a NEW per-client "how long since
> this client last sent a keyboard key" tracker, safe in the vast
> majority of real calls (anywhere without very recent keyboard activity)
> — but it does NOT solve the narrower case of recovering `source.online`
> DURING an active multi-key lock-screen/passcode sequence (see
> docs/allow-access-when-locked-keyboard-check-plan.md's second live
> attempt) — that case is intentionally left to fall back to the v1
> mouse-move nudge, since ANY extra keypress mid-sequence is genuinely
> unsafe to send blind.

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

## Live verification result (2026-08-30 ~13:29) — NEGATIVE. Do not enable this flag.

Manager asked whether now was a reasonable time to run it; judged yes (the
device happened to be sitting in the real 503-idle state this fix targets,
confirmed via the actual production `fetch_snapshot_with_retry` path with
the flag OFF — genuine current state, not a synthetic test). Ran three
steps, in order, on the real device:

1. **Precheck (flag off)**: `client.screenshot(None)` — `StreamerUnavailable`
   after the existing two-attempt retry. Confirms a genuine current
   `source.online=false` episode, not a curl/proxy artifact.
2. **Fix under test (flag on)**: same call, `source_online_wake_nudge: true`,
   nothing else changed. Elapsed 14.8s (consistent with the full
   escalation path actually running: connect + 2×503/grace + nudge +
   settle + 3rd 503). **Result: STILL FAILED.** The error text confirms
   the nudge fired ("a wake nudge... was also tried and did not recover
   it") — the escalation logic ran as designed, it just didn't work.
3. **Disambiguation (same episode, no new connection)**: sent ONE `Space`
   keypress (the mechanism tonight's earlier root-cause investigation
   actually validated, §22-§26) through a fresh client — first wake
   attempt this idle episode, so none of the documented second-press risk
   applies. **Result: REVIVED** — `get_streamer_status()` reported
   `online=true`, and a direct screenshot succeeded (78374 bytes).
   Screenshot inspected directly: a genuine, clean, plain lock screen
   (clock 13:29, "100% Charged", lock icon) — safe, no incident, exactly
   the state the whole session's safety model expects.

**This is a real, important negative finding, not a minor caveat.** The
fix's mouse-move mechanism was inherited from `--fallback-mouse-move`'s
OWN validated property — that it's SAFE (doesn't dismiss a lock screen)
— never from any independent proof that it's EFFECTIVE at reviving
`source.online`. This live test directly contradicts that inherited
assumption on a genuine real episode: mouse-move escalation failed where
an otherwise-identical Space keypress, moments later on the same stuck
state, succeeded. N=1 each side — not proof mouse-move NEVER works — but
enough to say the fix as designed cannot be trusted to actually recover
the case it targets, and the flag must stay off pending a real redesign,
not just a bigger live sample of the current mechanism.

This is exactly why the flag defaulted off and why live verification was
held as a separate, deliberately-timed decision rather than bundled into
landing the code — the caution was justified: it caught a real gap before
it could ever have been enabled by default.

## Why mouse-move and keypress likely differ (nixos-dev's mechanistic hypothesis, code-checked)

nixos-dev's instinct: iPadOS treats pointer/trackpad input as comparatively
passive (this project already documents the on-screen pointer fading after
idle — the whole reason `screenshot_keeping_cursor_alive`'s ±1px nudge
exists), while keyboard input is a stronger "user is actively present"
signal to the OS's own power/display management. If the display-wake
heuristic is keyed off perceived presence rather than raw HID traffic, a
keypress plausibly clears a higher-confidence bar than a pointer nudge —
treat "mouse-move is probably not an adequate substitute" as the working
assumption now, not a 50/50 unknown.

Checked against this codebase's own documented lock-screen key semantics
(`mover/src/ipad_unlock/unlock_with_code.rs`'s header): `Space` is used
TWICE, on purpose, as the first two stages of the passcode-unlock
sequence — "Space → wait: wakes the screen" then "Space → wait: dismisses
the lock screen, brings up the passcode prompt." This is a real, DELIBERATE
two-stage state machine this project already exploits, not an incidental
side effect — confirms the hazard is structural, not a fluke. `unlock_ipad`
(`unlock.rs`) also treats `Enter` as "the actual unlock key on iPadOS 26
lock screens," a distinct advancing role of its own. Neither file
documents any key that's proven wake-only / never-advances — whether such
a key exists (one iPadOS's lock-screen state machine treats as a strong
presence signal but does NOT advance to the next stage on a second press)
is the concrete open question for a fresh design pass, not resolved by
what's in the codebase today.

## Candidate lead for the open question (manager, via web search — 2026-08-30, UNTESTED against this rig)

Apple documents that since iPadOS 16.4, an external keyboard key press at
the lock screen wakes the display AND jumps straight to the passcode
field — matching exactly what's been observed here. There's a specific
device setting: **Settings → Face ID & Passcode → Allow Access When
Locked → Keyboard**. If that's off, a key press plausibly only wakes
without advancing — which would be exactly the "wake-only, never-
advances" behavior this doc's own review thread said doesn't currently
exist anywhere in the codebase or documented iPadOS behavior.

**Not verified against this specific rig.** Two concrete checks needed
whenever this is picked back up: (a) what that setting currently is on
the test iPad, (b) whether toggling it actually changes the observed
`Space`-press behavior (wake-only vs. wake-then-advance). If confirmed,
this could be a real, simple, CONFIG-level fix — no code changes needed
at all, just confirming/setting a device setting correctly.

Deliberately not executed in this session: checking/toggling this
setting means navigating into Settings on the real device (itself
gated behind re-entering the passcode, per iOS convention) — a deeper,
more invasive live interaction than anything else in this doc, and one
that deserves the same assert-before-every-click harness discipline
this project already requires for on-UI navigation, not a freehand
attempt bolted onto an already long session. A fresh pass, properly
built, is the right way to check this — not decided or attempted here.

## Status

Reviewed by nixos-dev; both substantive review points addressed in code.
Live-verified 2026-08-30: **negative result, flag must stay off.** The
underlying root-cause finding (§22-§26 — the iPad's display needs a real
redraw event, not connection bookkeeping) still stands; what's now in
question is specifically whether a relative mouse-move is a sufficient
redraw event, or whether only a keypress reliably is — and, per the above,
the working assumption is now that it needs a keypress, with the open
design question being WHICH key is both effective and safe. A real,
concrete, untested lead exists for that question (see above — the
"Allow Access When Locked → Keyboard" setting). Needs a fresh design
pass + that setting checked on-device (through the same review process)
before any further live testing — not decided in this pass.

---

# v2 design: context-aware keypress escalation (2026-08-30, manager's proactive next step)

## Why now

The v1 mouse-move fix is disproven. But a keypress reliably revives
`source.online` (confirmed live, multiple times tonight) — the ONLY
reason it isn't already the escalation mechanism is the lock-screen
double-press-dismiss risk, which is real but genuinely narrow: it only
matters when a wake key was ALREADY sent recently and the screen is still
sitting on the plain-lock first stage. In every other real call —
already unlocked, an ordinary idle health-check, the first wake attempt
this sequence — a keypress is exactly as safe as the mouse-move was
meant to be, and unlike the mouse-move, it actually works.

## Correction to the manager's framing, stated plainly

The manager's ask assumed "reuse whatever state-tracking already exists
from today's lock-screen work." Checked this before designing anything
on top of it: **no such tracker currently exists.** `emit_clock` (the
only existing "last HID activity" clock in this codebase) is explicitly
documented as MOUSE-only ("last mouse emit timestamp... call after every
mouse emit") and is a process-wide global `static`, not scoped to a
specific client. `send_key`/`send_shortcut` (`keyboard.rs`) touch it not
at all. Reusing it as-is would be architecturally wrong on two counts:
it doesn't track keyboard emits, and a global static would incorrectly
conflate activity across multiple concurrent `PiKVMClient` instances
(this session alone has constructed many, across its own diagnostic
examples) rather than answering "has THIS client recently sent a key."
New per-instance tracking is needed — a deliberate design decision, not
an oversight of "reusing what's there."

## Why the client layer can't know the actual screen state — and doesn't need to

The fundamental problem this whole night's investigation exists to solve
is: during a `source.online` outage, there IS no screenshot — that's
the definition of the failure. So a gate like "screen is currently on
the plain-lock first stage" can never be evaluated from inside
`fetch_snapshot_with_retry` at the moment it needs an answer; there is no
signal to check it against. The only tractable proxy is procedural, not
visual: **how long since THIS client last sent a keyboard key.**
Tonight's own two live attempts at the Allow-Access-When-Locked check
directly demonstrated the mechanism this proxy relies on: a second Space
press sent well after a real gap (tens of seconds, exceeding this
project's own documented ~10-12s wake/redraw window) registered as a
FRESH wake, not a continuation of the two-stage dismiss sequence — i.e.,
enough elapsed time genuinely resets the lock-screen state machine back
to its first stage. A "quiet window" threshold is therefore a real,
evidence-grounded (if still `N=2`, not yet a large sample) proxy for
"is a second keypress here going to land as a fresh wake, not a
dismiss," without ever needing to see the screen.

## Design

- New `PiKVMClient` field: `last_keyboard_emit: Mutex<Option<Instant>>`
  (per-instance, mirroring `belief`'s own per-instance `Mutex` pattern on
  the same struct — NOT a global static like `emit_clock`, for the
  reason above).
- `send_key` stamps it on every call (covers `send_shortcut` for free,
  since it's built entirely on `send_key`).
- Pure decision function (mirrors `streamer_keepalive::liveness::
  is_stale`'s exact shape and boundary convention — `>`, not `>=`):
  ```rust
  fn keyboard_wake_is_safe(
      last_keyboard_emit: Option<Instant>,
      now: Instant,
      quiet_window: Duration,
  ) -> bool {
      match last_keyboard_emit {
          None => true,
          Some(last) => now.duration_since(last) > quiet_window,
      }
  }
  ```
- `KEYBOARD_WAKE_QUIET_WINDOW_MS = 20_000` — roughly double the
  documented ~10-12s window, a deliberately wide margin given this is
  `N=2` evidence, not a proven constant. Flagged as its own live-
  verification item, same as the wake-nudge delta ever was.
- `fetch_snapshot_with_retry`'s third-attempt escalation: with keyboard
  wake permitted for this call (see below) AND `keyboard_wake_is_safe`
  against `self.last_keyboard_emit`, send `send_key("Space", None)`
  instead of the mouse-move nudge. Otherwise fall back to the existing
  `wake_nudge_toward_center` mouse-move nudge, unchanged from v1. Same
  `PiKVMConfig::source_online_wake_nudge` opt-in flag still gates
  whether the escalation happens at all, off by default.

## Review round 2 (nixos-dev) — a significant safety-scope gap, fixed

Initial v2 draft gated the keypress purely on `keyboard_wake_is_safe`'s
timing proxy — nixos-dev caught a real, significant gap: that proxy only
reasons about ONE hazard (the lock screen's own two-stage wake-then-
dismiss machine). But `fetch_snapshot_with_retry` sits under nearly
every screenshot call in the whole system, in ARBITRARY UI contexts —
an open app mid-interaction, a focused text field (a bare `Space` types
a literal character), a system alert/modal (`Space`/`Return` can
activate a focused control in some UI/accessibility frameworks). A
timing-since-last-keypress proxy says nothing about which of these the
device is actually showing — v1's mouse-move was chosen not just for
lock-screen safety but for being broadly harmless across arbitrary
unknown contexts; `Space` doesn't share that property.

**Fix: per-call consent, not a blanket runtime heuristic.** New
`ScreenshotOptions.allow_keyboard_wake: bool`, default `false`. The
keypress escalation now requires BOTH `allow_keyboard_wake: true` on
THIS specific call AND `keyboard_wake_is_safe`'s timing check —
`allow_keyboard_wake: false` is a hard override that always uses the
mouse-move nudge regardless of timing (unit-tested explicitly). Every
existing call site (`pikvm_screenshot`'s MCP tool, every internal
`.screenshot(...)` call across `mover`/`ipad-hid`/the server) defaults
to `false` and is therefore byte-identical to v1's behavior — nothing
changes for any caller that doesn't explicitly opt in. Deciding to flip
`true` at any SPECIFIC call site (e.g. a harness that just ran its own
lock/wake sequence, so has real contextual grounds to trust it) is a
separate, later, per-call-site design decision — not part of landing
this code, same discipline as the whole escalation's own top-level
opt-in flag.

## Honest scope limitation

Even with `allow_keyboard_wake: true` granted, this does NOT unblock the
specific failure mode hit twice in docs/allow-access-when-locked-
keyboard-check-plan.md's live attempts: recovering `source.online`
DURING an active, in-progress multi-key lock-screen/passcode sequence.
In that exact window, a keyboard key was sent very recently (by design
— that's the sequence itself), so `keyboard_wake_is_safe` correctly
reports "not safe" and falls back to the mouse-move nudge, which
tonight's own evidence says doesn't reliably work — so the escalation
would still fail to recover in-sequence, same as today. That specific
case remains parked per nixos-dev's own framing (needs either a more
direct fix or a purpose-built faster sequence, not this). This fix
targets the GENERIC/ordinary case instead, for callers that have
explicitly opted in — most real `fetch_snapshot_with_retry` calls
(health-checks, post-slam verification screenshots not immediately
preceded by a keypress, etc.) have no recent keyboard activity and
would newly, reliably self-heal, once a specific call site is reviewed
and flipped on.

## Implementation status

Code-complete, unit-tested (including the scoping fix), sent to
nixos-dev for review. Not live-verified — per the manager's own standing
instruction, that timing is a separate, later decision. No caller has
been flipped to `allow_keyboard_wake: true` yet — that's the next,
separate, per-call-site decision once this lands.
