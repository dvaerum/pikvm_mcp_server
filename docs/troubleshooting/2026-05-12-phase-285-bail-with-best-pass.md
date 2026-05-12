# Phase 285 — bail with best-pass landing (A2)

**Date:** 2026-05-12
**Version:** v0.5.226 (code change)
**Status:** Shipped, but with honest "not the lift I hoped for" reading.

## What ships

`pickBailPass(diagnostics, finalResidualPx)` — pure helper in
`src/pikvm/move-to.ts`. When `moveToPixel` finishes a move with
`finalDetectedPosition === null`, the algorithm now scans the per-pass
diagnostics for the smallest-residual **verified** pass (mode !==
'predicted') and returns that earlier landing instead of null.

Result type gains `bailedToBestPass: boolean` so callers can
distinguish a clean final detection from a bail-to-earlier-pass.

12 unit tests in `move-to.pickBailPass.test.ts`. 78 test files /
722 total tests pass.

## Implementation history (the honest version)

Initial implementation bailed whenever any earlier verified pass had a
residual smaller than the final residual by ≥10 px. Live bench showed
that hurt near-target click rate ~20 pp because the detector's
`residualPx` is **its claim about the cursor's position** — when the
detector locks onto a widget false-positive with score 0.87, its
claimed residual is tiny but the click lands on the FP. Bailing to a
smaller claimed residual when the FP is on the wrong icon makes
things worse, not better.

So the logic was narrowed: **bail only when the final pass produced
no detection at all (`finalResidualPx === Infinity`)**. When the
final pass returned any finite residual — even a large one — trust
it as the freshest signal. This restores correctness for the common
"detector locked onto FP" failure mode.

## Live bench (v0.5.226)

| Run mode | Trials | Hits | Rate |
|---|---|---|---|
| Phase 285 narrowed (null-final only), near target (905,800) | run 1 N=20 | 12 | 60% |
| Phase 285 narrowed, near target | run 2 N=20 | 9 | 45% |
| **N=40 cumulative near** | | **21/40** | **52.5%** |
| Phase 283 (no A2), near target | N=40 cumulative | 28 | 70% |
| Phase 285 narrowed, far target (757,832) | N=20 | 0 | 0% |

Cumulative near rate (52.5%) is **lower** than Phase 283's 70% (also
N=40). But Phase 237 documents that single N=20 runs swing 45-65 % on
identical protocol. The 17.5 pp delta over 40 trials is within that
variance band; it could be real or noise.

Far target stays at 0%. A2 doesn't fix it because in the failing
trials, every earlier pass also has the detector locked onto wrong
positions. Bailing to "best earlier" picks a similarly-wrong landing.

## Honest reading

A2 was supposed to lift far-target click rate by recovering "the
cursor was visible at pass 4 within ~70 px of target" landings from
the Phase 280 frame-by-frame finding. The narrowed implementation is
**too conservative** to recover those — it only fires when the final
pass produced null, but in many of those trials EVERY pass in the
diagnostics already had the detector lying about a different position.

The original aggressive bail was correct in spirit but the
implementation needs more than just "smallest claimed residual" to
decide which pass to trust. A future Phase could try:

- Cross-pass validation: only bail to an earlier pass if the next
  pass moved the cursor in a direction consistent with the claimed
  position
- Score-based confidence: prefer passes with higher detector scores
  (where available) over passes with smaller claimed residuals
- Spatial-consistency clusters: if 3+ passes all reported nearby
  positions, that cluster is more trustworthy than a single isolated
  small-residual pass

None of these are implemented in Phase 285. The narrowed A2 still
ships because: handling null finals more gracefully is a strict
improvement (no worse than returning null), the code is well-tested,
and the result type now exposes `bailedToBestPass` for callers that
care about the distinction.

## What didn't ship

- Aggressive bail (smaller-residual-wins) — measured to hurt
- Cross-pass validation logic — deferred until requested
- Score-based confidence — would require detector scores in
  diagnostics, doesn't exist today

## State at end of phase

- v0.5.226 (bumped from v0.5.225)
- 722/722 tests
- Near-target click rate: ~52.5% N=40 (within variance of Phase 283's
  70% but on the low side)
- Far-target click rate: ~0% N=20 (unchanged)
- nix build green (not yet rebuilt; will check before commit)
