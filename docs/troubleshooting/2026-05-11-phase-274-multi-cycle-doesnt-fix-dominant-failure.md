# Phase 274 — multi-cycle averaging works as designed but doesn't lift click rate

**Date:** 2026-05-11
**Version:** v0.5.223 (no production change)
**Status:** Cron preference 2 listed "multi-cycle averaging" as an
acceptable cursor-shape-detect improvement. Tested with 5 rapid
screenshots per trial, computed median of returned positions.
Result: multi-cycle behaves correctly (outlier rejection works) but
doesn't fix the dominant production failure (cursor not where
algorithm is looking, due to ballistic shortfall — Phase 270/272).

## What was tested

`test-phase274-multi-cycle.ts`: 3 trials of moveToPixel to far
target (757, 832). For each trial after moveToPixel completes:
1. Take 5 screenshots in rapid succession (300 ms apart) with
   keepalive
2. Run findCursorByShape on each with locality hint at moveToPixel's
   final position, radius 150
3. Compute median position across the 5 returned answers
4. Compare median to each single-frame answer

## Per-trial result

```
Trial 1: moveToPixel → (836, 962)  — dock area
  5 frames all returned (836, 962) score 0.021
  Median: (836, 962)  range: 0×0 px
  Residual to target: 152 px
  → All 5 frames AGREED on the (wrong) dock-area answer

Trial 2: moveToPixel → (773, 766)
  f1: (906, 825) score 0.000
  f2-5: (657, 843) score 0.000  (4/5 consensus)
  Median: (657, 843)  range: 265×18 px
  Residual to target: median=101 px, single-frame[1]=149 px
  → Multi-cycle REJECTED the f1 outlier; median picked the 4-frame consensus

Trial 3: moveToPixel → null (failed)
  5 frames all near (774-784, 960) score 0.007
  Median: (774, 960)  range: 10×0 px
  Residual to target: 129 px
  → All 5 frames AGREED on a dock-area answer
```

## Interpretation

Multi-cycle median DOES work as designed:
- **Trial 2 outlier rejection succeeded**: f1's (906, 825) was filtered
  out; median (657, 843) tracked the 4-frame consensus instead.

But the consensus answers are STILL wrong:
- Trial 1: all 5 frames agree on dock area, but cursor isn't actually
  there.
- Trial 2: median (657, 843) is 101 px from target. Cursor is
  somewhere else entirely; the detector is picking weak features at
  score 0.000 because there's no strong cursor signal nearby.
- Trial 3: cursor faded out / off-screen; detector picks dock
  features consistently.

## Why this doesn't lift click rate

The dominant production failure mode (Phase 270/272) is:
1. moveToPixel's open-loop emit doesn't carry cursor to target
2. Cursor stops 60-100+ px from target
3. The shape-detect fallback runs with locality hint at predicted
   position — but the cursor is far from predicted because the
   ballistic emit was inaccurate
4. Detector returns whatever dark feature is within the locality
   radius (often a dock icon or wallpaper artefact)
5. Algorithm believes that's the cursor

Multi-cycle helps with **transient single-frame noise** (e.g. JPEG
compression artefacts, brief widget animation in one frame but not
others). It does NOT help when:
- The cursor isn't visible in any of the frames (Phase 270 case)
- Or the cursor visited the dock area and stays there (Phase 272
  trial 1)

In all 3 Phase 274 trials, the cursor wasn't actually at the
detector's claimed position. Multi-cycle median agreed across
frames — but agreed on the wrong answer.

## Decision

Per Phase 248/250 discipline: a correct-in-principle change that
doesn't move click rate is not worth shipping. Multi-cycle adds
~1.5 seconds latency per correction-pass (5 keepalive screenshots
at 300 ms) for no measurable production benefit.

Documented as a tested null result. Multi-cycle averaging is now in
the "ruled out within cursor-shape-detect" list in
`docs/troubleshooting/cursor-shape-detect-state.md`.

## What this confirms

The Phase 272 conclusion stands: cursor-shape-detect has reached
its natural production ceiling. Improvements within the detection
layer (single-frame or multi-cycle) cannot address ballistic
inaccuracy.

Further click-rate improvement requires user direction to pivot to:
1. Open-loop Y-axis ballistic re-calibration
2. Iterative chunk-and-detect (shorter chunks)
3. Mid-screen pre-position anchor
4. ML-based shape classifier

## State

- v0.5.223 unchanged
- 713/713 tests
- nix build green
- Bench script `test-phase274-multi-cycle.ts` retained
- 15 frames saved at `data/phase274-multi-cycle/<run-id>/`
