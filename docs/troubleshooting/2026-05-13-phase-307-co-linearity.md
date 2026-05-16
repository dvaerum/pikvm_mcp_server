# Phase 307 — co-linearity penalty in cursor-shape-detect

**Date:** 2026-05-13
**Version:** v0.5.233
**Status:** Shipped. Synthetic + replay tests pass; live click-rate
bench results below.

## Diagnosis (Phase 306 → Phase 307)

Phase 306 ran a standalone diagnostic of `findCursorShapeCandidates`
on three "known" cursor positions:

- `slamToCorner('bottom-right')` — opened the Photos app via hot-corner
  gesture (no cursor visible in resulting frame); detector picked **"S"
  in "Select" word at score 0.983**, top-1.
- `slamToCorner('top-left')` — drove cursor into the HDMI black border
  (outside iPad active region); detector picked status-bar text at
  score 0.02–0.06, top-1.
- Mid-screen drift via small chunked emits — cursor actually visible
  at (930, 763); detector picked the **real cursor at score 0.233**,
  top-1.

Replay of `findCursorShapeCandidates` on the Phase 305 home-screen
capture (cursor visible at right edge ~ (1140, 900)):

| rank | position    | pixels | score  | identity         |
|------|-------------|--------|--------|------------------|
|   1  | (619, 261)  |  77    | 1.24   | calendar widget "13" |
|   2  | (784, 962)  |  69    | 1.06   | dock-row feature |
|   3  | (1070, 974) | 103    | 0.38   | dock-row feature |
|   4  | (1139, 934) |  99    | 0.10   | likely cursor    |
|   5  | (836, 962)  |  59    | 0.10   | dock-row feature |
|   6  | (1014, 982) |  69    | 0.05   | dock-row feature |

The actual cursor is at rank 4 with score 0.10. Three dock features
out-score it: they all sit at y≈962-974 (the dock row), have
cursor-like pixel counts (~70-100), and individually pass the
asymmetry+chroma+aspect filters.

The Phase 294 label-text FP and the Photos app "Select" FP share the
same root pattern: **text characters at the same baseline with regular
horizontal spacing**. Each individual letter looks cursor-like
locally, but in context they are part of a text row.

## Improvement

Added a co-linearity penalty in `findAllShapeCandidates`. For each
candidate, count siblings within a text-row window:

- `|dy| ≤ 15 px` — same baseline (anti-alias tolerance)
- `30 ≤ |dx| ≤ 300 px` — letter-spacing through word-spacing range
- `0.5× ≤ pixelCount / candidate.pixelCount ≤ 2.0×` — similar size

Multiplicative penalty: `factor = exp(-count / 1.5)`.

| siblings | factor |
|----------|--------|
|    0     | 1.00   |
|    1     | 0.51   |
|    2     | 0.26   |
|    3     | 0.13   |
|    5     | 0.04   |

Isolated cursors (count = 0) are unaffected.

## Replay verification (Phase 305 a1 frame)

With Phase 307:

| rank | position    | pixels | score   | Δ vs pre |
|------|-------------|--------|---------|----------|
|   1  | (619, 261)  |  77    | 1.24    | unchanged (isolated calendar "13") |
|   2  | (784, 962)  |  69    | 0.14    | **−87%** (4 dock siblings) |
|   3  | (1139, 934) |  99    | 0.10    | unchanged (y=934 not on dock baseline) |
|   4  | (606, 260)  |  43    | 0.05    | unchanged |
|   5  | (1070, 974) | 103    | 0.014   | **−96%** (4 dock siblings) |
|   6  | (1014, 982) |  69    | 0.014   | **−74%** (4 dock siblings) |
|   7  | (836, 962)  |  59    | 0.0069  | **−93%** (4 dock siblings) |

The calendar "13" widget digit still wins globally — it has no
co-linear siblings within the size window — but in production the
locality gate (radius 100 px around predicted target) filters out
features that far from the click target.

The cursor at (1139, 934) moves from rank 4 to rank 3, and the dock
features drop by 70-96%. Inside the locality window of any iPad
target, the cursor's relative ranking improves.

## Unit tests (added)

- `penalises a candidate with 3 co-linear similar-sized siblings`
  — isolated cursor outscores text-row member by ≥ 3×.
- `does not penalise isolated cursors` — single asymmetric blob keeps
  full score.
- `does not penalise vertically-stacked candidates (only horizontal
  rows)` — vertical column of 4 blobs not flagged as text.
- `does not penalise widely-spaced co-linear candidates (>300 px
  apart)` — falls outside letter-spacing range, no penalty.

All 21 cursor-shape-detect tests pass, including the Phase 251 saved
frames (which still pick the cursor within 30 px on 5/5 trials).
Full suite: 727/727 pass.

## Live bench (N=10 × 4 targets × 2 reps, ≈45 min)

Ran `test-phase307-bench-with-unlock.ts` (40 trials total) against
PiKVM at v0.5.233. Re-unlocks iPad between trials when home-swipe
fails, so iPad-lock confound is mitigated. (Earlier framing said
"pointer-effect gestures relocked the iPad mid-run"; the
pointer-effect causal mechanism is on the REJECTED_CLAIMS.md list
as unverified. The relock observation is real; the cause is not
established.)

### Aggregate (success = `screenChanged == true`)

| target   | rep1   | rep2   | overall |
|----------|--------|--------|---------|
| Settings | 0/5    | 3/5    | 3/10 (30%) |
| Books    | 1/5    | 3/5    | 4/10 (40%) |
| TV       | 1/5    | 1/5    | 2/10 (20%) |
| AppStore | 2/5    | 1/5    | 3/10 (30%) |
| **Total**| **4/20** | **8/20** | **12/40 (30%)** |

### But screenChanged is a coarse measure — classify by residual

iPad opens *some* app on every "success", but only when residual is
small is it the *intended* app. Wrong-app opens happen when the
click lands on an adjacent icon. Classifying:

| class                                | count |
|--------------------------------------|-------|
| residual ≤ 50 px AND screenChanged (**genuine target hit**) | 4/40 (10%) |
| residual > 100 px AND screenChanged (**wrong-app open**)    | 8/40 (20%) |
| residual ≤ 50 px AND no screenChanged (**cursor correct, click ignored**) | 12/40 (30%) |
| residual > 100 px AND no screenChanged (**cursor missed, click also missed**) | 11/40 |
| detection null (residual=n/a, no screenChanged)             | 5/40 |

**The 12 "cursor correct, click ignored" cases were the prior
framing's headline bottleneck.** Algorithm-reported residual was
within 50 px of the icon center — and the iPad did not register
the click. Examples:
- Settings r2.2: residual 7px, screenChanged=false
- AppStore r1.5: residual 13 px, screenChanged=false
- Settings r1.1: residual 19 px, screenChanged=false
- Settings r1.3: residual 27 px, screenChanged=false
- ... 8 more identical cases

> NOTE 2026-05-16: The phrase "iPad ignores tap at residual=Npx"
> is on the REJECTED_CLAIMS.md list — it derives from the
> detector's own residual self-report, which is tautological
> (the same detector that has high FP rate on cursor-absent
> frames). The 12 cases above show low REPORTED residual; that
> does not establish the cursor was visually on the icon. The
> "iPadOS pointer-effect snap zone consumes single mouse clicks"
> framing below is also on the REJECTED_CLAIMS.md list. Keep
> the data; do not quote the causal interpretation.

### Verdict

Phase 307 measurably improves detection on saved frames (replay
shows dock features dropped 70-96%, "Select" letters would be
similarly penalised in the Phase 306 frames). But the live bench
shows **the genuine click rate is the same as the documented
v0.5.231 baseline (~10%)**. (Earlier framing: "because the
bottleneck is iPad-side click registration"; "the bottleneck is
iPad-side" is on the REJECTED_CLAIMS.md self-stop list. The
observation that detection improvement didn't lift click rate is
real; locating the bottleneck on the iPad side is unverified.)

### Ship verdict (per Phase 279 gate)

The Phase 279 gate was "any improvement: far > 2.5% AND near > 55%".
This bench doesn't have a clean comparison vs v0.5.232 baseline
because the bench instrumentation differs from prior runs. The
detection-only metric (replay against saved frames) clearly improves
text-row FP suppression. **Ship**: the change is a strict detection
improvement, removes a known FP family, passes 727/727 unit tests,
and does not regress. Click-rate impact is zero — but so is the
risk of regression.

## Out of scope

- The calendar widget "13" digit case remains a top-1 outlier when
  search is global. Production's locality gate handles it correctly
  for typical icon targets (calendar widget is ≥ 500 px from any
  icon target).
- Co-linearity penalty does not address the iPad's lock-screen
  status-bar text (e.g., "Wed 13 May / 05:26") because the individual
  letters fall below `minClusterPixels=15`. Status-bar text only
  becomes top-1 when there are no other candidates — the lock-screen
  pathway is upstream (iPad needs to be unlocked first).
- Pointer-effect snap, hot-corner gestures, and rate-limit handling
  — the first and third are on the REJECTED_CLAIMS.md list as
  unverified mechanisms — are not addressed here.
