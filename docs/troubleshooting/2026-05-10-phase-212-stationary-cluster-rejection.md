# Phase 212 — stationary-cluster rejection in cursor-belief

**Date:** 2026-05-10
**Version:** v0.5.200
**Status:** Code shipped; live measurement on Settings target shows
the rejection mechanism is correct but does NOT fire on the failure
mode that produced Phase 211's residual pattern. Honest finding
documented below.

## What was implemented

`CursorBelief` (`src/pikvm/cursor-belief.ts`) gained two pieces of
state and one new public method:

- `_lastObservation: { x, y } | null` — coordinates of the most
  recently accepted observation.
- `_emitMagSinceLastObservation: number` — accumulated emit
  magnitude (mickeys) since that observation. `predict()` adds
  `hypot(emit.dx, emit.dy)`; `observe()` resets it on accept.
- `wouldRejectAsStationary(measurement, opts)` — pure query that
  returns `true` iff `drift < driftPx` (default 5) AND
  `_emitMagSinceLastObservation >= minEmitMickeys` (default 30).
  Same thresholds as the existing `isStaleTemplateMatch` helper in
  `move-to.ts`.
- `observe(...)` accepts an optional `{ rejectStationary: true }`
  flag and now returns a boolean indicating whether the belief was
  updated.

`PiKVMClient` exposes both `observeCursor(..., opts)` and a
read-only `wouldRejectAsStationary(...)` query.

The correction pass in `move-to.ts` (around line 1873) now calls
`client.wouldRejectAsStationary` on the motion-diff cluster
centroid. If it would be rejected, the pass is treated as a
motion-diff failure and falls through to template-match; the
diagnostic `passReason` records `static-feature cluster lock-in
(Phase 212)` so post-mortem benches can see how often it fires.

44 unit tests in `cursor-belief.test.ts` (10 new) cover:
- empty history → no rejection
- no emit between observations → no rejection
- same pixel after a real emit → rejection
- driftPx and minEmitMickeys threshold respected
- accumulator resets on accepted observation
- `reset()` clears the lock-in history
- `observe()` with `rejectStationary: true` returns `false` and
  does NOT pull belief toward the stationary measurement
- `observe()` accepts a clearly-moved measurement after an emit

Full suite (687 tests) passes.

## What the live bench actually showed

10-trial bench at Settings target (905, 800) on v0.5.200, same
protocol as Phase 211:

| trial | detected | residual | notes |
|:-----:|:--------:|:--------:|:------|
| 1 | (970, 771) | 71.2 | cluster B |
| 2 | (949, 795) | 44.3 | cluster A |
| 3 | (854, 849) | 70.7 | new outlier |
| 4 | null | — | both detectors failed |
| 5 | (948, 796) | 43.2 | cluster A |
| 6 | (888, 547) | 253.6 | far-off (cursor lost) |
| 7-8 | null | — | failed |
| 9 | (949, 795) | 44.3 | cluster A |
| 10 | null | — | failed |

Cluster A: 3/6, Cluster B: 1/6, Cluster C: 1/6 (vs Phase 211: 2,
2, 2). 6 valid / 10 (Phase 211: 8 / 10).

**The Phase 212 rejection log message does NOT appear in the
verbose trace.** The rejection is gated on motion-diff returning
a candidate pair — but in this trace, motion-diff returns NO pair
at all (`motion-diff failed (3×2 cands considered, no pair passed
direction/sanity filters)`), and the algorithm falls all the way
through to the prediction model. The "clusters" reported in the
Phase 211 data are the prediction model's deterministic landing
output, NOT motion-diff false positives.

## Honest interpretation

Phase 211's hypothesis — "motion-diff is locking onto static UI
features" — was partly wrong. The static-cluster effect was real
but its source on this target is the **prediction fallback**, not
motion-diff. With both motion-diff and template-match failing, the
algorithm uses its internal `newPredicted` as the final reported
position, and that position is deterministic given the same input
sequence (same target, same starting cursor state via
`ipadGoHome`).

Phase 212 is correct code with thorough tests. It just doesn't fire
on this particular failure mode. It WILL fire in scenarios where
motion-diff returns a candidate pair pointing to a static UI
feature (Phase 211 measured these existed across some trials, just
not the ones in the new sample).

## Why ship anyway

1. Correct safety mechanism for a documented failure mode.
2. No regression: Phase 212 only activates when a measurable
   condition (drift < 5 AND emit >= 30) is met; existing flows
   are unchanged.
3. Test coverage: every behaviour is pinned in `cursor-belief.test.ts`
   so future refactors can't silently break it.
4. The diagnostic message means future benches will reveal how
   often the gate fires in production.

## Next-phase candidate

The actual lever measured here is **the prediction fallback's
deterministic landing**. With both detectors failing, the algorithm
trusts a prediction that is reliably 40-70 px from target on
icon-sized targets, and the `maxResidualPx=35` safety gate then
correctly skips clicking — net effect is zero correct-element
hits.

Possible directions:
- **Detector improvements**: motion-diff is failing at "no pair
  passed direction/sanity filters" — investigate why for this
  target.
- **Prediction recovery**: when both detectors fail and the
  prediction is in a known false-positive cluster region (we now
  have the data for this), force a slam-recover instead of
  trusting prediction.
- **Investigate template-match failure**: trace shows
  `template-match unavailable` in the correction pass — what
  caused it to be unavailable? (Likely no recent template match
  succeeded earlier, so `sessionTemplates.length === 0`.)

These are Phase 213+ candidates, gated on instrumenting the
template-match failure mode first.

## State at v0.5.200

- `cursor-belief.ts` + `client.ts` + `move-to.ts` extended
- 10 new unit tests
- Full 687-test suite green
- Live bench shows mechanism is correct but doesn't fire on the
  predominant Settings-target failure mode
