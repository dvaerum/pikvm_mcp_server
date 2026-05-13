# Phase 311 — radial cluster-density penalty

**Date:** 2026-05-13
**Version:** v0.5.235
**Status:** Shipped. Suppresses icon-internal-feature FPs which sit
in dark-cluster-dense neighborhoods.

## Diagnosis (Phase 310 finding)

When the cursor is absent from the frame and the target icon has
internal dark features (Settings gear teeth, Books/TV/AppStore
glyphs, label-text under icons), the detector reports a small-
residual "cursor" position that's actually an icon-internal cluster.
This is tautological: any frame with the target icon produces an
"OK" classification — but no actual cursor was detected.

## Improvement

Added a third penalty in `findAllShapeCandidates`:

```typescript
// For each cluster, count similar-sized clusters within 50 px radius
const densityCounts: number[] = ...;
const penalty = Math.exp(-densityCounts[i] / 2);
candidates[i].shapeScore *= penalty;
```

Distinguishing context:
- Real cursor on wallpaper: 0-1 nearby dark clusters → no penalty
- Icon internal (gear teeth, glyph strokes): 4-8 nearby dark
  clusters → strong penalty

Penalty table:
| neighbors within 50 px | factor |
|------------------------|--------|
|         0              | 1.00   |
|         1              | 0.61   |
|         2              | 0.37   |
|         3              | 0.22   |
|         5              | 0.08   |

## Replay verification on Phase 305 frame a1

After all three Phase 307+308+311 penalties:

| rank | position    | pixels | score (Phase 308) | score (Phase 311) | Δ |
|------|-------------|--------|--------|----------|---|
|   1  | (619, 261)  |  76    | 0.131 | 0.077  | calendar widget (isolated, weaker penalty here) |
|   2  | (784, 962)  |  68    | 0.144 | 0.026  | dock-edge, density penalty fires |
|   3  | (1115, 965) |  70    | 0.147 | 0.020  | dock-edge, **-86%** |

Both dock features (top-2 and top-3 in Phase 308) are now demoted
to bottom of top-3. Calendar widget remains top-1 globally (it's
isolated in its neighbourhood) but at score 0.08 — very low.

Production locality gate around target (642, 810) at radius 100 px
filters all of these out. Only candidates within 100 px of target
matter; for r2_Settings_03 the cursor-absent case still picks a
target-internal feature (label-text strip at 226 px filtered by
sizeFit → score 0).

## Unit tests

Added Phase 311 test: 12 cursor-sized clusters in a dense 4×3 grid
+ 1 isolated cursor 240 px away. Asserts isolated cursor outscores
grid-member by ≥ 3×.

All 22 cursor-shape-detect tests pass (1 new). Full suite: 727/727
+ 1 = 728/728.

## Honest live-impact prediction

Phase 311 is a detection-correct improvement that should reduce
the rate of cursor-absent-but-OK false positives. But because:

1. Phase 310 showed many "OK at 7 px" cases were tautological
   (cursor absent, icon-internal feature picked)
2. Phase 311 suppresses icon-internal features
3. The bench's "OK" criterion was the same icon-internal pixels
   that scored OK by accident

… **the bench's OK rate will likely DROP after Phase 311**, because
the icon-internal feature is now properly suppressed and the
detector now correctly returns NULL or low-score for cursor-absent
frames.

A drop in OK rate after Phase 311 is HONEST — it reflects the
detector no longer claiming "I found a cursor" when there isn't
one. The pre-Phase-311 OK rate was misleading.

## What this means for click rate

Phase 311 will likely reduce wrong-app clicks (because tautological
OK + click on icon was sometimes opening the right icon by luck,
but the cursor wasn't actually there — iPad might respond
differently than expected). It won't increase RIGHT-app clicks
unless the cursor is actually visible in the frame.

The upstream bottleneck (cursor visibility) is unaddressed.

## State at end of phase

- v0.5.235 shipped (commit pending).
- 728/728 tests pass; typecheck clean.
- Three detection penalties now active:
  - Phase 307 co-linearity (horizontal text rows)
  - Phase 308 bright-background (white widget cards)
  - Phase 311 radial density (icon internals)
- All Phase 251 saved frames still detect cursor within 30 px (5/5).
- Memory will be updated.
