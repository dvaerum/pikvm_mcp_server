# Opt-in decision: `allow_keyboard_wake` for `unlock_ipad()`'s own internal guarded slam (2026-08-30)

## What's being decided

Whether to extend the v2 wake-nudge escalation's per-call consent
(`ScreenshotOptions.allow_keyboard_wake`, see
docs/streamer-source-online-wake-nudge-plan.md) to `unlock_ipad()`'s own
internal `CallerAsserted`-guarded slam step (`unlock.rs:228-245`), for
the specific `try_key_press_first: false` configuration — the one
reachable path to category 5's actual positive result
(docs/corner-control-allow-keyboard-wake-decision.md's §"Category 5 live
attempt").

## Why this reasoning transfers from the already-approved sites

The two already-approved call sites (`cursor_anchor_corner_control_smoke.rs`'s
positive/negative controls) were cleared on a CAUSAL basis, not a timing
one (nixos-dev's own correction of the `before`-extension's first draft):
does anything in the call path send a key/click between whatever
established the lock-screen precondition and this specific screenshot?
If no, a keypress escalation there is no more dangerous than the
mouse-move it replaces, since nothing has happened that could put the
device in an unrelated, unknown UI context.

For `unlock_ipad(try_key_press_first: false)` specifically: this
configuration explicitly SKIPS the Esc+Enter+Space key-press-first
attempt entirely (`unlock.rs`'s own `if options.try_key_press_first !=
Some(false) && ...` guard — with `Some(false)`, the whole branch is
skipped). So by the time control reaches the internal slam's `before`
screenshot, **zero keys have been sent this call at all** — an even
cleaner case than the corner-control-smoke sites, which do send a wake
key earlier in their own sequence (just long enough before that the
20s quiet window handles it). Here there is nothing to even need the
quiet window for.

## The precondition itself

Reaching this code path at all requires the caller to have ALREADY
established (by whatever means) that the device is on a genuine lock
screen — `unlock_ipad()` is a recovery/unlock primitive, never called
against an assumed-unlocked device by design (its own guard is
`CallerAsserted`, whose contract is "safe BECAUSE it's locked"). Real
callers of `try_key_press_first: false` today: the `swipe_on_key_press_
failure` back-compat path, and any caller that already knows the
key-press path won't work (e.g. an iPadOS revision where only the swipe
unlocks). Live-confirmed just now (docs/rust-port-plan.md §45): the
guard was reached and did not refuse, on a real, confirmed-locked
device, consistent with this contract holding.

## Scope: `before` and `after` both, for this call site specifically

Unlike the corner-control-smoke decision (which needed separate review
for `before` vs `after`, since the causal argument had to be checked
independently for each), here BOTH of `unlock_ipad()`'s own internal
slam's screenshots (`before` fired via `run_slam` → `slam_to_corner`,
and its own `after` if `verify_motion`/`capture_verification` triggers
one) sit at the exact same point in the causal chain: after the
precondition, before any key is sent. Approving one without the other
would be an arbitrary asymmetry with no basis — recommend approving
both together for this specific call site.

## Implementation (if approved)

`unlock.rs:230-231` currently hardcodes both `allow_keyboard_wake_
before`/`_after: false` in its own internal `AnchorRequest`. Two
options:
- (a) Simplest: flip both to `true` unconditionally at this one call
  site (matching the corner-control-smoke sites' own unconditional
  `true`), OR
- (b) More precise: only `true` when `options.try_key_press_first ==
  Some(false)` specifically — since that's the exact condition under
  which "zero keys sent this call" holds. If a future caller changes
  `try_key_press_first`'s default or some other path reaches this slam
  after key-press-first activity, (a) would incorrectly grant the
  escalation there too.

**Recommend (b)** — it encodes the actual causal precondition in code
rather than relying on today's call sites never changing, matching this
project's own standing preference for the principled option over the
locally-simplest one.

## Status

Proposal, not yet implemented or approved. nixos-dev: "your proposed
next step... is exactly right and the obvious move... probably the
real, final unlock for item 4." Sending this write-up for the same
explicit review as the other two extensions before touching any code.
