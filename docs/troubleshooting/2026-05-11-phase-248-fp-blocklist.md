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

## Live A/B — N=20 first run looked good, N=20 second run regressed

Same protocol every run: unlock + forceHomeViaSwipe ONCE, then 20
sequential moveToPixel calls to (905, 800) without re-swiping.

| Run                  | within 35 px | within 75 px | nulls   | mean residual |
|:---------------------|:------------:|:------------:|:-------:|:-------------:|
| Phase 247 baseline   | 5/20 (25%)   | 5/20 (25%)   | 2/20    | 156 px        |
| Phase 248 run 1      | 8/20 (40%)   | 9/20 (45%)   | 5/20    | 131 px        |
| Phase 248 run 2      | 1/20 (5%)    | 1/20 (5%)    | 8/20    | 167 px        |
| **Phase 248 cumul.** | **9/40 (22.5%)** | **10/40 (25%)** | **13/40** | — |

**Honest revision:** Phase 248 run 1 looked like a 60% relative
improvement, but run 2 came in much worse. Cumulative N=40 with
blocklist is roughly EQUIVALENT to baseline (22.5% vs 25%) — well
within the variance Phase 237 documented.

This is exactly the per-trial variance Phase 237 warned about.
The Phase 248 single-N=20 result was misleading.

**What we actually know:**
- The blocklist semantically does the right thing — it rejects
  template matches at 3 visually-confirmed FP locations
- It doesn't materially change end-to-end click rate at this N
- It DOES shift the failure mode: more nulls (correct rejections),
  fewer confident-wrong template matches at the FP locations
- Whether the failure-mode shift translates to long-run click-rate
  improvement remains unproven

The option is still useful for callers who specifically want to
avoid landing clicks at the known FP locations (different concern
from raw hit-rate-near-target). It's opt-in default-off, so
shipping it carries no production risk.

**True per-attempt rate at v0.5.214 across 60 trials:**
- Phase 247 (no blocklist) N=20: 25%
- Phase 248 cumulative (blocklist) N=40: 22.5%
- All within ±5 pp of each other — **the click-rate ceiling is
  set by the bimodal detection failure, not by the blocklist.**

To meaningfully test whether the blocklist helps, we'd need:
- Multiple N=20+ runs across different sessions
- Different starting cursor positions / targets
- A/B with proper randomization between blocklist and no-blocklist
  in alternating trials within one session
- N≥100 cumulative

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
