# Phase 232 (attempted, reverted) — mid-screen deposit after forceHomeViaSwipe

> **SUPERSEDED by Phase 235 (v0.5.208).** Phase 232's hypothesis
> (deposit cursor at mid-screen after the swipe) was correct.
> Phase 232's IMPLEMENTATION (2 single emits totaling ~140 px
> commanded) was wrong because of the per-call cap (~52 px x-axis,
> ~135 px y-axis on this iPad) — see "Why this didn't work" below.
> Phase 235 retried with the right approach: 6×100 px chunked Y
> emits with 40 ms settle between, totaling ~600 px commanded with
> per-emit registration. Live N=6 confirmed the fix works.
> See `2026-05-10-phase-235-mid-screen-deposit-after-swipe.md` for
> the shipped version.

**Date:** 2026-05-10
**Version:** attempted at v0.5.208, reverted to v0.5.207
**Status:** Behavior regressed in live test. Reverted same turn. Superseded by Phase 235 (correct chunked implementation).

## Hypothesis

Phase 231's N=3 verification showed 1/3 trials hit tolerance, with t3
failing at locateCursor's "1 cursor-sized cluster (need ≥2)" check.
Theory: after the swipe, the cursor is pinned at the screen TOP edge
(swipe terminates at y=0 clamp from a 1500-px upward drag starting at
~y=1035). locateCursor's probe can't generate visible motion against
the bound. Adding a small downward + rightward emit after Phase 231's
defensive keys would deposit the cursor in mid-screen, giving
locateCursor probe room to work.

The change: two `client.mouseMoveRelative(40, 100)` emits with 50 ms
between them, before the function returns.

## Live result at v0.5.208 (reverted)

Same N=3 protocol as Phase 231 verification. **All 3 trials returned
`cursor=null`** — meaning moveToPixel completed but the algorithm
never had a verified cursor position. Visual inspection of t1's
post-move screenshot showed the cursor at ~(1115, 385) — STILL near
the top-right (target was 905, 800; ~441 px off).

The two +40,+100 emits didn't produce expected motion. Phase 206
documented that single-call emits cap at ~52 px on x-axis, ~135 px
on y-axis on this iPad. Two consecutive emits can EACH be capped
(iPadOS doesn't compose them), so 80 px total commanded → maybe 50-100
px actual movement. Insufficient to clear the top-edge pinning.

Further: the `cursor=null` result indicates moveToPixel reached a
"trusted prediction" code path where verification was skipped
entirely. This is a NEW failure mode that wasn't present at v0.5.207
(where we had t1: 19.8 px ✓, t2: 492.7 px far-off, t3: ERROR).

## Decision: REVERT

Phase 232 made the variance worse without a clear gain. Reverted to
v0.5.207 same turn — kept Phase 231's defensive Esc + Enter, removed
the post-Esc+Enter mid-screen deposit emit and its 2 unit tests.

## Why this didn't work

Two interacting issues:
1. **Per-call cap** (Phase 206): a single `mouseMoveRelative` emit
   moves the cursor at most ~52 px on x-axis regardless of mickey
   count. Two emits sum to maybe 80-100 px. The cursor needs to move
   ~500 px from the top edge to reach mid-screen — that's 6-10
   chunked emits with proper settle in between, not 2.
2. **Code-path divergence**: cursor at a different starting position
   makes moveToPixel choose a different correction strategy. The
   "trusted prediction" path that bypasses detection wasn't entered
   at v0.5.207's cursor positions but IS entered at the post-Phase-232
   positions.

A correct fix would require:
- Many chunked emits (e.g. 10 × `mouseMoveRelative(20, 50)` with 50 ms
  between) to actually move cursor ~200,500 from the top
- Verification screenshot to confirm the cursor really moved
- Possibly probe-based positioning to ensure the cursor reached a
  known location

That's a Phase 232+ project, not a one-line fix.

## What stays

- Phase 231 defensive Esc + Enter — verified working, keeps unlock
  state correct after the swipe
- The diagnostic learnings: cursor IS at top edge post-swipe; the
  fix has to actually move it ~500 px, which the iPad's per-call cap
  resists.

## Phase 232+ candidates (revised)

The post-swipe cursor positioning problem is harder than Phase 232
attempted. Better candidates:
- **Multi-chunked deposit with verification**: 10+ emits with
  per-emit screenshot confirmation. Higher latency cost (~3 s) but
  reliable.
- **Probe-and-correct deposit**: emit, probe, correct until cursor
  is in the target zone. Reuses moveToPixel infrastructure.
- **Skip the swipe altogether when not needed**: only call
  forceHomeViaSwipe when caller has evidence iPad is NOT on home.
  Caller-discipline approach, no algorithm change required.

The third option is cheapest. The bench script that called
forceHomeViaSwipe between every trial (regardless of state) is the
real bug — it's better to use a less destructive home-confirmation
approach.

## State

- Reverted to v0.5.207
- 705/705 tests green
- No code change shipped
- Documentation captures what was tried and why it failed
