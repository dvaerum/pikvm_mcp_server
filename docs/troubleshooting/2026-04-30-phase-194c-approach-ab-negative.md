# Phase 194-C — preClickApproachMickeys A/B (NEGATIVE result)

**TL;DR.** Hypothesis: bumping `preClickApproachMickeys` from
10 → 20 would give iPadOS pointer-effect a clearer
"moving-into-icon" velocity signal at click time, lifting click
rate. Result: **the opposite — approach=20 was 80 % vs 90 % for
approach=10** (5 trials × 2 targets each). Plus one approach=20
trial visually opened **Firefox in the dock** at residual = 5 px
algorithm-reported — i.e. the click landed ~360 px from the
algorithm's claimed cursor position. Default stays at 10.

## Setup

`bench-approach-ab.ts` (new): 5 trials per (target, magnitude) cell.

- Targets: Settings (905, 800), Books (640, 800)
- Magnitudes: 10 (Phase 143 default), 20 (this experiment)
- Else identical to `bench-click-extensive` (verifyOptions region
  100×100, minChangedFraction=0.05, maxRetries=3)

## Results

```
approach | target   | hits | rate  | median residual
---------+----------+------+-------+----------------
   10    | settings |  4/5 |  80 % |        133 px
   10    | books    |  5/5 | 100 % |        139 px
   20    | settings |  4/5 |  80 % |         23 px
   20    | books    |  4/5 |  80 % |        225 px

Cumulative:
  approach=10: 9/10 = 90 %
  approach=20: 8/10 = 80 %
```

## Visual verification

`data/approach-ab/settings-ap20-01-hit.jpg`: approach=20 trial 1
shows **Firefox homepage** (browser opened, not Settings).
Algorithm reported residual = 5 px from Settings target. Visible
cursor in screenshot: bottom-left dock area near the Firefox
icon. The click event landed ~360 px from where the algorithm
claimed the cursor was.

This single trial demonstrates a problem deeper than detection
or velocity tuning: PiKVM's internal HID cursor position appears
to desync from iPadOS's rendered cursor position. The algorithm's
reported residual is the iPadOS-rendered-cursor's distance from
target, but the actual click event fires at PiKVM's internal
cursor position.

If this hypothesis is right, the fix is on the relative-mouse
emit-tracking side, not on velocity tuning or pointer-effect
hacks.

## What this rules out

- Phase 143's premise (cursor velocity drives snap-zone
  engagement) is not the missing factor at the documented
  reliability ceiling. Bumping velocity made things worse.
- preClickApproachMickeys default of 10 is correct. Don't ship
  the bump.

## Phase 194-D candidate (next iteration)

Investigate **PiKVM internal cursor position vs iPadOS rendered
cursor position** desync:

1. Add `client.lastInternalPosition` tracking — sum of all
   `mouseMoveRelative` (dx, dy) emits since last reset, clamped
   to bounds.
2. After moveToPixel, compare `client.lastInternalPosition` to
   `lastMoveResult.finalDetectedPosition` (the iPad-rendered
   cursor). The gap is the PiKVM ↔ iPad cursor desync.
3. If the gap is large and consistent, the fix is to slam to a
   known position (e.g. (0, 0) via large negative emit) before
   each click attempt to re-sync, then move-to-target via small
   chunks.

The Phase 32 ban on absolute-mode slam-fallback is for SAFETY (it
re-locks iPad). A cleaner approach: emit a large negative
relative move (e.g. mouseMoveRelative(-127, -127) ×4) to slam to
top-left WITHOUT triggering iPadOS lock-screen behaviour, then
proceed.
