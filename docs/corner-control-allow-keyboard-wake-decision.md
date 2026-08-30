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
happened). This fix does not introduce that risk; it was already there.

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

Sent to nixos-dev for review of the SAFETY ARGUMENT specifically (not
just the plumbing shape) before any implementation. Not implemented
yet. Live verification, if this is approved and built, is a separate,
later, deliberately-timed decision per the manager's standing
instruction.
