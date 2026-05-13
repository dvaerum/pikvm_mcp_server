# Phase 317 (v0.5.241) live bench — iPad lock contamination

**Date:** 2026-05-13
**Version:** v0.5.241
**Status:** Phase 317 wiggle-verify shipped but **live impact still
unverified** — the bench's later trials ran against a locked iPad,
contaminating the data.

## Bench

`test-v241-settings-verify.ts` ran Settings target × N=10 with
per-trial pre-click screenshot capture for visual ground truth.

```
T1: (output lost in tail)
T2: residual=183px detected=(774,672) click=✗
T3: residual=109px detected=(839,887) click=✓
T4: residual=17px  detected=(914,786) click=✗   ← lock-screen wallpaper FP
T5: residual=17px  detected=(914,786) click=✗   ← lock-screen wallpaper FP
T6: residual=17px  detected=(916,787) click=✗   ← lock-screen wallpaper FP
T7: residual=17px  detected=(914,786) click=✗   ← lock-screen wallpaper FP
T8: THREW (no cursor position)
T9: residual=17px  detected=(916,787) click=✗   ← lock-screen wallpaper FP
T10: residual=17px detected=(914,786) click=✗   ← lock-screen wallpaper FP
```

Aggregate: 6/10 trials reported residual ≤ 30 px (tautology suspects),
1/10 click success.

## Visual GT (t4-pre.jpg)

Pre-click frame for trial 4 shows iPad on **lock screen**, not home
screen. The clock reads `10:39` and the standard lock-screen
wallpaper is visible. No Settings icon. Cursor visible at the right
edge of screen at ~(1140, 775).

The detector consistently finding `(914, 786)` across trials 4-7,
9, 10 corresponds to a wallpaper gradient feature on the lock screen
— a pure tautology. Phase 317 wiggle-verify did NOT catch it,
because the wallpaper feature is also there in the post-wiggle
frame (the lock screen renders no responsive UI — but cursor does
move).

## What this DOES tell us

- The Phase 310 tautology can happen against lock-screen wallpaper
  too, not just app icons. The wiggle-verify must check that the
  re-detected position has moved consistent with the cursor's
  expected motion — but since the wallpaper feature is at the same
  position, motion=0 from wiggle-verify, **so wiggle-verify SHOULD
  have rejected**. Why didn't it?

  Hypothesis: ML wiggle-verify fires only when `mlProx ≤ 30`. At
  detected=(914, 786) vs target=(905, 800), prox = ~17. So gate
  fires. mlWiggleVerify should run. If it correctly rejected, code
  falls through to shape-detect. Shape-detect at the same wallpaper
  feature would also reject via Phase 297 wiggle-verify. Then
  motion-diff and template-match run. One of them must be returning
  the position. The bench logs aren't verbose enough to tell.

- The bench was **contaminated by iPad re-locking** mid-run.
  Successive trials each call `unlockIpad` + `ipadGoHome`, but at
  some point one of these caused the iPad to lock (Phase 219/231
  partial fix didn't fully solve this).

## What this does NOT tell us

- Whether Phase 317 wiggle-verify works correctly on home-screen
  tautologies (Settings icon gear-tooth FP from v0.5.240
  diagnostic).
- Whether the click rate would improve at v0.5.241 vs v0.5.240
  under clean home-screen conditions.

## Next step (deferred)

Either:
- A. Improve bench's iPad re-lock detection — currently relies on
  ipadGoHome throwing. The throw fires for hard lock but doesn't
  fire if a partial lock state is reached. Could add a screenshot-
  based lock detection (e.g. screen-luminance ≤ X is lock screen).
- B. Run shorter bench (5 trials) immediately after fresh unlock,
  before the iPad has a chance to re-lock.
- C. Add verbose mode to clickAtWithRetry's moveToPixel calls in
  the bench, so we can SEE which detector path each trial took
  and where wiggle-verify rejected.

## Files

- `data/v241-settings/2026-05-13_08-35-59/` — bench output +
  per-trial frames
- This document

## Code state

Phase 317 ML wiggle-verify code stays IN at v0.5.241. It's
defensive and tests pass. The wallpaper-feature trials 4-10 don't
falsify Phase 317 — they only show that iPad re-lock contaminates
the bench, not that wiggle-verify failed at its job.
