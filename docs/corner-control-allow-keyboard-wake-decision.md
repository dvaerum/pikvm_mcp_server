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

**Status**: proposal only, sent to nixos-dev for its own explicit
review — not decided or implemented. If approved: extend
`SlamOptions`/`AnchorRequest`'s single `allow_keyboard_wake_after` field
into two independent fields (`_before`/`_after`, or rename to drop the
`_after` suffix and add a sibling), threading `before`'s own escalation
choice through the same call sites already touched, defaulting `false`
everywhere except the two approved corner-control-smoke sites.

Live verification, once the fix is actually exercised (needs `before`
addressed, or a run where `before` happens to succeed on its own), is a
separate, later, deliberately-timed decision per the manager's standing
instruction.
