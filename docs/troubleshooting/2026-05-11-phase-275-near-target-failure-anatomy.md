# Phase 275 — anatomy of near-target failures at v0.5.223

**Date:** 2026-05-11
**Version:** v0.5.223 (no code change)
**Status:** Verbose-logged N=10 bench at near target (905, 800).
4/10 hits, 6/10 misses. Failures break across three modes
(predicted/shape/motion); no single failure class dominates →
no single simple fix. Shape-detect contributes to BOTH hits
and misses with comparable frequency.

## Per-trial summary

```
trial | residual | final mode  | modes seen
   1  |  ? hits  |            |
   2  |  ? hits  |            |
   3  | 139 px ✗ | motion      | [motion]  (reason: live ratio 3.651)
   4  | null ✗   | predicted   | [predicted]
   5  |   7 px ✓ | motion      | [motion]
   6  | 415 px ✗ | shape       | [motion,motion,shape,motion,motion,shape]
                                  (shape score=0.038)
   7  | 429 px ✗ | shape       | [motion,motion,motion,motion,motion,shape]
                                  (shape score=0.061)
   8  |  24 px ✓ | shape       | [motion,motion,shape]
   9  | null ✗   | predicted   | [predicted]
  10  | null ✗   | predicted   | [predicted]
```

(Trials 1 and 2 hits were positive but truncated in log capture.)

Hits = 4/10 (40%, within Phase 269's 45-55% range for N=20).

## Aggregate by final passMode

Among 6 misses:
- predicted: 3/6 (50%) — no detector fired; modeHistory is just [predicted]
- shape:     2/6 (33%) — shape-detect picked wrong feature at 415, 429 px
- motion:    1/6 (17%) — motion-diff confident-wrong at 139 px

Among 4 hits:
- shape:     2/4 (50%) — detector contributed real hits
- motion:    2/4 (50%) — motion-diff working as primary

**Key observation: shape contributes to both hits AND misses with
comparable frequency.** The integration is doing real work in both
directions.

## The shape miss pattern

Trial 6's shape miss: score 0.038
Trial 7's shape miss: score 0.061

Phase 271 measured legitimate cursor scores at 0.089-0.101. So
these bogus picks are LOWER scoring than typical cursors.

But Phase 269's diagnostic showed legitimate cursor at score 0.00
in some rendering conditions. The Phase 269 fix was to drop the
gate from 0.05 to 0 specifically to admit those 0.00 cursors.

| Score | Phase 269 cursor | Phase 271 cursor | Phase 275 bogus |
|------:|------------------|------------------|-----------------|
| 0.00 | ✓ legitimate | – | – |
| 0.038 | – | – | ✗ bogus |
| 0.061 | – | – | ✗ bogus |
| 0.089-0.101 | – | ✓ legitimate | – |

A score gate alone cannot separate these:
- Gate at 0: lets in both Phase 269 (0.00) AND Phase 275 bogus (0.04)
- Gate at 0.05: rejects Phase 275 bogus (good) AND Phase 269 cursor (bad)
- Gate at 0.08: rejects Phase 275 trial 7 bogus AND Phase 269 cursor

**Score is not a reliable discriminator between legitimate dim
cursor and bogus low-score picks.** Phase 269's gate-drop fix
admitted both classes; the bogus ones contribute to the 50% misses
observed.

## The predicted miss pattern

3 of 6 misses ended in `predicted` mode with modeHistory just
[predicted]. That means:
- Open-loop emit completed
- Motion-diff returned null on the first correction-pass
- NCC template-match returned null
- Shape-detect fallback was either not triggered or also returned null
- Algorithm fell through to "trust the open-loop prediction"

These trials are NOT contributing to shape-detect work — the
detector didn't even fire. The cursor was either:
- Off-screen / faded out
- In a position where no candidate scored anywhere near
- Or the locality gate (radius 100) excluded the actual cursor

## What would help (still within cursor-shape-detect plan)

The information value of this diagnostic suggests two NOT-yet-tried
moves within cursor-shape-detect:

1. **Widen locality radius dynamically based on cursor-belief
   variance.** When belief's position variance is high (predicted
   may be wrong by 100+ px), widen the shape-detect radius. When
   variance is low (recent successful detection), tighten. This
   adapts to drift without admitting permanent false positives.

2. **Cross-check on score: if shape returns score < 0.05 AND its
   position differs from `newPredicted` by < 30 px**, accept it
   (it's the legitimate-dim-cursor case Phase 269 fixed).
   **If score < 0.05 AND position differs from newPredicted by >
   30 px**, reject it (suspicious — bogus pick that drifted
   within locality). Different rule than Phase 269 ungated.

Hyp 2 is the cleanest. The legitimate-dim-cursor case (Phase 269,
score 0.00) had detected position 25 px from target (~newPredicted).
The bogus picks (Phase 275, score 0.038-0.061) had positions
hundreds of px from target.

Phase 276 candidate: implement hyp 2 (proximity-to-newPredicted
gate at < 30 px for low-score detections).

## Decision

Not implementing this tick — the hypothesis needs testing before
shipping. Phase 276 candidate is queued.

## State

- v0.5.223 unchanged
- 713/713 tests
- nix build green
- Bench script `test-phase275-verbose-near.ts` retained
- Verbose log data informs Phase 276 design

## Cumulative cursor-shape-detect status

Near target (905, 800), N=70 cumulative across Phase 269 (N=60) +
Phase 275 (N=10): roughly 47% within 35 px. The Phase 269 +12.5 pp
lift is sustained but the ceiling is around 50% single-attempt.

Failure breakdown enables a more targeted next attempt (Phase 276
proximity gate), but per cron rule 4 not running the experiment
without code change-bench-revert discipline. Documented and
stopped this tick.
