# Phase 300 — bigger wiggle amplitude (attempt + revert)

**Date:** 2026-05-13
**Status:** Attempted, measured, reverted. Doc-only commit. Same v0.5.231 behavior.

## Hypothesis

Phase 297/299's wiggle amplitude (25/-10 mickeys, ~38/-14 px movement) may be too small to escape iPadOS pointer-effect snap zones (~50 px around icon centers). When the cursor is pointer-snapped to an icon, a small emit doesn't move the visual cursor — snap pulls it back. Wiggle then sees the cursor "still there" after the emit and FALSELY rejects it as a static FP.

Bigger wiggle (50/-20 mickeys, ~70/-28 px) should exceed the snap radius, force the cursor to move, and let wiggle correctly accept real cursors on icons.

## Test

Doubled the wiggle to 50/-20 mickeys. Bumped to v0.5.232 in branch. Ran Phase 295 diverse-target bench N=10 × 2.

## Live results

| Target | Phase 299 v0.5.231 (25/-10 wiggle) | Phase 300 v0.5.232 (50/-20 wiggle) | Δ |
|---|---|---|---|
| Settings (905, 810) | 50% | **25%** (5/20) | **−25 pp** |
| Books (642, 810) | 5% | 10% (2/20) | +5 (variance) |
| TV (773, 810) | 5% | 5% (1/20) | unchanged |
| Maps area (1027, 660) | 0% | 0% | unchanged |

**Settings regressed by 25 pp** with bigger wiggle.

## Why bigger wiggle regressed

Probable explanation: the bigger emit displacement (70 px) means the inverse emit ALSO is 70 px. If px/mickey ratio is slightly off (it varies 1.3-1.5 in observation), inverse leaves the cursor 10-15 px drifted from initialPos. Reported position is initialPos, but actual cursor is at initialPos ± drift. Final residual is larger than reported.

Additionally, the bigger emit may push the cursor over an icon edge during wiggle, briefly triggering iPad's icon-hover effect, which animates pixels in a way that confuses the post-wiggle re-detect.

Either way, the data is clear: 25/-10 wiggle (Phase 297/299) is the better operating point.

## Action

Reverted wiggle amplitude to 25/-10. Code now functionally identical to v0.5.231. Version unchanged (no shipped behavior diff).

## State at end of phase

- v0.5.231 remains the current build (Phase 299 with 25/-10 wiggle).
- Settings target: 30-50% honest variance band sustained.
- The wiggle amplitude tuning landscape has now been explored: 25-mickey is the sweet spot.

## Lesson

The smaller wiggle's "false-negative on pointer-snapped cursor" hypothesis is wrong, or at least the costs of bigger compensation outweigh the benefit. Pointer-snapped cursors likely DO move with 25 mickeys (snap zone is smaller than I assumed, or snap isn't a hard lock). Whatever Phase 297/299's 50% Settings success path is, doubling the wiggle doesn't extend it.

This is the 4th explicitly-listed "future improvement" (wiggle amplitude tuning) — tried and confirmed not to help. The other 3 (Reduce Motion accessibility, smaller emit chunks, cursor-belief unstick) remain user-direction items.
