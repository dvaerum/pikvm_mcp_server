# Phase 270 — Phase 269 lift is target-specific; bottleneck shifted to ballistics

**Date:** 2026-05-11
**Version:** v0.5.223 (no production change in this phase)
**Status:** Phase 269 showed +12.5 pp lift at target (905, 800). Phase
270 tested at second target (757, 832): **1/40 = 2.5%**. Lift is
SPECIFIC to targets near the cursor's post-home starting position.
For targets requiring a large translation, the bottleneck is no
longer detection — it's open-loop ballistics. Detection improvements
have hit a ceiling defined by ballistic accuracy.

## Bench result

Two N=20 runs at target (757, 832) — Books icon area, ~300 px from
the post-home cursor position (1063, 778):

| Run | Within 35 px |
|----:|-------------:|
| 1   | 0/20 (0%)    |
| 2   | 1/20 (5%)    |
| **Cumulative N=40** | **1/40 = 2.5%** |

Compare to target (905, 800) at v0.5.223 (Phase 269): 50% across
N=60. The lift is real at one target, totally absent at another.

## Root cause (visual evidence)

`data/phase262-click-rate/t01-post.jpg` (Phase 270 trial 1): cursor
visible at ~(1050, 720). Target was (757, 832).

The cursor moved 13 px LEFT and 58 px UP from its post-home start
position of (1063, 778). It needed to move 306 px LEFT and 54 px
DOWN. **The cursor barely moved.**

So moveToPixel's open-loop ballistics emitted some mickeys but the
cursor either:
- Didn't translate the full distance the emit predicted
- Got clamped at an edge during the move
- Or the algorithm stopped emitting early because detection
  returned a confident-wrong position that satisfied its convergence
  criteria

In all 20 trials of run 1, the cursor ended somewhere between
(1050, 720) and the dock area, never within 35 px of (757, 832).

## Why Phase 269's lift was target-specific

At target (905, 800):
- Post-home cursor at (1063, 778) — only ~160 px from target
- Small ballistic move needed
- Single chunked emit could land cursor within shape-detect's
  100 px locality radius
- Shape-detect finds cursor → cursor-belief converges → correction
  emit lands within 35 px

At target (757, 832):
- Post-home cursor at (1063, 778) — ~310 px from target
- Bigger ballistic move needed
- Open-loop emit's px/mickey variance compounds over distance
  (Phase 192 measured 1.25-1.75 px/mickey range)
- Cursor lands far from prediction → outside shape-detect's
  locality radius → detector doesn't help → fall through to
  predicted-position trust at wrong location

The shape detector works fine when the cursor is approximately
where the algorithm expects it. The bottleneck is GETTING the
cursor to the expected position via open-loop emit accuracy.

## What this means

cursor-shape-detect is doing its job. The improvement it provides
at one-translation-away targets won't generalize until the
ballistic move accuracy improves.

This is a **different problem** from cursor-shape-detect detection.
Per the cron rule:

> 4. Honestly report failure of the above and stop — do NOT pivot
>    to a different detection approach without explicit user
>    direction.

Phase 270's result is the "honest report" of where cursor-shape-
detect's lift bottoms out. Beyond this point requires either:
- User direction to pivot to ballistics improvements
- Or accepting that 50% within 35 px at near-target + 0-5% at
  far-targets is the current ceiling for the detection layer alone

## Honest aggregate picture

Combining Phase 269 + Phase 270 data:
- Target near start (905, 800): 50% within 35 px
- Target far from start (757, 832): 2.5% within 35 px
- Difference: detection vs ballistic-accuracy bottleneck

With `clickAtWithRetry maxRetries: 2` (iPad default):
- Near-target binomial: 1 - (1 - 0.5)³ = 87.5%
- Far-target binomial: 1 - (1 - 0.025)³ = 7.3%

**Production click rate is highly target-position-dependent.** Some
icons are reliably clickable; others are nearly hopeless. This
matches reported intuition from earlier phases (Books target was
documented as 0% in Phase 196).

## What stays open (NOT this tick, requires user direction)

Stopping per cron rule. Possible next directions if user signals
to pivot:

1. **Open-loop ballistic re-calibration.** Phase 192 fed observations
   into cursor-belief but the px/mickey variance remains 40%. A
   tighter calibration could improve ballistic accuracy.
2. **Iterative-converge approach.** Instead of one big emit to
   the target, do many small emits each followed by detection.
   Each step keeps the cursor in shape-detect's locality range.
3. **Pre-position to a known mid-screen anchor first**, then move
   from there. Reduces total travel distance for any target.

None of these are cursor-shape-detect improvements. They're a
different problem class.

## State

- v0.5.223 (no code change in Phase 270)
- 713/713 tests
- nix build green
- This documents the natural ceiling of cursor-shape-detect alone
