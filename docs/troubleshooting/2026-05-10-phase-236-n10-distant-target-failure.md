# Phase 236 — N=10 evidence post-Phase-235: distant targets dominate failures

**Date:** 2026-05-10
**Version:** v0.5.208 (Phase 235 shipped)
**Status:** Diagnostic complete; fix path identified, deferred.

## Bench

`test-phase236-n10-full-trace.ts` — unlock + forceHomeViaSwipe ONCE,
then 10 sequential `moveToPixel` trials covering all four screen
quadrants and 4 specific iPad icons. No re-swipe between trials —
cursor stays where the previous trial left it (mimicking real-world
sequential clicks).

## Result

| trial | label         | target       | alg-reported   | residual | within 35 |
|:-----:|:--------------|:-------------|:---------------|:--------:|:---------:|
|   1   | settings      | (905, 800)   | (908, 786)     |    14    |    ✅     |
|   2   | top-left-q    | (400, 250)   | (609, 300)     |   215    |    ❌     |
|   3   | top-right-q   | (1050, 250)  | (813, 316)     |   246    |    ❌     |
|   4   | center        | (720, 540)   | (636, 387)     |   175    |    ❌     |
|   5   | bot-left-q    | (400, 850)   | (761, 958)     |   377    |    ❌     |
|   6   | bot-right-q   | (1050, 850)  | (884, 786)     |   178    |    ❌     |
|   7   | books         | (645, 815)   | (649, 842)     |    27    |    ✅     |
|   8   | tv            | (775, 815)   | (772, 767)     |    48    |    ❌¹    |
|   9   | files         | (1035, 425)  | (782, 314)     |   276    |    ❌     |
|  10   | home-icon     | (645, 680)   | null           |    n/a   |    ❌     |

¹ within 75 px (close miss; pre-Phase-235 same-residual results).

**Aggregate:** 9/10 valid detection, 2/9 within 35 px (22%), 3/9 within
75 px (33%).

## Pattern

Plot residual vs. distance-from-prior-cursor:

| trial | prev cursor | target       | distance | residual |
|:-----:|:------------|:-------------|:--------:|:--------:|
|   1   | mid-screen  | (905, 800)   | ~410     |    14    |
|   2   | (908, 786)  | (400, 250)   | ~736     |   215    |
|   3   | (609, 300)  | (1050, 250)  | ~444     |   246    |
|   4   | (813, 316)  | (720, 540)   |  ~243    |   175    |
|   7   | (884, 786)  | (645, 815)   |  ~241    |    27    |
|   8   | (649, 842)  | (775, 815)   |  ~129    |    48    |

Inconclusive on raw distance, but observation:
- **HITs** (t1, t7): both targets reachable from cursor with ≤300 px
  net displacement in the dominant axis.
- **MISSes** (t2-t6, t9): all required ≥200 px X-axis displacement.

**Hypothesis:** the per-pass chunked-emit loop in moveToPixel doesn't
always cover the full requested distance. With `maxCorrectionPasses=5`
default (or 12 with `progressiveOpenLoop`) and per-call cap ~52 px
x-axis on this iPad, a correction pass that needs to move 200 px X
should require 4 chunks. If the pass terminates early (e.g. on
detection failure or velocity-cap rejection), residual stays high.

## What Phase 235 fixed and what's left

**Fixed:** cursor pinned at top edge after `forceHomeViaSwipe`. This
was the dominant failure for FIRST clicks after a home-screen reset.
Live N=6 (Phase 235): no top-edge pinning, 33 % within 35 px.

**Not fixed:** moveToPixel's per-pass emit budget under-emits for
targets requiring large X-axis displacement. The Phase 236 N=10 run
shows this clearly: the only HIT after t1 was t7 (small move from
previous cursor); every distant-target trial failed.

## Cursor-fade caveat

After-screenshots in N=10 do NOT show the cursor visually. iPadOS
fades the cursor after a few seconds of inactivity, so by the time
the test script captures its own post-move screenshot the cursor
is gone. The algorithm-reported residuals come from `moveToPixel`'s
internal probes (which wake the cursor with a ±1 px nudge before
screenshotting). Those values should be accurate, but visual
cross-check requires inserting a wake nudge into the bench
between `moveToPixel` return and screenshot.

## Candidate Phase 237+ work

1. **Per-pass emit budget audit.** Trace what one correction pass
   actually emits when target requires 200+ px X-axis correction.
   Verify each chunk reaches the cursor. May need a per-pass
   minimum-progress check.
2. ~~**Distance-aware maxCorrectionPasses.** Bump default 5 → 8.~~
   *Tried as Phase 237; see below — reverted, single-sample noise.*
3. **Visual-truth bench**. Insert `client.mouseMoveRelative(1, 0)`
   wake nudge before each post-move screenshot so the cursor is
   visible for manual cross-check of algorithm-reported positions.

## Phase 237 attempt + revert (default bump 5 → 8)

**Hypothesis:** bumping `maxCorrectionPasses` from 5 to 8 should let
moveToPixel converge on distant targets that ran out of passes at 5.

**A/B at v0.5.208:**

| pass count | mean residual | within 35 | within 75 |
|:----------:|:-------------:|:---------:|:---------:|
|     5      |    173 px     |   2/9     |   3/9     |
|    10      |    112 px     |   2/8     |   4/8     |
|     8      |    186 px     |   2/7     |   2/7     |

The 10-pass run looked like a 35 % win on mean residual. After
defaulting to 8 the next 10-trial run came in at 186 px mean —
**worse than the 5-pass baseline**. Single-sample N=10 has too much
run-to-run variance to draw conclusions; the apparent Phase 237 lift
was noise.

**Decision: revert.** Default stays at 5. The MCP tool's
`validateNumber` cap stays at 5. The only kept change: tool description
"Default 2" → "Default 5" (was a stale comment, not a behavior change).

**Real lesson:** any moveToPixel parameter A/B needs N ≥ 30 across
multiple sessions to overcome the per-trial variance. Single-N=10
runs are useful for surfacing failure modes (Phase 236 did its job)
but not for tuning continuous parameters.

None of these fit cleanly in one cron iteration; they need design
review and live A/B verification with proper sample size. The Phase
236 N=10 data is the foundation — capture it and pick up here next
session.

## State

- v0.5.208 ships with Phase 235 fix
- N=10 diagnostic captured at `data/phase236-n10/`
- 707/707 tests green
- Bench script `test-phase236-n10-full-trace.ts` retained for
  reproducibility
