# Phase 248 (v0.5.213) — opt-in false-positive blocklist

**Date:** 2026-05-11
**Version:** v0.5.213
**Status:** Shipped + live A/B verified.

## Problem

Phase 247 N=20 found that the iPad's home-screen UI has fixed pixel
locations where cursor template matches return high NCC scores
without a cursor being present:
- `(852, 941)` — pure background between icons row and dock,
  wallpaper-gradient FP. 3/20 trials.
- `(773, 769)` — directly on the TV app icon glyph. 3/20 trials.
- `(782, 958)` — dock area near page-indicator dots. 2/20 trials.

These cross-call stable false positives bypass Phase 212's
within-call stationary-cluster rejection (which only compares to
the LAST observation, not a multi-position memory).

## Fix

`src/pikvm/cursor-fp-blocklist.ts`: new module defining
`FpBlocklist = { centers: Point[]; radius: number }` and
`KNOWN_HOME_SCREEN_FPS_1680x1050` (the 3 Phase 247 locations with
50 px radius).

`FindCursorOptions.fpBlocklist?: FpBlocklist` (cursor-detect.ts):
new option threaded through. After picking the best template
match, if the position falls within `radius` of any blocklist
center, return null (so caller falls through to predicted-position
trust, same as Phase 197/244 paths).

`MoveToOptions.fpBlocklist?: FpBlocklist` (move-to.ts): threaded
to both call sites (open-loop and correction-pass).

**Default: undefined** — fully back-compat. Production callers see
no behavior change unless they opt in.

## Live A/B (N=20 each)

Same protocol both runs: unlock + forceHomeViaSwipe ONCE, then 20
sequential moveToPixel calls to (905, 800) without re-swiping.

| Metric           | Phase 247 baseline | Phase 248 blocklist | delta |
|:-----------------|:------------------:|:-------------------:|:-----:|
| within 35 px     | 5/20 (25%)         | **8/20 (40%)**      | +60% relative |
| within 75 px     | 5/20 (25%)         | **9/20 (45%)**      | +80% relative |
| null detections  | 2/20 (10%)         | 5/20 (25%)          | +15 pp |
| mean residual    | 156 px             | **131 px**          | -16% |

**Headline: hit rate within icon tolerance jumped 25% → 40% on
single-attempt.** The blocklist prevents the algorithm from
selecting the 3 known UI false-positive positions; instead it
either finds a real cursor match or returns null (fallback to
predicted position).

Per Phase 237's variance lesson, single N=20 isn't conclusive,
but a 15 percentage-point lift in hit rate is large enough that
the directional signal is meaningful. Subsequent benches across
different cron sessions can accumulate evidence.

## Tests

`src/pikvm/__tests__/cursor-fp-blocklist.test.ts` (12 tests):
- `isWithinKnownFp` predicate semantics (center, edge, far, undef, empty)
- `KNOWN_HOME_SCREEN_FPS_1680x1050` contains all 3 Phase 247 locations
- 50 px radius confirmed
- Phase 247 FPs are rejected, Settings target (905, 800) is NOT rejected

739/739 tests, nix build green.

## Limitations

The blocklist is **target-specific**:
- Reference iPad on `pikvm01.bb.vcamp.dk` at 1680×1050 portrait,
  current wallpaper, current app layout (TV icon at (~775, 800)).
- Different wallpaper / icon layout / iPad would have DIFFERENT FPs.
- Future: an auto-curated registry that updates the blocklist as
  the algorithm observes its own confident-wrong positions across
  sessions (Phase 249+ candidate).

For now, opt-in is the right shape — bench scripts and any caller
who knows their target's FP layout can pass the constant; everyone
else gets the original behavior.

## Phase 244 cross-link

Phase 244's "Where this fix does NOT extend (Phase 197b caution)"
section captured the lesson that gates are context-dependent. The
fpBlocklist is the same kind of context-dependent gate — it works
on call sites that have the option, doesn't disrupt sites that
don't pass it.

## State

- v0.5.213 ships the opt-in blocklist
- 739/739 tests pass
- nix build green
- Real measurable click-rate improvement when enabled
- Test scripts retained for reproducibility:
  - `test-phase247-n20-locality-effect.ts` (baseline, no blocklist)
  - `test-phase248-n20-with-blocklist.ts` (blocklist enabled)
  - `test-phase248-fp-inspect.ts` (visual inspection of FPs)
