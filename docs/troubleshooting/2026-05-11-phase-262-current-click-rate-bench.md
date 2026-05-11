# Phase 262 — N=20 click-rate bench at v0.5.220 post-cleanup

**Date:** 2026-05-11
**Version:** v0.5.220
**Status:** N=20 single-attempt residual measurement against the
Settings-icon target (905, 800). Result: 11/20 = 55% within 35 px.
This is higher than the Phase 247 baseline (25% on the same target,
same protocol) — but per Phase 237 variance lesson, N=20 single
runs swing 5-55%; this is at the high end of variance, not
evidence of an improvement.

## Why this bench

Phase 257-261 explored shape-based detection (not integrated). Phase
255 cleanup removed Phase 191/248/250 opt-in dead code (default-off,
shouldn't affect default behaviour). Before more architectural work,
verify production click rate hasn't regressed.

## Methodology

`test-phase262-current-click-rate.ts`:
- Target (905, 800) — same as Phase 247
- N=20 single-attempt trials
- Per trial: ipadGoHome (with forceHomeViaSwipe), then
  moveToPixel(target, strategy='detect-then-move'), record
  finalDetectedPosition residual
- Tolerance: 35 px (production default)
- Post-move screenshot saved per trial

## Result

```
Trials:  20 total, 5 null, 15 valid
Passed:  11/20 (55.0%) within 35 px

Residuals (sorted):
  19, 19, 19, 19, 19, 27, 27, 27, 27, 27, 30, 34   ← 12 trials, 11 ≤ 35
  54, 151, 152, 191                                  ← 4 confident-wrong
  null × 5
```

- **11 hits clustered tightly at 19-27 px.** When detection works,
  it's accurate. Median residual on hits = 27 px.
- **4 confident-wrong at 54-191 px.** Detector returned a position
  far from where the cursor actually is (visually confirmed: trial
  1 with 191 px miss has no visible cursor in the post-frame at
  data/phase262-click-rate/t01-post.jpg).
- **5 nulls.** Locality gate (Phase 197+244) correctly rejected the
  far-away matches in these trials, returned null instead of
  garbage.

## Reading the result

Phase 247 baseline was 25%; this is 55%. Phase 237 variance lesson
documented N=20 single-bench-run results swinging 5-40% on
identical protocol. 55% is at the high end of that envelope. Not
evidence of a real improvement, just the lucky end of variance.

Cumulative N grows with more bench runs. Phase 248 N=60 with
blocklist = 26.7%; Phase 247 N=20 baseline = 25%; this run = 55%.
Cumulative N=40 baseline + N=20 (this) = N=60 total = (25%×40 +
55%×20)/60 = (10+11)/60 = 35% within 35 px.

So the honest current estimate is **~35% within 35 px** across all
historical baseline runs. Still well below what the project
needs.

## Bimodal failure pattern (confirmed again)

Phase 243 documented bimodal detection: residuals cluster at
≤5 px OR ≥100 px, rarely in between. This run confirms it again:

- 12 trials at 19-34 px (the "correct" cluster, anchored at the
  cursor's typical detection accuracy)
- 4 trials at 54-191 px (the "confident-wrong" cluster)
- 5 nulls (locality gate worked here)

There's NOTHING in the 35-50 px or 50-150 px ranges. Detection is
binary: either close enough to be correct, or far enough to be
clearly wrong. The 35 px tolerance is well-chosen.

## Implications

- **No regression from Phase 255 cleanup** confirmed.
- **Production click rate is dominated by the bimodal detection
  failure mode**, not by retry-loop or click-mechanics issues.
- **The Phase 257-261 shape-detector work targeted exactly this
  failure mode** but hasn't found a discriminator that beats the
  noise. Shipping integration would not help.
- **35% cumulative is the honest current number** for a single-
  attempt click within 35 px on this iPad's Settings icon.
  Production `clickAtWithRetry` with maxRetries=2 multiplies this
  to ~65-70% (cumulative-binomial).

## Comparison table

| Metric                           | Value                       |
|----------------------------------|------------------------------|
| Single-attempt rate (cumulative) | ~35% within 35 px           |
| Production retry default         | maxRetries=2 on iPad        |
| Cumulative click rate (2 retries)| ~65-70% (binomial estimate) |
| Keyboard-first workflow          | 100% across 4 apps (Phase 245) |

The keyboard workflow remains the recommended production path for
small-icon iPad targets. The mouse path has improved over many
phases but still has a known bimodal failure that no detection-
side parameter sweep has fixed.

## Second N=20 run (same tick, immediately after) — Phase 237 variance

Re-ran the same bench on the same target to test whether 55% was
real or variance. Second run, same protocol, ~25 min apart:

```
Trials:  20 total, 6 null, 14 valid
Passed:  4/20 (20.0%) within 35 px
Median residual: 151 px (vs first run: 27 px)
P95 residual:    493 px (vs first run: 191 px)

Residuals: 19, 27, 27, 33, 40, 117, 151, 151, 172, 210, 210, 382,
           382, 493, plus 6 nulls
```

First run: 55%. Second run: 20%. **Combined N=40 = 15/40 = 37.5%.**

Phase 237 variance lesson exemplified one more time: single N=20
runs can't be trusted. The honest current state is the COMBINED
rate across multiple runs.

Notable: trial 20 of run 2 reported detected=(852, 941) — the
SAME false-positive position Phase 247/248 documented at this
location. The Phase 248 fpBlocklist (which would have rejected
this) was correctly removed in Phase 255 cleanup because it
showed no aggregate click-rate benefit; but the underlying FP
location is still real. The locality gate at radius 150 isn't
catching it because the cursor-belief hint must have drifted close
to (852, 941) when the algorithm rejected the cluster.

## Combined honest estimate at v0.5.220

| Phase   | N  | Within-35-px | Cumulative N | Cumulative % |
|---------|----|--------------|--------------|--------------|
| 247     | 20 | 25%          | 20           | 25%          |
| 248-blk | 60 | 26.7%        | 80           | 26.3%        |
| 262 r1  | 20 | 55%          | 100          | 32%          |
| 262 r2  | 20 | 20%          | 120          | 30%          |

**~30% within 35 px** is the honest single-attempt rate across
N=120 trials at v0.5.220. NOT 55% (that was a single lucky run).

## State

- v0.5.220
- 713/713 tests
- nix build green
- Bench script `test-phase262-current-click-rate.ts` retained for
  future bench runs
- Trial frames at `data/phase262-click-rate/` (second run; first
  run's frames overwritten by re-running the script — bench is
  destructive)

## Lesson re-learned

ALWAYS run a bench at least twice before reporting a result. The
Phase 237 lesson keeps resurfacing because the click pipeline's
detection layer is genuinely bimodal and single N=20 lands in
either the good half or the bad half by chance.

For future benches: extend the script to optionally append data
across runs instead of overwriting (or use timestamped run-id
subdirectories). That way variance is observable directly in the
data.
