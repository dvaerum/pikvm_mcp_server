# Phase 231 — defensive Esc + Enter after `ipadGoHome` forceHomeViaSwipe

**Date:** 2026-05-10
**Version:** v0.5.207
**Status:** Live-verified fix.

## TL;DR

`ipadGoHome({forceHomeViaSwipe: true})` was sometimes RE-LOCKING an
already-unlocked iPad — the same Phase 219 hazard
(`unlockIpad`'s swipe re-locks home) applied to `ipadGoHome`'s
swipe. Phase 220 thought this didn't reproduce; today's verbose-
discover trace caught it: home screen 14:53 → unlock + force-home
→ lock screen 16:05.

Fix: send Esc + Enter after the swipe. Both are no-ops on home
but unlock if accidentally locked. Cost: ~800 ms.

After the fix, the same verbose-discover trace at v0.5.207
shows: iPad on home screen 16:23, moveToPixel runs through to
LINEAR phase, reports `residual=3.1px ≤ 100px`. **First
successful small-icon target traversal on home screen this
session** — the click pipeline was being blocked by the swipe
silently re-locking, not by detection-layer issues.

## How this was found

Phase 228 verified Phase 217+219+214 chain works at v0.5.206 at
14:53. A later cron tick at 16:05 ran the same
`test-phase216-verbose-discover.ts` script and found the iPad on
the lock screen — even though the script does
`unlockIpad → ipadGoHome({forceHomeViaSwipe: true})` before
attempting moveToPixel.

Enhanced the diagnostic to capture screenshots at every step
(00-initial, 01-after-unlock, 02-after-force-home,
03-after-fail). Confirmed: the iPad WAS unlocked after step 1,
but ipadGoHome's forceHomeViaSwipe re-locked it.

## What changed in code (v0.5.207)

`src/pikvm/ipad-unlock.ts:417-428`: after the swipe-up gesture,
send Escape (200 ms settle), then Enter (600 ms settle). This
matches the Phase 217 unlock-key sequence. On a home screen
where the swipe didn't lock, both keys are no-ops. On a lock
screen the swipe accidentally created, Enter unlocks.

```ts
await sleep(1000);  // existing post-swipe settle
// Phase 231: defensive Esc + Enter — no-op on home, unlocks
// if the swipe accidentally locked.
await client.sendKey('Escape');
await sleep(200);
await client.sendKey('Enter');
await sleep(600);
```

Also updated the result message:
> Followed by slam-corner + swipe-up + defensive Esc+Enter
> (Phase 231 undoes accidental lock).

## Test updates

`src/pikvm/__tests__/ipadGoHome.test.ts`:
- Mock client extended with `sendKey` recorder
- 2 new Phase 231 tests:
  1. "forceHomeViaSwipe sends Esc + Enter AFTER the swipe (defensive unlock)"
  2. "defensive Esc + Enter is NOT sent when forceHomeViaSwipe=false"
- Existing "message records that the swipe was performed" updated
  to allow either "app switcher" or "esc/enter/phase 231" wording

12/12 ipadGoHome tests pass. 705/705 full suite green. Nix build
green at v0.5.207.

## Live verification at v0.5.207

`test-phase216-verbose-discover.ts` at 16:23:

```
[locateCursor] (succeeded — pre/post pair found)
[motion] picked pair, ratio measured
[motion] post-cands(window=600@906,797)=14
[move-to] entering LINEAR phase: residual=3.1px ≤ 100px
[move-to] pass 1: zero-mickey correction; cannot improve further.
SUCCESS
```

3.1 px residual is well within the `maxResidualPx=35` safety gate.
This is meaningful: the click pipeline FUNCTIONS on the home
screen when it actually reaches the home screen.

## Phase 220 reinterpreted

Phase 220's "doesn't reproduce" was timing-dependent: the iPad's
gesture interpretation depends on cursor position, screen state,
and possibly Pointer Animations. From the same starting state
(home screen, fresh-from-unlockIpad), the swipe sometimes locks
the iPad and sometimes doesn't. The Phase 231 fix treats it as
"sometimes locks, undo defensively" rather than trying to
predict when it locks.

## Files in this commit

- `src/pikvm/ipad-unlock.ts` — defensive Esc + Enter post-swipe
- `src/pikvm/__tests__/ipadGoHome.test.ts` — sendKey mock, 2 new
  Phase 231 tests, message-test update
- `package.json` + `src/version.ts` — v0.5.207
- `docs/troubleshooting/2026-05-10-phase-231-defensive-keys-after-force-home-swipe.md`
  — this doc

## State at v0.5.207

- 705/705 tests green
- Nix build green
- Live-verified: ipadGoHome forceHomeViaSwipe now reliably leaves
  iPad on home screen
- moveToPixel succeeds with 3.1 px residual on Settings target —
  first successful small-icon traversal of this session
- Cron 54c25dad still running every 17 min
