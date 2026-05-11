# cursor-shape-detect — state of the detector at v0.5.224

**Last updated:** 2026-05-11 (Phase 276 — proximity gate, +20.8 pp total at near targets)

This document is a single-page reference for the cursor-shape-detect
work. Replaces the need to read the 16 troubleshooting docs from
Phases 257-272 to understand what works, what doesn't, and what
decisions need user direction.

## TL;DR

- **Shipped & working:** `findCursorByShape` in
  `src/pikvm/cursor-shape-detect.ts`, called as a fallback inside
  `moveToPixel`'s correction-pass when motion-diff and NCC
  template-match both return null.
- **Click-rate lift confirmed:** +12.5 percentage points at targets
  near the post-home cursor start position. 50% within 35 px
  single-attempt at target (905, 800) across N=60.
- **Lift is target-specific.** At target (757, 832) — 300 px from
  post-home start — click rate is 2.5%. The reason is a ~66 px Y-axis
  ballistic shortfall, not a detector miss. Cursor lands in the
  wallpaper gap between icon rows.
- **Detector is at its natural ceiling.** Pixel-count tuning,
  cross-checks, locality widening have all been tested and reverted
  or shown not to help. Further click-rate improvement requires
  ballistic-accuracy work, which is a different problem class.

## What the detector does

`findCursorByShape(rgb, width, height, options)`:
1. Compute grayscale brightness per pixel
2. Threshold at brightness < 100 → boolean mask of "dark" pixels
3. Connected-component clustering with size filter (15-250 px)
4. Per-candidate: compute aspect ratio, asymmetry, centroid offset
   from bbox center, mean RGB chroma
5. Score: `sizeFit × (1 + asym/3) × (1 + offset/5) × exp(-aspectPenalty) × chromaPenalty`
6. Locality filter against `expectedNear` hint within `expectedNearRadius`
7. Return highest-scoring candidate within radius

`shapeScoreFor(pixels, asymmetry, centroidOffset, bboxAspectRatio)`:
- Pure helper for unit tests
- `sizeFit = exp(-(pixels - 80)² / 600)`
- Cursor pix is measured 68-77 (median 76) → sizeFit ≈ 0.97
- Final score is typically 0.05-0.30 due to chroma/aspect/asym
  multiplicative penalties

## Where the detector is used in production

`src/pikvm/move-to.ts` correction-pass. After motion-diff fails AND
NCC template-match returns null:

```typescript
const shape = findCursorByShape(rgb, width, height, {
  expectedNear: newPredicted,        // cursor-belief's prediction
  expectedNearRadius: 100,
});
if (shape) {                          // no score gate (Phase 269)
  currentPos = { x: shape.centroidX, y: shape.centroidY };
  passMode = 'shape';
  client.observeCursor?.(currentPos, Math.max(0.3, ...));
  templated = true;
}
```

Confidence floor of 0.3 ensures cursor-belief's observe doesn't
ignore zero-score observations (which the detector produces when
penalties stack down a high sizeFit value).

## Click-rate measurements

| Target | Distance from post-home | N | Within 35 px |
|--------|------------------------:|--:|-------------:|
| (905, 800) at v0.5.220 baseline | ~150 px | 60 | 37.5% |
| (905, 800) at v0.5.223 (Phase 269)| ~150 px | 60 | 50.0% (+12.5 pp) |
| **(905, 800) at v0.5.224 (Phase 276)** | **~150 px** | **60** | **58.3% (+20.8 pp total)** |
| (757, 832) at v0.5.224 | ~300 px | 40 | 0-2.5% (ballistic bottleneck) |

With `clickAtWithRetry maxRetries: 2` (iPad default), binomial:
- Near-target: 1 − (1−0.583)³ = **92.7%** end-to-end
- Far-target: 1 − (1−0.025)³ = **7.3%** end-to-end

The 4-icon keyboard workflow (`launchIpadApp`) remains 100% reliable
and is the production recommendation for small-icon iPad targets.

## What was tried within cursor-shape-detect (in chronological order)

| Phase | What was tried | Outcome |
|------:|----------------|---------|
| 257 | Prototype: dark + size + asymmetry + offset shape scoring | Cursor in top-5 candidates on saved frames |
| 258 | + locality gate | 5/5 on saved Phase 251 frames |
| 259 | Live diverse-position bench | 0/5 — dock icons compete (bench-harness bug) |
| 260 | + motion-diff verification | Clock widget beats cursor in pixel-diff |
| 261 | Differential motion-diff (F0/F1/F2) | Signal-to-noise too low |
| 262 | Baseline click bench at v0.5.220 | 37.5% N=40 |
| 263 | Bench tooling: non-destructive subdirs | (tooling) |
| 264 | 200 px wiggle verification | Bench harness drove cursor off-screen |
| 265 | Post-home cursor position diagnostic | Cursor lands at (1150, 780), detector works there |
| 266 | Bench-harness fixes + tracking N=10 | 20/20 within 30 px (median 6 px) |
| 267 | Production integration as fallback | No regression, no measurable lift |
| 268 | Cross-check on NCC matches | -10 pp, reverted same tick (correlated failures) |
| 269 | Drop score gate → 0 | **+12.5 pp lift at (905, 800)** |
| 270 | Validate at second target (757, 832) | 2.5% — lift target-specific |
| 271 | Cursor pix distribution | sizeFit is correctly tuned |
| 272 | Verbose far-target diagnostic | Y-axis ballistic shortfall, not detector miss |

| 274 | Multi-cycle averaging (5 frames, median) | Outlier rejection works, but median agrees on wrong answer when cursor isn't where algorithm is looking (dominant failure) |

## What has been ruled out (do not re-try without new evidence)

- **Wider locality radius**: admits dock-area false positives
  (Phase 259, 260)
- **Shape cross-check on NCC**: correlated failure modes — both
  detectors fooled by same dock icon animations (Phase 268)
- **sizeFit Gaussian retuning**: cursor pix is at the peak;
  formula is correct (Phase 271)
- **Larger seed wake-emit**: clock widget motion dominates regardless
  (Phase 252)
- **Pre-position via slamToCorner**: triggers iPadOS 26 lock screen
  (Phase 253)
- **Cross-template top-K selection**: data showed FPs are not
  intra-template (Phase 251)
- **Phase 191 jitter / Phase 248 fpBlocklist / Phase 250 scoreMargin**:
  shipped opt-in, no measurable benefit, removed in Phase 255
- **Multi-cycle averaging (Phase 274)**: outlier rejection works
  but median agrees on wrong answer when cursor isn't where the
  algorithm is looking (the dominant failure mode). Adds ~1.5s
  latency per correction-pass for no production benefit.

## Open paths that would need user direction to pivot to

These are NOT cursor-shape-detect improvements. They're orthogonal
work that could lift production click rate:

1. **Open-loop Y-axis ballistic re-calibration.** Phase 192
   cursor-belief tracks px/mickey ratio but variance is 1.25-1.75
   (40% spread). A tighter calibration on the Y axis would let
   cursor land closer to targets.

2. **Iterative chunk-and-detect.** ~~Instead of one big open-loop
   emit, do many small (20-30 px) emits each followed by detection.~~
   **Phase 279 tested this (`progressiveOpenLoop: true`, N=160
   interleaved A/B). Result: +5 pp on near (within variance), 0% on
   far in both arms.** The 12-chunk small-step approach can't
   escape FP traps that single-shot mode falls into — detectors
   agree on the wrong answer rather than catching each other's
   mistakes. Ruled out as a lever for the far-target failure class.

3. **Pre-position cursor to a known mid-screen anchor first.**
   The post-home position (1150, 780) is far from many targets.
   Pre-positioning to (840, 600) or similar mid-screen point would
   reduce the maximum required travel distance for any target.

4. **ML-based cursor classifier.** Trained on labelled cursor/icon
   thumbnails. Would handle the dock-area correlated-failure mode
   that hand-engineered features can't. Adds a model file dependency.

None of these are within "cursor-shape-detect" — they're complementary.

## Current cron task status

The session cron (job `245e8942`, every 10 min) keeps re-firing the
"focus on cursor-shape-detect" prompt. Per the cron's preference 4:

> Honestly report failure of the above and stop — do NOT pivot to a
> different detection approach without explicit user direction.

This document is that honest report. The cursor-shape-detect work
has reached its natural production ceiling. Future cron ticks
will either:
- Find no new work and write a brief acknowledgement
- Find a genuine within-scope refinement (rare; most paths ruled out)

If the user wants to pivot to ballistic-accuracy work or a different
detection approach, the cron prompt would need updating (or new
direction in chat).

## Files of interest

- `src/pikvm/cursor-shape-detect.ts` — the detector module
- `src/pikvm/move-to.ts` — production integration (search "Phase 267")
- `src/pikvm/__tests__/cursor-shape-detect.test.ts` — 16 unit tests
- `test-phase26{2,6,7,9}-*.ts` — bench scripts
- `data/phase26X-*/` — saved frames for visual inspection

## State

- v0.5.223 stable
- 713/713 tests
- nix build green
- All work committed and pushed to origin/main
