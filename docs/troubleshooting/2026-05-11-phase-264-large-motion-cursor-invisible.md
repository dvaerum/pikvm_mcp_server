# Phase 264 — large-motion verification: cursor invisible in test frames

**Date:** 2026-05-11
**Version:** v0.5.220 (no production change)
**Status:** Phase 260 motion verification failed at 50 px because
clock widget noise overwhelmed cursor signal. Phase 264 tried at
200 px to make cursor motion dominate. Result: 2/5 trials had
high-confidence pick margin > 100k, but **visual inspection shows
no cursor in the test pre-frames** — the test bench's
pre-position emit is putting the cursor in a position that's
either clamped off-screen or outside the HDMI capture window.

Phase 264 verification IDEA is sound; the test harness has a
cursor-visibility bug that masks whether the idea works.

## Bench result

```
trial      | pick (x, y)    | local diff | runner-up  | margin
big-right  | (627, 153)     |     55,135 |     32,415 | 22,720
big-down   | (627, 153)     |    911,467 |    765,231 | 146,236
big-left   | (614, 269)     |    923,750 |    847,575 | 76,175
big-up     | (611, 253)     |    673,893 |     24,724 | 649,169
big-diag   | (1133, 965)    |     18,727 |     17,465 |  1,262
```

All picks landed in widget/dock regions, not cursor positions.

## Visual confirmation: cursor not visible

Trial 2 pre-frame
`data/phase264-large-motion/<run-id>/t2-pre.jpg` shows:
- iPad on home screen, clock reading 08:34
- NO visible cursor anywhere on the iPad screen

The bench's 4 × (60, 40) pre-position emits drove the cursor
either off-screen or to a position not visible in the HDMI capture.
With no cursor visible, the shape detector candidates are all
widget/dock features. Picking the "highest-motion-diff" among them
identifies widgets that animated during the 1+ second wiggle
interval (clock minute hand, etc.).

This is the SAME problem class as Phase 254: chunked-emit
pre-position not landing the cursor in a visible mid-screen area.

## What the result does NOT tell us

We CAN'T conclude that "200 px motion verification doesn't work"
from this run. The hypothesis is untestable when the cursor isn't
in the frame.

## Next-phase candidates within the cursor-shape-detect plan

1. **Fix the pre-position emit first.** Land the cursor at a
   known mid-screen position visible to the camera, THEN run the
   200-px motion verification. Iterate the pre-position until the
   bench script's t1-pre.jpg consistently shows a visible cursor.

2. **Use cursor-belief.position as a sanity check.** If belief
   says cursor is at (x, y) but no shape candidate scores high
   anywhere near (x, y), the cursor is either clamped or off-camera.
   Diagnose before testing detection.

3. **Capture a SINGLE post-emit frame and check it manually first**
   before running the multi-trial bench. Confirm the cursor is
   where we think it is. Then bench.

## State

- v0.5.220
- 713/713 tests
- nix build green
- Bench script `test-phase264-large-motion.ts` retained
- Trial frames at `data/phase264-large-motion/<run-id>/`
