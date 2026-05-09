# Phase 194-E (diagnostic, no fix yet) — Files-target consistent undershoot

**TL;DR.** The Files target (1035, 420 — top-right of the iPad
home-screen icon grid) shows a **systematic ~200 px horizontal
undershoot** that 5 phases of detection fixes did not change.
Trace-bench data shows BOTH the algorithm's motion-diff AND a
fresh template-match agree the cursor really ends up at
~(820–832, 404). Detection is honest. The bug is in
movement: `moveToPixel`'s emit chain cannot drive the cursor
into the top-right corner.

## Trace-bench evidence (`bench-click-trace.ts files`, v0.5.190)

```
Trial 1/3
  s2 moveToPixel: reported (813, 316) residual=245 px;
                  visible-template (832, 404) score=0.94
  s3 postApproach: visible-template (832, 404) score=0.94
  s4 postClick0ms: visible-template (795, 644) score=0.97

Trial 2/3
  s2 moveToPixel: reported (998, 222) residual=201 px;
                  visible-template (795, 644) score=0.97
  s3 postApproach: visible-template (795, 644) score=0.97
  s4 postClick0ms: visible-template (795, 644) score=0.97

Trial 3/3
  s2 moveToPixel: reported (832, 404) residual=204 px;
                  visible-template (832, 404) score=0.94
  s3 postApproach: visible-template (832, 404) score=0.94
  s4 postClick0ms: visible-template (795, 644) score=0.97
```

Across all trials the cursor's *visible* end position clusters
at one of two stable points: **(832, 404) post-move**, then
**(795, 644) post-click**. Neither is the Files target. The
~200 px residual that's been showing up in every Files-target
bench since Phase 193-C is therefore **real cursor
displacement**, not a detection illusion.

## What this is NOT

- **Not a detection bug.** Phase 193 (brightness floor) and
  Phase 194-B (dark-cursor `looksLikeCursor`) made detection
  honest; both motion-diff and template-match converge on
  (832, 404) at NCC 0.94.
- **Not a snap-zone-rejection bug.** Snap-zone rejection
  would mean the cursor is at the icon but the click event
  doesn't register. Here the cursor never reaches the icon.
- **Not iPad cursor-fade.** Trace bench captures all four
  pipeline stages; cursor is visible in template-match
  searches at every stage.

## What this could be

The cursor is being clamped or rate-limited from reaching the
top-right region. Three hypotheses to test next:

1. **iPad bounds detection is wrong for this orientation.**
   `detectIpadBoundsFromBuffer` returns a rectangle. If it
   reports the iPad's right edge at HDMI x ≈ 830 instead of
   ~1170, then `moveToPixel`'s emit chain would clamp at
   x=830 because the safety check in Phase 49 micro-correction
   refuses to push past bounds. (832, 404) is suspiciously
   close to a "right-edge clamp at x=830".
2. **Per-axis ratio mismatch.** The X-axis ratio (px per
   mickey) might be smaller than belief assumes for this iPad
   in this orientation. `moveToPixel` would emit fewer mickeys
   than needed to reach 1035 and stop early thinking it's
   converged.
3. **iPad rate-limiting of fast emits in the right-edge
   region.** Phase 50 documented input rate-limiting on this
   iPad; possible the right region is more aggressive.

## Concrete next test (Phase 194-F candidate)

Single test: from a known origin (e.g. Cmd+H to reset), emit
ONE giant relative move (`mouseMoveRelative(800, 0)` × 5)
toward right edge with explicit pacing. After each emit,
screenshot and run template-match. Plot cursor X position
over emit count. If X plateaus before reaching 1170, that's
the rate-limit / clamp hypothesis. If X tracks linearly with
emit count then bounds-detection is the culprit.

Don't ship code changes until this diagnostic confirms which
hypothesis. The Phase 194-D revert taught us that ungrounded
bumps regress more than they help.

## Why the post-click frame shows cursor at (795, 644)

Across all three trials, post-click cursor is at (795, 644).
That's between Books (640, 800) and Settings (905, 800) — but
y=644 is ABOVE the bottom row. Likely the click on whatever
the cursor was pointing at triggered iPadOS to recentre the
cursor on a hover-target — possibly the icon below the click
position. Not the bug; just an iPad behaviour that confuses
post-click verification.

## Visual reference

`data/click-trace/files/01-s2-postMove.jpg` — frame where
algorithm and template both see cursor at (832, 404). Inspect
to confirm the cursor is genuinely there.
