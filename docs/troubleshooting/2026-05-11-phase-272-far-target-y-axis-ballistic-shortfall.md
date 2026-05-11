# Phase 272 — far-target failure is Y-axis ballistic shortfall, not detector miss

**Date:** 2026-05-11
**Version:** v0.5.223 (no code change)
**Status:** Verbose-logged moveToPixel runs at far target (757, 832)
reveal the detector IS working — cursor lands at (~773, 766) which
is only 67 px from target. The Phase 270 "barely moved" reading was
wrong. The actual failure mode is a Y-axis emit shortfall: cursor
stops in the wallpaper GAP above Books icon (y=766 vs target y=832).

## What was measured

`test-phase272-verbose-far.ts`: 3 trials of moveToPixel to (757, 832)
with `verbose: true`. Captured pass diagnostics + final detected
position per trial.

## Per-trial pass-by-pass results

```
Trial 1:
  pass 0 mode=motion  detected (782, 958)  residual=128 px
  pass 1 mode=shape   detected (774, 960)  residual=129 px
  pass 2 mode=motion  detected (876, 316)  residual=530 px
  final: (774, 960)  residual 129 px

Trial 2:
  pass 0 mode=motion  detected (771, 766)  residual= 67 px
  final: (771, 766)  residual  67 px

Trial 3:
  pass 0 mode=motion  detected (774, 766)  residual= 68 px
  final: (774, 766)  residual  68 px
```

## Reading the data

### Trials 2 and 3: detector is working

Both trials had pass 0 motion-diff find cursor at ~(773, 766) —
67-68 px from target (757, 832). Specifically:
- X axis: off by 14-17 px (cursor at 771-774, target 757)
- Y axis: off by 66 px (cursor at 766, target 832)

The cursor IS being detected at its actual landing position. The
67-68 px residual is a real spatial offset of the cursor on
screen — not a detector miss.

**Position 766 is the gap between icon rows.** On this iPad's home
screen, the third icon row (Home, Camera, App Store, Games) sits at
roughly y=680, and the fourth row (Books, TV, Settings) at y=830.
y=766 is in the wallpaper gap between them. So the cursor moved
the X distance (1063 → 773 = 290 px LEFT) but the Y emit fell ~66 px
short of the descent.

### Trial 1: confident-wrong dock area pick

Pass 0 motion-diff picked (782, 958). Pass 1 shape-detect agreed at
(774, 960). Both detectors saw "cursor" at y=958, which is the
DOCK ROW area, not where the actual cursor should be.

Possibilities:
- Cursor briefly visited the dock during the emit chain and stayed
  there
- Motion-diff caught dock icon animation (Mail, Messages badges)
  and shape-detect agreed because the dock icons are dark/small/
  asymmetric just like cursors
- Some open-loop overshoot drove cursor into the dock

This is a known correlated-failure mode between motion-diff and
shape-detect (Phase 268 cross-check attempted to use shape to
override NCC, but shape and NCC share blind spots on dark icons —
same root cause here).

## What this means for cursor-shape-detect

The detector is **doing its job**:
- Trial 2/3: motion-diff (which fired in pass 0) accurately reported
  the cursor's actual landing position within 67-68 px of target
- Trial 1: both detectors confident-wrong, but with the same answer
  (so even a cross-check between them wouldn't catch it)

**The 35 px click tolerance isn't met because the cursor physically
lands ~66 px short on Y.** That's an open-loop ballistic issue:
moveToPixel emitted enough X mickeys to translate ~290 px LEFT but
the Y emit only carried the cursor ~12 px DOWN instead of ~78 px DOWN.

## Phase 270's interpretation was wrong

Phase 270 said "cursor moved 13 px LEFT and 58 px UP from start" —
that was based on a single visual inspection of trial 1's frame.
But trial 1 was the outlier where motion-diff picked dock area.
Trials 2 and 3's data shows the cursor genuinely moved ~290 px LEFT
and ~12 px DOWN. The X-axis ballistics work; the Y-axis is short.

## Where this leaves cursor-shape-detect

- **Detector functionality**: working as designed (Phase 269 lift confirmed)
- **Near targets**: 50% within 35 px (Phase 269 N=60)
- **Far targets**: detector still finds cursor; 35 px tolerance not
  met because of ballistic Y-axis shortfall, not detector error

Improving the click rate at far targets does NOT require detector
work. It requires either:
1. Open-loop Y-axis ballistic calibration (Phase 270's deferred work)
2. Iterative chunk-and-detect cycle so corrections fix the Y-axis
   shortfall via post-emit detection
3. A larger Y-emit on the open-loop phase

None of these are cursor-shape-detect changes. Per cron rule
"do NOT pivot to a different detection approach without explicit
user direction," not implementing without that direction.

## Trial 1's dock-area pick is the only true detection failure

Even in trial 1, both detectors (motion-diff + shape) agreed on the
same wrong answer. They share blind spots (dark icons can look like
cursors). Phase 268 already explored a shape-NCC cross-check and
found it didn't help, for this same reason.

The remaining detection improvement available — distinguishing
real cursor from dock icons when both detectors see "cursor-like"
features there — is not something parameter tuning or wider locality
gates will fix. It would require a structurally different signal
(temporal coherence across multiple frames, cursor-belief variance
gating, ML-based shape classification).

## Honest summary at v0.5.223

- cursor-shape-detect detector: tuned correctly (Phase 271)
- shape-detect integration: production-ready as fallback (Phase 267,
  269)
- Near-target click rate: 50% single-attempt (Phase 269)
- Far-target click rate: limited by open-loop Y-axis ballistic
  accuracy (~66 px shortfall), not by detector
- Open dead-ends within cursor-shape-detect:
  - Tighter chroma penalty: cosmetic only (Phase 271)
  - Cross-check on NCC: correlated failure modes (Phase 268)
  - Larger locality radius: would let in more false positives
    (Phase 259-260)

The cursor-shape-detect work has reached its natural production
ceiling. Per cron rule 4, honest report shipped, stopping pivots.

## State

- v0.5.223 unchanged
- 713/713 tests
- nix build green
- This phase: diagnostic + doc only
