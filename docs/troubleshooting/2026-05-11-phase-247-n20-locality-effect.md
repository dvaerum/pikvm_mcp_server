# Phase 247 — N=20 click-rate at v0.5.212 confirms bimodal detection

**Date:** 2026-05-11
**Version:** v0.5.212
**Status:** Diagnostic complete; Phase 244 net-effect characterized.

## Test

`test-phase247-n20-locality-effect.ts` — unlock + forceHomeViaSwipe
ONCE, then 20 sequential moveToPixel calls to (905, 800). No
re-swipe between trials. Records per-trial alg-position +
residual.

## Result

| Metric                 | Value                  |
|:-----------------------|:----------------------:|
| Within 35 px (hits)    | 5/20 = 25%             |
| Within 50 px           | 5/20 = 25%             |
| Within 75 px           | 5/20 = 25%             |
| Null detections        | 2/20 = 10%             |
| Mean residual (valid)  | 156 px                 |

## Bimodal distribution confirmed

Residual values from N=20:

```
17, 19, 28, 29, 31  ← 5 hits, all under 35 px
109                 ← 1 close miss
135, 136, 136, 151, 151, 151, 200, 201, 222, 238, 353, 506
                    ← 12 wide misses, all ≥100 px
null × 2
```

**The 35-100 px band is COMPLETELY EMPTY.** This is the bimodal
pattern Phase 243 hypothesized — detection is either tightly correct
(<35 px) or wildly wrong (≥100 px on UI features). No middle ground.

## Stable cross-call false positives

Three trials returned identically `(852, 941)`. Three more clustered
at `(773-774, 769-770)`. These are stable false-positive locations —
the algorithm repeatedly matches the same UI feature across moveToPixel
calls.

Phase 212 stationary-cluster rejection only catches WITHIN one
moveToPixel call (across passes). It doesn't track stable false
positives ACROSS calls. A cross-call FP-location memory could help.

## Comparison to baseline

| Version       | Within 35 px |
|:--------------|:------------:|
| v0.5.208 N=10 | 2/9 = 22%    |
| v0.5.211 N=10 | 1/5 = 20%    |
| **v0.5.212 N=20** | **5/20 = 25%** |

All within ±5 pp of each other. **Phase 244 locality gate did NOT
materially change end-to-end click rate.** It DID shift the failure
mode (more nulls, fewer confident-wrongs as documented), which is
architecturally correct, but the click-rate ceiling is set by the
detection layer's bimodal nature, not by the locality gate.

## Implications for Phase 245+

The bimodal detection means within-35-px hit rate ceiling is ~25%
on a single moveToPixel attempt against (905, 800). With Phase 94's
maxRetries=3 default (4 total attempts), cumulative rate would be
1 - (0.75)^4 = 68% — assuming retries are independent. Phase 191
jitter is supposed to make them more independent.

The path to >50% per-attempt requires fixing the bimodal failure
itself, not improving the convergence side. Phase 245+ candidates
(score-margin gate, motion-diff cross-validation, **cross-call
negative-template memory** as new candidate from Phase 247 finding):
all are detection-layer changes.

## State

- v0.5.212 stable
- 727/727 tests pass
- bench script `test-phase247-n20-locality-effect.ts` retained
- raw trial data at `data/phase247-n20-locality/trials.json`
- Click-rate ceiling characterized: ~25% within 35 px per single
  moveToPixel attempt at v0.5.212

## What's still open

The cross-call stable false positives (e.g. repeated `(852, 941)`
across 3 trials) suggest the iPad's home-screen UI has high-NCC
matches at fixed locations that the algorithm can't escape from.
Identifying those locations and excluding them from template-match
search would be the most direct fix — Phase 244 cross-link "Where
this fix does NOT extend" notes that the locality gate alone isn't
the right tool for the wake-recapture path; same here for
cross-call FPs.

## Phase 248 visual inspection of the FP locations

`test-phase248-fp-inspect.ts` snapshotted the iPad home screen at
1680×1050 with the cursor verifiably parked at the right edge
(~1145, 776 visible thanks to Phase 246 keepalive). At the FP
locations:
- **(852, 941)**: between the icons row (y≈810) and the dock
  (y≈970) — pure background, no UI element present, yet template-
  match returns this position with score ≥ 0.83 in 3/20 trials
- **(773, 769)**: directly on the **TV app icon** — the dark "tv"
  glyph probably correlates with the cursor template's dark blob.
  3/20 trials.
- **(782, 958)**: dock area near the page-indicator dots. 2/20
  trials.

The cursor at (~1145, 776) is NOT at any of these FP locations,
confirming the algorithm is confidently wrong, not the cursor
actually being there.

The (852, 941) case is particularly telling — there's no UI
feature there at all. Likely a wallpaper-gradient false-positive
that scores high enough to pass the 0.83 minScore floor but isn't
visually distinguishable from background.

This concrete evidence supports the Phase 248+ negative-template
list candidate: a manually-or-automatically-curated "known FP
locations on this iPad's home screen" list, with template-match
results at those positions rejected.
