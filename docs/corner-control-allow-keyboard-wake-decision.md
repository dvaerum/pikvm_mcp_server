# Opt-in decision: `allow_keyboard_wake` for the corner-control harness's post-slam verification screenshot (2026-08-30)

## What's being decided

Whether to flip `ScreenshotOptions.allow_keyboard_wake: true` (the v2
wake-nudge escalation's per-call consent gate, see
docs/streamer-source-online-wake-nudge-plan.md) for ONE specific call
site: the "after" verification screenshot `slam_to_corner` takes right
after the guarded slam in
`mover/examples/cursor_anchor_corner_control_smoke.rs` — the exact call
site this whole `source.online` investigation started from
(§8-§21 of docs/rust-port-plan.md).

Scope: the AFTER screenshot only, per the manager's own framing. The
BEFORE (pre-slam baseline) screenshot is a separate decision, not made
here.

## The specific context, reasoned through explicitly (not generically)

This harness only reaches the guarded slam after a real safety gate:

1. A human has visually confirmed, via a separately-saved, non-decaying
   screenshot, that the device shows a genuine, unambiguous lock screen
   (clock/wallpaper/home-indicator, no app content) — the actual safety
   boundary this whole harness's design centers on.
2. `AnchorGuard::CallerAsserted`'s contract is exactly "safe BECAUSE
   it's a genuine lock screen" — matching that human confirmation, not
   inverting it.
3. Between the human's "yes" and the slam actually firing, real wall-
   clock time passes (the human reads a static screenshot). This
   project's own v8 header note (in the harness itself) already
   documents this exact gap causing the display to re-dim before the
   post-slam verification screenshot fires — the reason the harness's
   own torn-frame/retry logic exists at all.
4. **The slam itself is pure relative mouse movement** toward the
   target corner — `Corner::TopLeft`, "the only corner any current call
   site uses" (`AnchorRequest.corner`'s own doc comment). No keyboard
   keys are sent during the slam. No clicks are sent either —
   `slam_to_corner` is a pure positioning primitive.
5. Mouse movement alone cannot wake, dismiss, or otherwise transition
   iPadOS's lock-screen state machine — established fact this entire
   session (the whole reason `--fallback-mouse-move` exists as the safe
   alternative to `Space` in this same harness). So the slam itself
   cannot have changed the device's locked/unlocked state.

## What this means for the "after" screenshot, if `source.online` is stuck there

Given (4)+(5): the device is either (a) still showing the same genuine
lock screen the human confirmed, now further dimmed (more idle time has
passed since "yes"), or (b) something external and unrelated to this
harness changed the screen state during the human's confirmation-
reading window (an incoming call, a notification, a scheduled event) —
a residual possibility that exists for this harness EVERY time it runs,
regardless of this fix, already accepted (the only mitigation is the
human looking at the screenshot before saying yes, which already
happened).

**Precise wording (nixos-dev review — the original draft overclaimed
this)**: this fix does not change case (b)'s LIKELIHOOD — that event
was already possible regardless of this escalation. It does marginally
raise case (b)'s potential SEVERITY if it coincides with this
escalation firing: if that already-accepted rare event landed the
device on something with an actual focused control, a `Space` there
could activate it (its known "activate focus" semantics), where a
mouse nudge would have stayed harmless regardless of what was focused.
This is a real but narrow, multiply-compound-probability case (external
event AND `source.online` sticking AND a focused control existing on
whatever resulted) — not something to block on, but stated exactly
rather than rounded down to "not introduced."

Case (a) is exactly the case the v2 escalation's `keyboard_wake_is_safe`
timing gate is built for: real, sizeable idle time (human reading time)
has almost certainly exceeded the 20s quiet window since this episode's
last keyboard key (`WAKE_DELAY_S`'s own earlier Space, or none at all),
so a `Space` here registers as a fresh wake, not a continuation.

**Stated plainly, not rounded up**: this does NOT prove the device is
on the lock screen at that exact moment — the same fundamental
unknowability this whole investigation has wrestled with all night
applies here too. What CAN be said: nothing in this call site's own
control flow provides a mechanism for the device to have transitioned
to an ARBITRARY unrelated context (an open app, a focused text field) —
the class of risk nixos-dev flagged for the fully generic case. The
realistic state space here is narrow (genuine lock screen, lit or
dimmed, or an already-accepted external event) — materially smaller
residual risk than the generic case, not literally zero.

## Interaction with the harness's own recovery logic

`anchor_cursor`'s `recovery_attempted` path (Esc+Enter defensive keys)
fires AFTER `slam_to_corner` returns, based on its verification result —
strictly sequential with, never concurrent with, this escalation's own
`Space` (which fires INSIDE the screenshot fetch that produces that
verification result). No timing overlap, no risk of the two being
confused with each other or compounding.

## Plumbing needed if approved (not yet built)

`ScreenshotMode`/`SlamOptions` (mover/src/slam/types.rs,motion.rs) don't
currently carry a `ScreenshotOptions`-shaped per-call flag — both
`ScreenshotMode` variants (`Nudging`, `Raw`) hardcode `client.screenshot
(None)`/`screenshot_keeping_cursor_alive(None)`. Needs: a new bool
threaded through `SlamOptions` → `take_screenshot_with_retry`'s "after"
call specifically (not "before") → `AnchorRequest` → set explicitly by
`cursor_anchor_corner_control_smoke.rs`'s own call, defaulting `false`
everywhere else (every other `slam_to_corner`/`anchor_cursor` caller in
the codebase unaffected).

## Status

**Approved by nixos-dev** — verified the `keyboard_wake_is_safe` 20s
gate is a hard code-level enforcement, not a hopeful timing assumption
(a fast confirmation self-selects into the safe mouse-move fallback on
its own); confirmed no timing overlap with the harness's own recovery-
key logic; agreed scoping to AFTER-only (leaving BEFORE undecided) is
the right discipline. One wording correction applied above (case (b)'s
severity, not likelihood, is what's marginally affected). Cleared for
implementation.

**Implemented.** `SlamOptions.allow_keyboard_wake_after` (default
`false`) threads through `take_screenshot`/`take_screenshot_with_retry`
to the `after` shot's `ScreenshotOptions.allow_keyboard_wake` only —
`before` always passes `false`, hardcoded, regardless of the caller.
`AnchorRequest.allow_keyboard_wake_after` (no `Default` derive on that
struct, so every one of its 9 construction sites had to set this
explicitly — no new call site can silently inherit `true`) threads
through `run_slam`. Set `true` at exactly the two approved call sites
(`cursor_anchor_corner_control_smoke.rs`'s positive AND negative
controls — both reach the guarded slam via the same human-confirmed-
lock-screen precondition); `false` everywhere else in the codebase.

2 new end-to-end tests (`allow_keyboard_wake_after_tests` in
`mover/src/slam/motion.rs`) drive `slam_to_corner` itself through a real
escalation and assert which HID endpoint fired: `true` → `/hid/events/
send_key`, `false` → `/hid/events/send_mouse_relative`, isolated from
the slam's own large relative-move calls and the pre-verify in-corner
nudge by checking the exact `WAKE_NUDGE_DELTA_PX` magnitude. Full
workspace: all green (mover 352/352, was 350), clippy `-D warnings` and
fmt clean.

## First live run (2026-08-30 ~19:14-19:16) — inconclusive, zero incident, the fix was never actually exercised

Ran the harness for real (health-check first, genuine lock screen
confirmed by direct visual inspection both before and at the
confirmation-screenshot checkpoint). Confirmed by writing "yes."

The `before` screenshot (deliberately NOT wired to `allow_keyboard_wake`
— out of scope for this decision) hit the same recurring
`source.online` stuck pattern, exhausted its 3-attempt outer retry using
only the (already-shown-ineffective) mouse-move fallback, and
`slam_to_corner` returned `Err` **before the slam movement loop ever
ran** — zero HID went near a corner. The harness's own v8 graceful-
degrade path caught this, ran `unlock_ipad()` recovery, and exited
INCONCLUSIVE (code 2), exactly as designed. Final-state screenshot
inspected directly: a clean Touch ID / Use Passcode / Cancel prompt —
safe, known, recoverable, not mid-navigation in any app.

**This run gives neither positive nor negative evidence about the new
fix itself** — it was never reached. The actual blocker was the
`before` screenshot, which this decision deliberately left unaddressed.

## Addendum: extending to `before` — proposal (nixos-dev review, correction applied)

**First draft above got the timing direction backward — corrected
here.** `before` fires strictly EARLIER in wall-clock time than
`after` — before the slam loop's own ~1.5s+ of movement even runs, let
alone the pre-verify nudge/settle afterward. So elapsed time since the
last keyboard key is actually SMALLER at `before` than at `after`, not
larger — the opposite of what the first draft claimed. In practice this
likely doesn't change the verdict (this session's own confirmation
windows have run tens of seconds to minutes, comfortably past the 20s
quiet-window margin either way), but the stated justification needs to
say that plainly, not claim the wrong direction.

**The actual transferable argument is causal, not timing-based**: does
anything in the harness's own control flow send a key or click to the
device between the human's confirmation and this specific screenshot
call? For `before`, same answer as `after`: no — nothing happens in
that gap except the confirmation mechanism itself (operator reading a
file, not a device-side action). That's the real basis for extending
the argument from `after` to `before`, and it holds independent of the
(corrected, now-irrelevant) timing framing.

**One genuine asymmetry, not a blocker, worth stating plainly**: `after`
is the LAST screenshot in the sequence — nothing downstream depends on
the device's exact resulting state once it succeeds. `before` is
different: if its escalation fires and re-wakes the display, the slam's
own movement + corner-detection logic runs immediately afterward
against a screen just freshly re-illuminated by that same wake event.
Not a safety concern (still the same locked device; a fresh Space press
wakes, it doesn't dismiss) — but a real, low-probability ACCURACY
question: could corner-target detection be less reliable against a
frame captured moments after a wake/redraw transition than an already-
stable one? Flagged, not resolved — the same detection logic already
handles post-wake frames elsewhere in this project (e.g. the
confirmation-screenshot loop's own torn-frame retry), which is
reassuring precedent but not a proof for this specific case.

**Cross-shot interaction, confirmed by construction (nixos-dev)**: if
`before`'s escalation fires a real `Space` and `after`'s ALSO wants to
escalate shortly after (well within the slam's own runtime, comfortably
inside `KEYBOARD_WAKE_QUIET_WINDOW_MS`), `keyboard_wake_is_safe`'s
shared per-client `last_keyboard_emit` clock correctly sees that recent
emit and makes `after` fall back to mouse-move instead — even with
`allow_keyboard_wake_after: true` also set. This is exactly right (a
real second `Space` within the window genuinely IS the dismiss-risk
case) and falls out of the existing per-client tracking for free, no
extra logic needed. Unit-tested explicitly
(`a_before_keypress_makes_the_same_runs_after_escalation_fall_back_to_mouse`)
so this is a verified property, not an accidental one.

**Status: approved and implemented.** `SlamOptions`/`AnchorRequest` now
carry two independent fields, `allow_keyboard_wake_before` and
`allow_keyboard_wake_after`, threaded through the same call sites as
the original `after`-only change. Both `true` at exactly the two
approved corner-control-smoke sites; `false` everywhere else. mover:
355/355 (was 352, +3: `before` recovers via keypress, `before` false
falls back to mouse, the cross-shot interaction). Full workspace green,
clippy `-D warnings` + fmt clean.

## Second live run (2026-08-30 ~19:32-19:33) — categories 2/5 PASSED end-to-end for the first time this session, but the escalation itself STILL wasn't exercised

Health-check, lock, wake (one torn-frame retry, correctly handled — no
re-wake), confirmation screenshot all visually confirmed genuine. Both
the positive control (full slam, `TopLeft`) and negative control
(deliberately short slam, same guarded path) completed cleanly:

- Positive: `origin=(516, 58), verified=Some(true)` — a real corner
  landing correctly matched.
- Negative: `origin=(516, 58), verified=Some(false)` — a real short
  slam correctly NOT matched.
- Real `unlock_ipad()` recovery ran. Exit code 0 — PASSED.

All three screenshots this run needed (`before`/`after` × 2 controls)
succeeded on their FIRST raw attempt — `source.online` happened to stay
healthy throughout the whole slam sequence this time, so **the wake-
nudge escalation (keyboard or mouse) never actually fired in this run
either.** Categories 2/5 is now genuinely, verifiably PASSING
end-to-end for the first time this whole session — a real milestone —
but this specific run provides NO live evidence about the escalation
mechanism itself, which remains untested against a real mid-slam
`source.online` stall. That would need a run where the stall actually
coincides with a `before`/`after` screenshot attempt — not something
that can be forced deterministically, only waited for.

All screenshots (confirmation, positive, negative, final) inspected
directly: genuine, clean, safe states throughout — zero incident.

Live verification of the escalation mechanism specifically remains
open, pending a future run where the timing happens to line up (or a
deliberately-constructed live test that forces the condition) — a
separate, later, deliberately-timed decision per the manager's standing
instruction.

## Category 5 live attempt (2026-08-30 ~20:22-20:23) — INCONCLUSIVE, same known constraint, a natural extension proposed

Per georg's direct instruction (via manager) to pursue category 5's
identified reachable path now: health-checked (genuine lock screen,
visually confirmed, one torn-frame retry handled correctly), then
called `unlock_ipad(try_key_press_first: false)` directly — forcing the
key-press shortcut off so control reaches `unlock.rs`'s own internal
`CallerAsserted`-guarded slam (line 228) for real, not via the smoke
test's own direct `anchor_cursor` calls.

The guard itself WAS genuinely reached and did not refuse (`[slam]
TopLeft x 25 calls @ 60ms` printed, confirming `anchor_cursor` resolved
the guard and entered `slam_to_corner`) — but the `before` screenshot
then hit the same recurring `source.online` stuck pattern and exhausted
its 3-attempt retry, because `unlock_ipad()`'s own internal
`AnchorRequest` explicitly sets `allow_keyboard_wake_before: false` /
`allow_keyboard_wake_after: false` (unlock.rs:230-231) — it was
deliberately NOT one of the two approved corner-control-smoke sites.
`anchor_cursor` returned `Err` before the slam movement loop ever ran —
zero HID near a corner. `unlock_ipad()` propagated the error (no
graceful-degrade wrapper here, unlike the smoke test's own v8 fix), and
even the diagnostic final screenshot 503'd. A separate wake+recheck
confirmed the real, current device state directly: a genuine, clean,
plain lock screen — safe, zero incident, but INCONCLUSIVE, same as
§40's earlier finding, just via this specific call site instead.

**The guard being reached and not refusing may or may not satisfy item
4's literal bar on its own** — worth the team's own read, not decided
here. What's clear is the run did not COMPLETE (no `verified` result was
ever produced, `unlock_ipad()` returned `Err`), so this is not being
claimed as a pass.

**Natural extension, proposed not decided**: this exact configuration
(`try_key_press_first: false`) never sends any key before the internal
slam's screenshots — the same causal argument approved for the two
corner-control-smoke sites (nothing sends a key/click between whatever
triggered the call and this screenshot) applies here too, arguably even
more cleanly (no preceding wake-key sequence at all in this config).
Extending `allow_keyboard_wake_before`/`_after: true` to `unlock_ipad()`'s
own internal slam — at least for this specific `try_key_press_first:
false` configuration — would be a natural next candidate. Not
implemented or decided here; needs its own explicit review, same
process as every other extension in this doc.
