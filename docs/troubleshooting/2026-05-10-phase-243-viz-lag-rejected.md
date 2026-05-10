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

**Existing safeguards (already shipped):**
- Phase 62 — Reject template-match positions that don't move after
  significant emission (`move-to.ts:1625, 1895` static-feature
  rejection).
- Phase 63 — Raise template-match minScore to filter false positives
  (current default `0.83` at `cursor-detect.ts:925, 1052`).
- Phase 212 — Cursor-belief stationary-cluster rejection.

The bimodal failure persists DESPITE these. The clock-widget
false-positive at NCC ≥ 0.83 is admitted by the score gate, AND the
"didn't move after emit" gate doesn't fire because moveToPixel's
correction emits DO produce real cursor motion (cursor really
crosses the screen) — but the algorithm tracks the clock-widget
match instead, which appears to "move" because the clock face
features change subtly between frames.

**Genuinely new candidates:**
1. **Score-margin gate.** If the second-best template match is
   within 0.05 NCC of the best, treat as ambiguous (kill the
   detection). False-positives on UI features tend to score similarly
   to the cursor match; true cursor matches are usually significantly
   higher than any UI feature.
2. **Motion-diff and template-match must agree within K px.** Both
   detection methods are run; if they disagree by >100 px, neither
   is trusted. Increases null-detection rate but eliminates confident-
   wrong from this failure mode.
3. **Negative-template list.** Snapshot known UI-feature
   false-positive locations (clock widget centre, calendar widget,
   etc.) and reject template matches within K px of them.

Option 1 is cheapest. Option 2 is most architecturally sound. Option
3 is hacky but effective for this specific iPad's home screen.

None implemented this cron tick — each needs careful design + live
A/B with N ≥ 30 to overcome the per-trial variance documented in
Phase 237.

## State

- v0.5.210 stable
- Phase 242 hypothesis revised then rejected; Phase 243 finding
  is "detection is bimodal" (matches prior memory)
- iPad operational
- 721/721 tests, nix build green
- All scripts in repo for reproducibility
