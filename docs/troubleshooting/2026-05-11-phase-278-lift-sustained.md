# Phase 278 — Phase 276 lift sustained at v0.5.225 (post-revert sanity check)

**Date:** 2026-05-11
**Version:** v0.5.225 (Phase 277 attempt+revert — same effective
behaviour as v0.5.224)
**Status:** Confirmed Phase 276 production lift sustained at v0.5.225.
Two N=20 runs at near target: 55%, 45%. Cumulative with Phase 276
N=60: N=100 ≈ 55% within 35 px. Consistent with the +20.8 pp lift
shipped in Phase 269+276.

## Why this phase

Phase 277 attempted to widen the locality radius from 100 → 130 px,
saw a -18 pp regression, and reverted in the same tick. The version
bumped to 0.5.225 to mark the attempt was made, but the production
code was restored to v0.5.224's behaviour.

Standard discipline (cron rule: "run any bench at least twice") to
confirm the revert was clean and Phase 276 gains persist.

## Bench results

Two N=20 runs at target (905, 800):

| Run | Within 35 px |
|----:|-------------:|
| 1   | 11/20 (55%)  |
| 2   |  9/20 (45%)  |
| **N=40 cumulative** | **20/40 = 50%** |

Combined with Phase 276 N=60: N=100 ≈ 55/100 = **55%**.

Phase 237 variance lesson holds — individual N=20 runs land in
45-65% range. Aggregate central tendency around 55%, comfortably
above the v0.5.220 baseline of 37.5%.

## What's left within cursor-shape-detect plan

After Phases 257-278, the within-scope improvement candidates that
have been ruled out:

| Approach | Phase | Outcome |
|----------|------:|---------|
| Wider locality radius | 277 | -18 pp, reverted |
| Multi-cycle averaging | 274 | works but agrees on wrong answer |
| Cross-check on NCC | 268 | -10 pp, correlated failure modes |
| sizeFit retuning | 271 | cursor pix already at peak |
| Larger seed wake-emit | 252 | clock widget dominates |
| Cross-template top-K | 251 | FPs not intra-template |

Within-scope improvements that DID help:
- Phase 269: drop score gate (+12.5 pp)
- Phase 276: proximity gate for low-score (+8.3 pp)

Aggregate cursor-shape-detect lift: 37.5% → ~55% = +17.5 pp
sustained (≈ 92% end-to-end with maxRetries=2 binomial).

## Per cron rule 4

"Honestly report failure of the above and stop — do NOT pivot to
a different detection approach without explicit user direction."

The cursor-shape-detect work has reached its production ceiling.
The two remaining failure classes documented in Phase 277:
- Cursor-just-outside-radius: widening admits more FPs than catches
  legitimate (Phase 277 proven)
- Cursor-not-in-frame: ballistic/keepalive issue, not detector

Neither is a cursor-shape-detect parameter problem. Further click-
rate improvement requires user direction to pivot to:
- Open-loop Y-axis ballistic calibration
- Mid-screen pre-position anchor
- ML-based shape classifier

## State

- v0.5.225 (= v0.5.224 production behaviour after revert)
- 713/713 tests
- nix build green
- This phase: bench confirmation + doc only
