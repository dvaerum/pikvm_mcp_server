# Phase 265 — cursor-shape-detect IS working; Phase 259/264 bench harness was broken

**Date:** 2026-05-11
**Version:** v0.5.220 (no production change)
**Status:** Phase 257-264 reported "shape detector doesn't work in
diverse positions." Phase 265 visual diagnostic shows the
**detector finds the cursor reliably with high confidence when
the cursor is visible**. The earlier failures were
the bench harness driving the cursor off-screen with rightward
pre-position emits.

## What the diagnostic showed

`test-phase265-cursor-position-diag.ts` takes 5 screenshots
through the unlock → home → settle → wake sequence and runs
unhinted shape detection on each:

```
F1 post-unlock:         (1108, 982) score 0.33  (dock area noise)
F2 post-home:           (1150, 777) score 1.87  ← cursor!
F3 after 1.5s settle:   (1150, 777) score 1.91  ← stable
F4 after (10,10) wake:  (1157, 784) score 2.58  ← shifted by emit
F5 after (100,100):     ( 618, 260) score 0.33  ← cursor pushed off
```

## Visual confirmation

`data/phase265-cursor-position/<run-id>/F4-tiny-wake.jpg` shows a
small dark arrow cursor at the right edge, between Settings and
the right boundary, at approximately (1157, 784). EXACTLY where
shape detector reported it. Score 2.58 vs the 0.33 noise floor =
huge confidence margin.

## What this changes

The Phases 257-264 conclusion ("cursor-shape-detect needs better
discriminator, doesn't work alone on diverse positions") was wrong.
The detector DOES work — the bench harnesses just weren't keeping
the cursor in the frame.

Concretely:
- Phase 259's pre-position emit (8 × 80 = 640 right) drove cursor
  off the right edge from the post-home start at ~(1150, 780).
- Phase 260/261's pre-position (4 × 60 = 240 right) ALSO pushed
  past the right boundary (1150 + 240 = 1390, well past screen
  end ~1156-1170).
- Phase 264's 200-px wiggles started with cursor already off-screen.

The post-home cursor starts at ~(1150, 780) — far right side. Any
rightward chunked emit clamps it. Bench harnesses need to emit
LEFT and DOWN to land cursor in a visible mid-screen area.

## Production implication

The shape detector module at `src/pikvm/cursor-shape-detect.ts`
is functionally working. Integration into the production click
pipeline becomes a real candidate.

But: before claiming integration is safe, need to run a proper
diverse-position bench where the cursor IS in each frame. Phase
266 candidate: redesign the bench with correct pre-positioning
(emit LEFT from start position, land cursor at a known visible
mid-screen target).

## Why the bench harness drove cursor off-screen

`unlockIpad + ipadGoHome(forceHomeViaSwipe: true)` leaves the
cursor at the right edge because the forceHomeViaSwipe primitive
does a slam-to-bottom-right + chunked emit + click+drag. The slam
component drives cursor to the bottom-right corner; subsequent
movements bring it slightly up-left, landing near (1150, 780).

I had assumed post-home cursor would be in a mid-screen area, but
the forceHomeViaSwipe sequence specifically goes through the
bottom-right corner. Documented now.

## Phase 266+ candidates (within cursor-shape-detect plan)

1. **Redesign the bench harness** to emit LEFT-DOWN from the known
   post-home position (1150, 780) to land cursor at a known
   mid-screen target like (840, 600). Then run diverse-direction
   wiggle trials.
2. **Test detector across positions** by chunked-emit moving the
   cursor through 5-10 known mid-screen positions, capturing
   screenshots at each, running shape detector with locality hint
   from each known position.
3. **Integration**: wire `findCursorByShape` into `moveToPixel`'s
   correction-pass as a fallback when NCC template matching
   returns null. Run Phase 262-style N=20 click-rate bench to
   measure lift.

## State

- v0.5.220
- 713/713 tests
- nix build green
- Bench script `test-phase265-cursor-position-diag.ts` retained
- 5 verified screenshots at
  `data/phase265-cursor-position/<run-id>/`

## Lesson

ALWAYS verify the cursor is in the frame before claiming a
detection bench result. Phases 259-264 spent 5 ticks chasing a
phantom "detector doesn't work" problem when the actual issue was
"cursor isn't in the frame." The screenshots-are-source-of-truth
feedback memory exists for exactly this reason — should have
checked F0 frames before iterating on detector code.
