# Phase 219 — `unlockIpad` from home screen LOCKED the iPad (swipe artifact)

**Date:** 2026-05-10
**Version:** v0.5.206
**Status:** Live-verified fix.

## TL;DR

Before Phase 219: calling `unlockIpad` while the iPad was already
on the home screen would TAKE IT BACK TO THE LOCK SCREEN. The
Esc + Enter + Space keys (Phase 217) hit the home screen as
no-ops, then the legacy swipe-up gesture (Phase 209) was
interpreted by iPadOS as a system gesture that ended with the
iPad locked.

After Phase 219: when `tryKeyPressFirst` runs successfully (the
default), the swipe is SKIPPED. The keys are now the primary
unlock path; the swipe is only invoked when keys can't reach the
iPad (legacy callers can opt back in with
`swipeOnKeyPressFailure: false`).

## Live evidence

`test-phase219-unlock-verify.ts` — single-shot: capture initial,
run `unlockIpad()` with defaults, capture after.

| Run | Initial state | After unlockIpad |
|:---|:--------------|:-----------------|
| Before Phase 219 (v0.5.205) | Home screen 12.20 | **Lock screen 12.20** |
| After Phase 219 (v0.5.206) | Home screen 12.27 | **Home screen 12.27** |

Same iPad, same code path, the only difference is the new
`swipeOnKeyPressFailure` defaulting to `true` (skip swipe when
keys ran).

## What changed in code (v0.5.206)

`src/pikvm/ipad-unlock.ts`:

- New `IpadUnlockOptions.swipeOnKeyPressFailure` (default `true`).
  When true (default), the swipe is SKIPPED if the
  Esc/Enter/Space key sequence ran without throwing. The function
  returns immediately after the keys with a screenshot for the
  caller to inspect.
- The legacy always-swipe behavior is reachable via
  `swipeOnKeyPressFailure: false`, useful for back-compat with
  callers that explicitly want the keys-then-swipe sequence (e.g.,
  on iPadOS revisions where neither Enter nor Space alone unlocks).

## Why this happens

iPadOS's "swipe up from bottom-center" gesture is contextual:

- **From lock screen**: dismisses the lock and shows home.
- **From home screen**: opens App Switcher (small swipe) or stays
  home (medium swipe).
- **From mouse-emulated swipe with PiKVM**: appears to be
  interpreted as a longer gesture variant — possibly the
  "swipe down from top" + "swipe up from bottom" combined sleep
  gesture, or the "scrub through home indicator to power off"
  flow. The end result is the iPad enters its locked state.

We didn't trace the exact iPadOS recognition path; the
correctness fix is to STOP issuing the swipe when we don't need
it. The keys-only path is sufficient for the lock-screen unlock
case (verified Phase 217), and for the home-screen case the keys
are no-ops so we should leave the iPad alone.

## Test updates

`src/pikvm/__tests__/unlockIpad.test.ts`:

- All swipe-mechanic tests (sandwich invariant, dragPx total,
  chunkMickeys, slamFirst behavior, drag direction, chunk size
  cap, result fields) now pass `tryKeyPressFirst: false` so they
  exercise the swipe path explicitly. Without this, the new
  default skips the swipe and the tests have nothing to inspect.
- The "keys before swipe" test renamed and updated to use
  `swipeOnKeyPressFailure: false` so both keys AND swipe run.
- New test: "Phase 219: by default, swipe is SKIPPED after
  successful key press" pins the new behavior.
- New test: "Phase 219: swipeOnKeyPressFailure=false forces swipe
  even after keys" pins the back-compat opt-in.

13/13 unlockIpad tests pass. 697/697 full suite green. Nix build
green at v0.5.206.

## Caller migration

Existing callers don't need to change anything — the new default
behavior (skip swipe after keys) is what production wants. The
keys-only path successfully unlocks iPadOS 26 lock screens
(verified Phase 217) and is safe to invoke from any state.

If a caller explicitly wants the legacy keys-then-swipe sequence
(e.g., on iPadOS 26 with a passcode where neither Enter nor Space
unlocks), pass `swipeOnKeyPressFailure: false`. This is also what
the test suite uses to exercise the swipe code paths.

## Files in this commit

- `src/pikvm/ipad-unlock.ts` — `swipeOnKeyPressFailure` option,
  early-return when keys ran
- `src/pikvm/__tests__/unlockIpad.test.ts` — opt-in to swipe on
  swipe-mechanic tests; new Phase 219 tests
- `package.json` + `src/version.ts` — v0.5.206
- `test-phase219-unlock-verify.ts` — diagnostic that demonstrated
  the bug and confirmed the fix
- `docs/troubleshooting/2026-05-10-phase-219-unlock-from-home-locks-ipad.md`
  — this doc

## State at v0.5.206

- 697/697 tests green
- Nix build green
- Live-verified: `unlockIpad` from home screen no longer locks
  the iPad
- Cron 54c25dad still running, fires every 17 minutes
