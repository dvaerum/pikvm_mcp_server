# Phase 268 — shape-detect cross-check on NCC: attempt + revert

**Date:** 2026-05-11
**Version:** v0.5.222 (cross-check briefly shipped, then reverted in
this same tick — no net production behaviour change vs v0.5.221)
**Status:** Tried shape-detect as a CROSS-CHECK on NCC template-
match (vs Phase 267's fallback-only role). N=40 bench at 27.5%
vs Phase 267 baseline 37.5% — trending NEGATIVE within variance.
Per Phase 248 lesson "ship with demonstrated effect, not before,"
reverted same tick. Cross-check idea retained as honest dead-end
documentation; not in production code.

## What was tried

After Phase 267 integration showed no click-rate lift (because
the dominant production failure is NCC confident-wrong, which
doesn't trigger the fallback), Phase 268 added a cross-check
BEFORE accepting NCC's match:

1. NCC returns a non-null match at position P
2. Cross-check: run `findCursorByShape` at `newPredicted` ± 100 px
3. If shape returned a candidate at position S and |S - P| > 30 px,
   override NCC's match with shape's position
4. Otherwise accept NCC unchanged

The premise: NCC confident-wrong matches at 100-200 px residuals
would be over-ridden by shape, which finds the actual cursor closer
to predicted position.

## N=40 bench data

Two N=20 runs against target (905, 800):

| Phase | Run 1 | Run 2 | N=40 cumulative |
|-------|------:|------:|----------------:|
| 262 baseline v0.5.220 | 55% | 20% | 37.5% |
| 267 fallback v0.5.221 | 35% | 40% | 37.5% |
| 268 cross-check v0.5.222 | 35% | 20% | **27.5%** |

Phase 268 is 10 pp lower than the prior two baselines. Within
Phase 237 variance band (5-55% single-run swings) but the trend
is concerning. Run 2 residuals: 151, 200, 151, 200, 200 — heavily
clustered, suggesting the cross-check either didn't fire on the
confident-wrong NCC matches (shape returned null too) or fired
but agreed with the wrong answer.

## Decision: revert same tick

Per Phase 248/250 lesson and the cron prompt's "ship with
demonstrated effect" gate, reverting Phase 268 within the same
tick. Phase 267 stays — that integration was a true null result
(no regression, no lift) and is harmless.

Surface impact:
- Reverted: the 47-line cross-check block in `move-to.ts` correction-
  pass `else` branch
- Restored: original NCC-accept block (currentPos = found.position)
- Net diff against v0.5.221: zero behavioural change
- Version stays at 0.5.222 to mark the attempt was made (no rollback
  via version manipulation)

## Why this likely failed

The cross-check has two failure modes:
1. **Shape also returns null** when the cursor isn't in clear-wallpaper
   region (locked at edge, behind a widget, near dock). Cross-check
   doesn't fire → NCC unchanged.
2. **Shape agrees with NCC's wrong answer** when both detectors are
   fooled by the same UI feature (e.g. Phase 247's (852, 941)
   wallpaper-gradient FP scores high on BOTH NCC and shape).

Mode 1 isn't a regression — it's just doing nothing. Mode 2 is a
regression IF shape's failure mode and NCC's failure mode are
correlated (which they may be on a wallpaper-gradient FP).

The 10 pp drop is more consistent with the cross-check OCCASIONALLY
firing AND overriding a correct NCC match with a confident-wrong
shape match (mode 3 — both detectors confident-wrong in different
places). Need verbose-logged trial data to confirm.

## Lessons

- Phase 248/250 discipline holds: ship with effect, not before. N=40
  trending −10 pp is enough to NOT keep the change.
- Cross-checks between two correlated detectors don't reliably catch
  shared failure modes. The premise was "shape and NCC have
  independent failure modes" — but actually wallpaper-gradient FPs
  fool BOTH.
- The dominant failure mode (NCC confident-wrong at (852, 941)) is
  the same one Phase 247-248 fpBlocklist tried to address. Removing
  that blocklist in Phase 255 cleanup may have been correct given
  N=60 showed no benefit then, but the FP is real and persistent.

## What stays open (still within cursor-shape-detect plan)

- **Run a verbose-logged bench** to count how often the cross-check
  fires and what direction it goes (NCC right + shape wrong, vs
  NCC wrong + shape right, vs both wrong, vs agreement). N=40 with
  per-trial cross-check telemetry would disambiguate.
- **Multi-feature voting** (Phase 257-260 attempted multi-step
  hybrids): run shape AT THE NCC POSITION ONLY (radius 30 px), and
  only override when shape REJECTS that position (score < 0.05 in a
  30 px window around NCC's claim). Different rule shape than
  Phase 268's "where does shape say cursor is" — closer to "does
  shape see a cursor there at all."
- **Pixel-NCC variant**: run NCC with a strict-locality (radius 30)
  around `newPredicted` BEFORE the looser correction-pass search.
  This is essentially a reorder of the existing search-window
  logic and doesn't involve shape-detect.

## State

- v0.5.222 production code = v0.5.221 production code (cross-check
  reverted)
- Phase 267 fallback STAYS shipped
- 713/713 tests
- nix build green

## Phase 269 candidate

The next concrete experiment within cursor-shape-detect plan is a
**verbose-logged version of Phase 268** that records, per
correction-pass:
- NCC's reported position + score
- Shape's reported position + score (or null)
- Disagreement distance
- Which one (if any) was right (via post-hoc visual inspection)

That data would tell us whether the cross-check is right in
principle but failing on noise, or whether the premise itself is
wrong.
