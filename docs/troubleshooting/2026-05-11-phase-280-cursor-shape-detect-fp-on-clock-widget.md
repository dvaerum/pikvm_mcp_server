# Phase 280 — diagnostic: clock-widget FP defeats cursor-shape-detect

**Date:** 2026-05-11
**Version:** v0.5.225 (no code change — diagnostic only)
**Status:** Root cause of Phase 279 far-target 0% identified. NOT
what we expected.

## What we expected to find

Phase 279 frame-by-frame inspection showed the cursor visually
absent from the final pass of failing trials. We hypothesised one
of: stationary fade, edge clamp, or dock-icon snap. Phase 280
designed a diagnostic to identify which.

## What we actually found

Built `test-phase280-cursor-vanishing-diagnostic.ts`: home + drift
cursor leftward via 30 small chunks while screenshotting and running
`findCursorByShape` (unhinted) on every frame. Ran twice — once
without wake-nudge, once with (matching production
`takeRawScreenshot`).

The cursor was **never missing** from the detector's output — but
the detector was **lying** in most frames.

For ~80% of frames the detector returned `(628, 149)` with score
1.5-1.9 — **that's the clock-widget face**, not the cursor. The
actual cursor was elsewhere on screen (or sometimes off-screen, but
the clock won regardless).

Cursor-shape-detect's `findCursorByShape` (unhinted entry point)
silently picks high-confidence false positives on iPad UI widgets.

### Score profile

| Source | Typical score |
|---|---|
| Clock widget (FP) | **1.5-1.9** (very stable) |
| Real cursor over icon | 2.5-3.5 (sometimes) |
| Real cursor over wallpaper | 0.3-0.5 (often) |

The actual cursor's score depends on what's behind it — over dark
icons it stands out (high score), over similarly-coloured wallpaper
it blends in (low score). The clock widget's score is **stable** at
1.5-1.9 across all frames. So in any individual frame where the
cursor happens to score low, the clock wins.

### Frame evidence (run 2026-05-11_19-05-45, wake-on)

| Frame | Reported | Score | Pixels | Actual situation |
|---|---|---|---|---|
| f023 | (733, 777) | 2.919 | 71 | **Real cursor at ~(733, 770)**, visible above TV icon |
| f024 | (719, 777) | 0.326 | 70 | Real cursor still there, score dropped |
| f025 | (618, 260) | 0.334 | 58 | Detector picked clock area |
| f033 | (627, 149) | 1.63  | 76 | **Clock face**, real cursor invisible / off-screen |

The detector found the real cursor in f023 (great), then in f024 the
same cursor scored 0.326 (still detected, but barely), then in f025
the detector switched to a different (wrong) cluster.

## Why this explains Phase 279's far-target 0%

The far-target failures showed mis-landings clustered at:
- `(852, 941)` / `(852, 942)` — TV icon / dock area
- `(772, 951)` / `(773, 952)` — Books-vicinity in dock row
- `(786, 676)` — wallpaper above icons
- `(724, 316)`, `(746, 290)` — widget area

These are NOT random — they're stable false-positive matches on
iPad home-screen elements. Every time the real cursor scored low
(over wallpaper or partially-occluded), one of these stable FPs won.

The cursor was **not actually vanishing**. It was being **out-voted
by stable widget FPs**.

## Why the proximity gate (Phase 276) doesn't save us

Phase 276 rejects shape candidates with `score < 0.05 AND
distance > 30 px from newPredicted`. But the FPs all score
**well above 0.05** (typically 1.5+), so the score check passes.
The distance check would catch them only if the predicted cursor
position is accurate. After 1-2 bad detections in a row, the
predicted position drifts away from reality, and the gate stops
gating.

## What this rules out

- ~~Stationary fade as primary cause~~ — wake-nudge screenshots
  show the same FPs, so this isn't a fade problem.
- ~~Edge clamp / off-screen drift~~ — at f023 the cursor was
  visibly mid-screen and detector found it, then lost it in the
  next frame.
- ~~"cursor-shape-detect at production ceiling"~~ — the detector
  has a clear bug: it accepts high-score widget FPs without
  validating they're cursor-shaped.

## What this points at

The detector needs **cursor-vs-widget discrimination** beyond what
the current heuristics provide. Three plausible directions:

1. **Widget-region blacklist.** Reject candidates inside known iPad
   home-screen widget regions (top-left clock at ~(480-770, 60-260),
   weather widget at ~(580-820, 350-590), etc). Simple, deterministic,
   covers the most painful FPs. Cons: brittle (different iPad layouts,
   different apps in foreground would need their own lists).

2. **Improved cluster discriminator.** The clock face is a multi-stroke
   shape (hands + numbers + ring) while the cursor is a single
   arrowhead. Add a "stroke count" or "linearity" feature to the
   composite score. More general, harder to tune.

3. **Cross-frame consistency.** A real cursor moves between frames
   in predictable directions matching the recent emit. A widget FP
   stays at a fixed position. Require a candidate to MOVE between
   frames (or stay within a predicted radius) to be accepted as
   cursor. Requires moveToPixel to pass two consecutive frames into
   the detector, not just one.

## State at end of phase

- v0.5.225 (unchanged)
- 713/713 tests
- nix build green
- This phase: bench `test-phase280-...ts`, 102 frames captured
  across 2 runs, this doc

## What this is NOT

This phase ran the diagnostic the user explicitly asked for in chat.
The findings produce a clear next-step recommendation but do NOT
ship code. Per the cron rule "do not pivot strategies without
explicit user direction", the next phase (fix selection) waits on
user input.
