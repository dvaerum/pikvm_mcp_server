# Phase 214 — Cmd+H does NOT dismiss the App Switcher; new `forceHomeViaSwipe` option fixes it

**Date:** 2026-05-10
**Version:** v0.5.202
**Severity:** Critical — invalidates Phase 211/212/213 measurements

## TL;DR

For most of the 2026-05-10 session, the iPad was stuck in **App Switcher
mode**, not on the home screen. `pikvm_ipad_home` (Cmd+H) does NOT
dismiss the App Switcher — only foreground apps. The `unlockIpad`-style
slam-corner + upward swipe gesture dismisses both, but `ipadGoHome`
wasn't using it.

Phase 214 ships a new `forceHomeViaSwipe: true` option on `ipadGoHome`
that runs Cmd+H followed by the slam + swipe so the iPad reliably
lands on the home screen.

## How this was discovered

Phase 211 documented three deterministic clusters where the algorithm
thought the cursor was: (949, 795), (970, 771), (972, 772).

Phase 212 added stationary-cluster rejection but the gate didn't fire
on the first detection (because `resetBelief` clears the history at
each call's start). Phase 213 extended the gate to the open-loop
detection path.

Diagnosing why template-match was failing in the bench (Phase 214
investigation), the cached template was visualized as a thin white
vertical line on black — clearly not a cursor.

Then the screenshot used for the bench was annotated and
**revealed**:
- The "iPad home screen" was actually the App Switcher tile view
- The Phase 211 "clusters" coincide with the **Weather widget**
  in the App Switcher's tile preview — the widget animates (sun,
  numbers, sparkline) and produces real motion-diff signal that
  isn't the cursor
- Target (905, 800) lay on the EDGE of the Files tile preview, not
  on Settings

Live-testing four dismiss methods (Cmd+H, Cmd+Up, Escape, Cmd+Q):
all four failed. Only `unlockIpad`'s slam-corner + upward swipe
exited the App Switcher.

## What we knew before this finding (and was wrong about)

The whole "Phase 211 false-positive cluster lock-in" framing was
based on a faulty premise:

| Old framing | Actual cause |
|:-----------|:------------|
| Static UI features fool motion-diff | Weather widget *animation* in App Switcher tiles is real motion |
| Cluster A/B/C are deterministic UI false positives | The widget animations land at deterministic pixel positions because the tile layout is deterministic |
| Algorithm needs cluster-rejection | Algorithm needs to be on the right screen first |

Phase 212/213 are still correct safety mechanisms but the LIVE bench
data they were tuned against was effectively noise on the wrong UI.

## What changed in code (v0.5.202)

`src/pikvm/ipad-unlock.ts`:
- New `IpadHomeOptions.forceHomeViaSwipe` (default `false` for
  backward compat)
- New `IpadHomeOptions.swipeDragPx` (default 1500, matches the
  unlockIpad value tested live on this iPad)
- `ipadGoHome` now optionally runs slam-corner-top-left, positions
  the cursor at the bounds-derived swipe-start, presses mouse-down,
  drags upward in 30-mickey chunks, releases — same gesture as the
  unlock swipe but with no Space-key fallback (this is for "go
  home", not "unlock", so we never want a stray space character)

`src/pikvm/__tests__/ipadGoHome.test.ts` extended:
- Default-false: only Cmd+H (no mouse activity)
- True: Cmd+H + bracketed mouse-down/up with upward drag
- Custom `swipeDragPx` honored
- Message records the swipe was performed

10/10 ipadGoHome tests pass. 691/691 full suite green.

## What changed in code (v0.5.201, Phase 213, included in this commit)

`src/pikvm/move-to.ts`:
- Open-loop motion-diff result now also checks
  `client.wouldRejectAsStationary` before being accepted — same
  pattern as the correction-pass gate from Phase 212. If rejected,
  falls through to template-match. Doesn't help on the FIRST
  detection of each call (resetBelief clears history), but defends
  against cross-call lock-in if the same lastObservation persists
  across an `ipadGoHome` that didn't actually move the cursor.

## Why ship Phase 213 anyway despite Phase 214 superseding the framing

Phase 213 is correct code. The mechanism it implements (reject
stationary observations after a real emit) defends against a real
failure mode regardless of which screen we're testing on. The Phase
211 framing was wrong about the SOURCE of the deterministic clusters,
but the protection itself is sound and shouldn't be reverted.

## Live verification — what works now

After `ipadGoHome(client, { forceHomeViaSwipe: true })`:
- iPad lands on the home screen (Settings icon visible at ~(905, 800))
- All apps/widgets visible
- Cursor visible at top of screen near (1075, 60)

After this, running `test-phase212-bench.ts` shows: **0/10 valid
trials**. Both motion-diff and template-match fail because:

1. **Cached template is contaminated.** Visual inspection shows a
   thin white vertical line on black, not a cursor. Origin: a stale
   template from before. This is Phase 215+ work — investigate the
   `seedCursorTemplate` flow on the home screen and ensure the
   captured template actually shows the cursor. The cache has been
   wiped in this session; future runs should re-seed.
2. **Motion-diff has no animation to lock onto.** On the static
   home screen, the only moving thing should be the cursor. If
   the cursor doesn't actually move enough between pre/post frames
   (per-call cap is ~52 px on x-axis per Phase 206), motion-diff
   produces no candidate pair.

This is honest data: previous "50% click rate" measurements were
likely measuring against the App Switcher widget animation noise,
not real cursor detection.

## What the user should know

The state at v0.5.202 is:
- Mouse-click on small icons: **honestly unknown** — prior
  measurements were against the wrong UI; need re-bench on home
  screen with a fresh, correctly-seeded template
- Keyboard / Spotlight workflow: still works (Phase 210 unlock,
  Spotlight launch, sidebar arrow-key nav)
- Sidebar / large-button clicks: unchanged from prior matrix

## Next-phase candidate (Phase 215+)

1. **Investigate `seedCursorTemplate` on the home screen** — does
   the wake-and-capture actually capture the cursor pixels, or is
   it picking up text antialiasing on app names? If the template
   is contaminated, fix the extraction. Phase 102-106 chain dealt
   with this before; it may have regressed when the cursor got
   smaller / more transparent.
2. **Re-bench on home screen with fresh template** to get an HONEST
   click-rate baseline
3. **Update README/skill docs** to clarify that bench scripts must
   use `forceHomeViaSwipe: true` to ensure home-screen state

Each of these is a separate phase. Phase 214 itself is just the
unblocker — `ipadGoHome` now reliably reaches the home screen.

## Files affected this commit

- `src/pikvm/ipad-unlock.ts` — Phase 214 forceHomeViaSwipe
- `src/pikvm/__tests__/ipadGoHome.test.ts` — 4 new tests
- `src/pikvm/move-to.ts` — Phase 213 open-loop gate
- `package.json` + `src/version.ts` — v0.5.202
- `test-phase212-bench.ts`, `test-phase214-*.ts` — diagnostic
  scripts used in this investigation
- `docs/troubleshooting/2026-05-10-phase-214-app-switcher-root-cause.md`
  — this doc

## State summary

- 691/691 tests green
- nix build green at v0.5.202 (verified separately below)
- Cron 54c25dad recreated for the standing-instructions loop
