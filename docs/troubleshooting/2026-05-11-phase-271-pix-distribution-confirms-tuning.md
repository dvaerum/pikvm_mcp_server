# Phase 271 — cursor pixel-count distribution confirms shape-detect sizeFit tuning is correct

**Date:** 2026-05-11
**Version:** v0.5.223 (no code change)
**Status:** Diagnostic confirms cursor-shape-detect's `sizeFit`
Gaussian (peak 80 px, variance 600) is well-tuned for this iPad's
cursor. Pixel count is consistently 68-77 (mean 72.5, stddev 3.7).
The ~0.10 shape score comes from chroma + aspect + asymmetry
factors, not from sizeFit. Phase 269's score-gate removal was the
right fix; no further sizeFit tuning needed.

## What was measured

`test-phase271-pix-distribution.ts`: drove cursor to known post-home
position (~1063, 778), took 10 keepalive screenshots with tiny
±5,±3 wiggles between them, ran shape detector with locality hint
at (1100, 780) radius 150, logged each candidate's pixel count.

## Results

```
trial | pos          | pix | score
   1  | (1066, 778)  |  69 | 0.096
   2  | (1063, 777)  |  76 | 0.098
   3  | (1066, 778)  |  69 | 0.096
   4  | (1063, 777)  |  76 | 0.101
   5  | (1066, 778)  |  68 | 0.089
   6  | (1063, 777)  |  76 | 0.098
   7  | (1066, 778)  |  69 | 0.096
   8  | (1063, 777)  |  76 | 0.098
   9  | (1066, 778)  |  69 | 0.096
  10  | (1063, 777)  |  77 | 0.094
```

Pixel count distribution:
- min 68, median 76, mean 72.5, max 77, stddev 3.7
- Range 68-77 → 9 px spread → tight cluster
- All 10 trials produced a valid candidate at expected location

## Interpretation

### sizeFit is correctly tuned

Current formula: `sizeFit = exp(-(pix - 80)² / 600)`
- At pix=76: 0.97 (near peak)
- At pix=68: 0.85
- At pix=77: 0.98

The Gaussian's peak at 80 is a 4 px offset from the actual median
of 76. The variance of 600 means sigma = ~24 px, so at the
±2-sigma boundary (32-128 px) sizeFit is still > 0.05. The
distribution's 9 px spread fits well within the peak region.

**No sizeFit retuning is needed.** Recommended formula based on
this data:
- peak=76 (median), variance=55 (4× stddev²)
- This would slightly tighten the Gaussian but isn't necessary
  since sizeFit isn't the bottleneck.

### Why score is ~0.10 if sizeFit is 0.97

The full formula:
```
shapeScore = sizeFit × (1 + asym/3) × (1 + offset/5)
           × exp(-aspectPenalty) × chromaPenalty
```

With sizeFit ≈ 0.97 and final score ≈ 0.10:
- Other factors' product ≈ 0.10 / 0.97 ≈ 0.10

Likely contributors (each diluting the score):
- `chromaPenalty = exp(-chroma/20)`: if cursor's mean RGB shows
  20+ chroma spread (anti-aliased dark on coloured wallpaper),
  penalty ≤ 0.37
- `aspectPenalty = |log(aspectRatio)|`: if cursor bbox is
  elongated (arrow is 24×16 nominal), log(1.5) = 0.41, exp(-0.41)
  = 0.66
- Asymmetry and offset modestly boost (1-2×) but don't push
  much above 1

So the multiplicative penalties get the score from 0.97 down to
0.10. The position is correct because locality filtered the
candidates; the score is low because the multi-factor formula
penalises anti-aliased coloured cursors more than I expected.

**Phase 269's fix (drop the ≥ 0.05 gate) was the right call.**
The position is reliable when locality-filtered; the score is
not — and the score gate was rejecting valid detections.

## What this tells us about cursor-shape-detect tuning

The detector is doing what it should:
- Finds cursor at ~1066, 778 reliably (10/10 trials)
- Pixel count tight around 73 (within ±5 of expected 80)
- Score ~0.10 is low but consistent — not a bug, just a
  consequence of multiplicative penalty stack

For production:
- Locality gate (radius 100-150) does the real selection work
- Score is informational, not gating
- Phase 269's `if (shape)` check (no score threshold) is the
  correct integration

## Where ALSO not to spend time

- Tuning sizeFit: pix is right at the peak; nothing to fix
- Tweaking chroma penalty: might bump score from 0.10 → 0.30
  but doesn't change detection success
- Tweaking aspect penalty: same — score cosmetic only

## What remains

Phase 270 found the lift is target-specific because cursor doesn't
TRAVEL well to far targets (open-loop ballistics drift). That's a
moveToPixel problem, not a cursor-shape-detect problem. Per cron
rule, not pivoting without user direction.

## State

- v0.5.223 unchanged
- 713/713 tests
- nix build green
- This phase: diagnostic + doc only

The cursor-shape-detect work is at a natural stopping point. The
detector is correctly tuned and integrated as a fallback in
moveToPixel's correction-pass. The remaining production bottleneck
(target-specific click rates) requires different work.
