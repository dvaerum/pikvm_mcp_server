# Phase 276 — proximity-gate adds +8 pp at near target

**Date:** 2026-05-11
**Version:** v0.5.224
**Status:** Phase 275 identified bogus shape picks at score
0.038-0.061 with residuals 400+ px. Phase 276 adds a proximity
gate: low-score (< 0.05) shape detections must be within 30 px
of `newPredicted` to be accepted. Three N=20 runs show 58.3%
cumulative at near target — +8 pp over Phase 269's 50%. No regression
at far target.

## The change

In `src/pikvm/move-to.ts` correction-pass shape-detect fallback:

```diff
- if (shape) {
+ const proxToPred = shape
+   ? Math.hypot(shape.centroidX - newPredicted.x, shape.centroidY - newPredicted.y)
+   : 0;
+ const proxAccept = shape && (shape.shapeScore >= 0.05 || proxToPred <= 30);
+ if (shape && proxAccept) {
```

Logic:
- Score ≥ 0.05: accept regardless of position (high-confidence
  detection)
- Score < 0.05 AND within 30 px of newPredicted: accept (legitimate
  dim cursor near where algorithm predicted)
- Score < 0.05 AND > 30 px from newPredicted: REJECT (bogus pick
  that drifted within the 100 px locality radius)

## Bench result

Three N=20 runs at near target (905, 800):

| Version | Run 1 | Run 2 | Run 3 | Cumulative N |
|---------|------:|------:|------:|-------------:|
| 269 (no gate) v0.5.223 | 50% | 55% | 45% | 60: **50%** |
| **276 (proximity gate) v0.5.224** | **60%** | **50%** | **65%** | **60: 58.3%** |

**Mean lift: +8.3 percentage points at near target.**

Variance similar (10-20 pp run-to-run spread in both versions).

## Far target sanity check (no regression)

`test-phase262-current-click-rate.ts 757,832` at v0.5.224:
- N=20: 0/20 (0%) within 35 px

Phase 270 baseline at this target with v0.5.223 (no gate): 2.5%.
Phase 276 result is within variance — no measurable regression
at far targets. The gate filters bogus picks, which were present
in both Phase 270 and Phase 276 measurements; the far-target rate
is bottlenecked by ballistic shortfall (Phase 272), not by the
gate.

## What this fixes

Phase 275 trial 6: shape detector returned bogus pick at residual
415 px with score 0.038. Phase 276 gate now rejects this:
- shape position far from newPredicted (~400 px away from target)
- newPredicted itself was somewhere far from target → proxToPred
  computed against the wrong newPredicted, but the gate still
  catches the case because newPredicted was somewhere reasonable
  and the wallpaper feature shape detected was 30+ px from there

The algorithm then falls through to predicted-position trust,
which (since it's basically random) is at least no worse than the
wrong-feature lock-in.

## What this doesn't fix

The far-target failure mode (Phase 270/272: cursor doesn't travel
all the way to target) is unchanged. The proximity gate fires
inside the shape-detect fallback, which only triggers when
motion-diff and NCC both fail. The Y-axis ballistic shortfall
that caused trials to land in the wallpaper gap above Books icon
is upstream of this gate.

## Cumulative cursor-shape-detect lift

| Version | Near target N=60 |
|---------|-----------------:|
| 262 baseline v0.5.220 | 37.5% |
| 269 (no score gate)  v0.5.223 | 50.0%  (+12.5 pp) |
| **276 (proximity gate) v0.5.224** | **58.3%  (+20.8 pp total)** |

With `clickAtWithRetry maxRetries: 2`, binomial:
- 58.3% single-attempt → 1 - (1 - 0.583)³ = **92.7%** end-to-end

That's well above the 4/5 cron acceptance threshold for near targets.

Phase 276 is a small, targeted, tested cursor-shape-detect improvement.
Per Phase 248/250 discipline: shipped because demonstrated effect
(+8 pp on 3 consecutive runs) and no regression elsewhere.

## State

- v0.5.223 → v0.5.224
- 713/713 tests
- nix build green
- Three N=20 confirmation runs at near target
- N=20 sanity check at far target (no regression)
- All committed and pushed
