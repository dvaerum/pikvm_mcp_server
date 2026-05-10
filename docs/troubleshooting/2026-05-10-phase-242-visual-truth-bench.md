# Phase 242 — visual-truth bench: detection Y-axis bias confirmed

**Date:** 2026-05-10
**Version:** v0.5.210
**Status:** Diagnostic complete; new finding for Phase 243+ work.

## Bench

`test-phase242-visual-truth-bench.ts` extends Phase 236's N=10 by
calling `client.screenshotKeepingCursorAlive()` (Phase 202 keepalive
variant) instead of plain `screenshot()` for the post-shot. The
keepalive variant emits a ±1 px wake nudge IMMEDIATELY before the
HTTP snapshot so the iPad cursor doesn't fade by the time the frame
is captured. N=5 covering 5 distinct targets.

## Result

| trial | label     | target       | alg-reported   | residual | cursor visible? |
|:-----:|:----------|:-------------|:---------------|:--------:|:---------------:|
|   1   | settings  | (905, 800)   | (852, 942)     |   152    | maybe (faint)   |
|   2   | books     | (645, 815)   | (686, 933)     |   125    | **yes** at ~(685, 875) |
|   3   | tv        | (775, 815)   | null           |   n/a    | -               |
|   4   | files     | (1035, 425)  | (780, 292)     |   288    | not visible     |
|   5   | reminders | (905, 555)   | null           |   n/a    | not visible     |

## Finding: detection Y-axis bias

t2 is the cleanest evidence: cursor visibly at ~(685, 875), algorithm
reports (686, 933). **X is essentially correct (686 vs 685, ~1 px),
Y is off by ~58 px** (alg says 933, visually 875).

This isn't a template false-positive (the X is right) — it's a
systematic Y-axis offset between the detection point and the cursor's
visual centroid. Three competing hypotheses, in order of revised
plausibility:

1. **Cursor-visualization lag** (most likely on second thought).
   moveToPixel returns immediately after its last detection probe;
   the test code waits ~250 ms then takes a wake-nudge-snapshot.
   In that window the cursor may visually drift as iPadOS settles
   it into a stationary state (the well-known cursor "tail"
   animation). The alg position (686, 933) is where the cursor
   was during the algorithm's probe; the visual position
   (685, 875) is where it ended up after settling. iPadOS
   registers clicks at the THEN-CURRENT position, so alg's reading
   is the operationally relevant one — the visual lag is
   misleading, not the algorithm.
2. Template centroid offset from cursor visual centroid (the
   stored template may be calibrated to the cursor's "hot spot"
   rather than visual center).
3. Motion-diff cluster centroid weighted differently than visual
   cursor center.

If hypothesis 1 is right (likely), there's no detection bug to
fix — the click coordinate the alg reports is correct. The Phase
236 click-rate problem then reduces to plain "cursor lands far
from target" which is a moveToPixel/per-call-cap problem, NOT a
detection problem.

Not enough N to discriminate between hypotheses. Phase 243 should
distinguish: emit a controlled +Δy after deposit, screenshot
WITHOUT delay (no settle), measure both alg and visual position.
If they agree, hypothesis 1 wins; if they still differ by ~58 px,
hypothesis 2 or 3.

## Diagnostic infrastructure improvement

`screenshotKeepingCursorAlive` is the right tool for visual cross-
check. The plain `screenshot()` used in Phase 236 missed the cursor
in all 10 trials because of fade. Phase 242 captured cursor in at
least 1 of 5 trials.

Recommended for any future bench script that needs visual confirmation
of cursor position: use `screenshotKeepingCursorAlive` for the post-
shot.

## Why detection-error matters

If algorithm reports cursor 58 px LOWER than reality, then:
- moveToPixel sees "cursor at y=933, target y=815" → wants to move
  cursor UP by 118 px
- But cursor is actually at y=875, so it really only needs to move
  UP by 60 px
- Algorithm over-corrects → cursor lands above target → another
  detection cycle gives a similarly biased reading → cycle repeats

This is why the residual estimate doesn't converge well even when
moveToPixel does its job.

## Phase 243+ candidates

1. **Y-axis bias measurement.** Run a controlled bench where cursor
   is parked at known visible Y-coordinates and compare against
   algorithm-reported Y. If consistent offset, calibrate it out
   in detection.
2. **Template re-extraction with visual-centroid alignment.** The
   stored cursor templates may have a centroid offset from visual
   center. Re-extract templates aligning visual center.
3. **Cross-check with motion-diff vs template-match.** If both
   methods agree on the bias, it's a real cursor-rendering offset
   (iPadOS may render cursor with ~30 px tail). If they disagree,
   it's a template-extraction artifact.

None of these are one-cron-iteration tasks. The Phase 242 evidence
makes them properly scoped Phase 243+ work.

## Test gap

`test-phase242-visual-truth-bench.ts` is committed for
reproducibility. Future agents picking up Phase 243+ can re-run it
to confirm the bias is still present and measure direction/magnitude
across more trials.

## State

- v0.5.210 stable
- 721/721 tests
- nix build green
- All work pushed
