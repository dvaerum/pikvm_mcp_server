# v0.5.240 — Phase 310 tautology returns; "95% detection" claim corrected

**Date:** 2026-05-13
**Version:** v0.5.240
**Status:** Honest correction of inflated detection-rate claim. **Click
rate is honestly ~0% on icon-sized targets, not 15%.**

## What I claimed earlier

In the v0.5.240 multitarget bench writeup (commit `034c641`) I
reported:

> Detection: 19/20 (95%)
> Click:      3/20 (15%)

I called this a "verified detection lift" across diverse targets.

## What's actually happening

A focused 12-trial visual diagnostic on the Settings target captured
pre-click + post-click frames for every trial. Visual inspection
shows:

- **t1, t3 (both reported residual=19 px):** cursor visibly at ~(1060,
  838) and ~(1158, 908) — that's **155–270 px from Settings icon at
  (905, 800)**. Algorithm reported residual=19 px = false. Post-click
  frames are identical to pre-click — Settings did not open.
- **t2 (reported residual=186 px):** cursor location varies, click
  failed.
- All 4 click-variant configurations (baseline, settle300, settle500
  + downMs 300/500) failed to register clicks on Settings.

The detector is reporting positions inside the Settings icon, but
**the cursor is not there**. This is **the Phase 310 tautology
re-emerging**: when cursor is absent or far from target, the
detector matches an icon feature (gear teeth, glyph) and reports it
as the cursor.

The home-zone multi-hint added in Phase 315 (v0.5.239) makes this
WORSE for some targets: the home-zone crop at
`(width × 5/8, height × 3/4)` lands on icon territory
(dock + bottom-row apps), so the ML model is fed crops with
distinctive icon features instead of cursor pixels.

## Honest detection rate

The "19/20 detected (95%)" headline mixes two things:

| Type | What it means | Trial 5/5 in bench |
|---|---|---|
| Algorithm-reports-a-position | Detector emitted a coordinate | 19/20 |
| Position-matches-real-cursor | Coord ≈ where cursor actually is | **Unknown — needs per-trial visual ground truth** |

We can't separate these without saving the pre-click screenshot for
every bench trial and visually inspecting. The 5 "cursor dead-on icon
at residual ≤ 20 px" cases that I called "Phase 310 tautology
suspects" were almost certainly tautological — confirmed by today's
diagnostic.

## Honest click rate

Of the 20 trials in the v0.5.240 multi-target bench:

- 3 reported "click=✓" via screenChanged
- The 3 successes had residuals 70, 129, 147 px — likely background
  clicks (Spotlight, dock area), not target-hits
- The 5 "residual ≤ 20 px" trials were tautologies — cursor not
  actually on target; clicks fired wherever-detector-said and missed

**Verifiable target-hit rate: 0–1 out of 20**, not the 3/20 (15%)
I quoted.

## What went right

The Phase 316 (v0.5.240) default belief bounds **DID** fix the
belief.position off-screen drift. The diagnostic confirmed
`belief.position = (726.7, 713.7)` after unlock+home (instead of
the v0.5.238 -3051, -4130). That part of the fix is real and useful.

What didn't follow: a stable belief.position doesn't help if the
ML detector returns confident-wrong answers on home-zone crops that
contain icons.

## The actual problem chain

1. iPad rate-limits big emits → cursor doesn't reach target.
2. Cursor parks somewhere off-target (often home zone, but not
   always exactly at the home-hint coordinate).
3. ML model evaluates 1-3 crops (predicted, belief, home-zone).
4. None of the crops cover the actual cursor location.
5. Each crop has SOME high-confidence "thing" inside — the model
   confidently picks an icon feature.
6. `findCursorByMLMultiHint` returns the highest-confidence pick.
7. The algorithm reports a residual matching the false-positive
   position.
8. Click fires where the lie says, lands on wallpaper or wrong icon.
9. ScreenChanged=false. Trial counted as failure but "detection
   succeeded" — actually it didn't.

## What this means going forward

The v0.5.240 detection improvements over v0.5.237 are at best
**partial**: they help when cursor DOES reach near target. They do
NOT help when cursor is parked elsewhere and the detector tautologies
onto an icon.

The honest detector accuracy is binary per-trial:
- Cursor in some ML crop → real detection (estimated ~50%)
- Cursor not in any crop → tautological detection on icon (~50%)

The fix needs to be at the **verification** level, not the
**hint-placement** level:

A. **Wiggle-verify ML detections** before accepting them. The
   heuristic shape detector already does this (motion-verify path).
   ML detector currently does NOT verify, just returns whatever the
   heatmap says. Adding "emit small wiggle → re-detect → require
   detected position to move by emit amount" would catch tautologies.

B. **Lower confidence threshold + multi-crop voting**. If ML is
   confident at multiple non-overlapping crops, only one can be the
   real cursor. Pick the one closest to recent belief OR use a
   per-crop confidence ratio.

C. **Train ML on harder data**: explicit "cursor absent" frames
   labeled correctly, and frames with icon-near-cursor.

D. **Use shape-detect as cross-check on ML**: Phase 268 (now
   superseded) did this for NCC matches. Re-applying for ML.

## What I'm shipping this tick

Just this honest correction. No code changes — running another bench
won't change the conclusion. The right fix needs design work
(option A: ML wiggle-verify) which is a separate task.

## Files

- `data/v240-click-diag/2026-05-13_08-21-04/` — pre/post frames for
  12 trials × 4 click variants. Visually inspectable.
- This document.
