# Phase 243 — viz-lag hypothesis rejected; detection is bimodal

**Date:** 2026-05-10
**Version:** v0.5.210
**Status:** Diagnostic complete; hypothesis revised again.

## Test

`test-phase243-viz-lag-test.ts` — N=3 trials, each takes TWO post-
shots: one IMMEDIATE after moveToPixel returns (no settle delay),
one DELAYED 500 ms later. If cursor visually drifted between them,
viz-lag (Phase 242 hypothesis 1) is real. If cursor visible at same
position in both, viz-lag is rejected.

## Result

Cursor visible at the **same** position in both immediate and
delayed shots for all 3 trials. **Viz-lag rejected.**

But comparing alg-reported vs visible position revealed a different
pattern:

| trial | label     | alg-reported | visible (estimate) | accurate? |
|:-----:|:----------|:-------------|:-------------------|:---------:|
|  1    | settings  | (852, 942)   | ~(640, 130) on clock widget | ❌ wildly off |
|  2    | books     | (771, 768)   | ~(775, 765)         | ✅ within 5 px |
|  3    | reminders | (908, 786)   | ~(845, 890)         | ❌ ~100 px off |

## Real finding: detection is bimodal

When detection works (t2), it's very accurate (within 5 px of
visible truth). When it fails (t1), it fails BADLY — returning a
confident position that's 200+ px from the actual cursor (matched
on the clock widget face in this case). This is the documented
"detection layer is lying" pattern from prior memory: template
false-positives on saturated UI features.

The Phase 242 hypothesis of a "systematic Y-axis bias" was wrong
— there's no consistent direction or magnitude of error. The error
distribution is bimodal: small (5–10 px) when correct, large
(100–800 px) when matching a wrong template region.

## Implication for click-rate work

The Phase 236 N=10 ~22% within-tolerance rate is partly explained
by this: ~30% of trials have algorithm reporting a confident-wrong
position, so the residual estimate is meaningless and moveToPixel's
"correction" is in the wrong direction. The maxResidualPx safety
gate then fails the click for being too far from target — preventing
a wrong-element click but not advancing the trial either.

## Phase 244+ candidates (revised)

1. **Stricter template-match minScore.** Currently
   pickNearestPlausibleMatch may accept matches below the cursor's
   "real" template fingerprint. Raising minScore would reject
   false-positives at the cost of more null detections (which is
   strictly safer than confident-wrong).
2. **Detection sanity check via motion-diff cross-validation.**
   If template-match and motion-diff disagree by >100 px, treat as
   detection-fail rather than picking one.
3. **Per-frame template re-extraction with motion confirmation.**
   When the algorithm reports a position, immediately emit a known
   small Δ and re-detect. If the measured movement doesn't match
   the emitted Δ, the original detection was on a static feature
   (not the cursor).

Option 3 is the most robust but costs an extra detection round-trip
per click. Option 1 is the cheapest but risks more null detections.

## State

- v0.5.210 stable
- Phase 242 hypothesis revised then rejected; Phase 243 finding
  is "detection is bimodal" (matches prior memory)
- iPad operational
- 721/721 tests, nix build green
- All scripts in repo for reproducibility
