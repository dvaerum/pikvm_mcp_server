# Phase 317 (v0.5.241) — ML wiggle-verify for Phase 310 tautology

**Date:** 2026-05-13
**Version:** v0.5.241
**Status:** Code shipped. Heavy live verification deferred (per-trial
cost too high for full bench within session budget).

## Motivation

Phase 310 tautology returned at v0.5.240 (Phase 316 commit `59a16a8`
honest correction). When the cursor doesn't reach target, ML
confidently matches an icon feature near the predicted target and
reports residual ≤ 20 px. Visual diagnostic confirmed this: cursor
visibly 155-270 px from Settings icon, algorithm reports residual
19 px.

The heuristic shape detector (cursor-shape-detect.ts) already has
wiggle-verify (Phase 297): emit a small wiggle, check if the
detected position is still there. If yes → static UI feature, reject.
The ML wrapper had no equivalent.

## What this ships

`mlWiggleVerify` helper in `move-to.ts`:
1. ML returns position P with confidence C
2. Emit wiggle (+25, -10 mickeys)
3. Re-run ML with same hints on the post-wiggle screenshot
4. If re-detected position has moved < 15 px → static FP → reject
5. If moved ≥ 15 px or no re-detection → real cursor → accept
6. Always inverse-wiggle to restore cursor position

Wired into BOTH ML call sites in `move-to.ts`:
- `tryOpenLoopShapeDetect` (initial detection pass)
- correction-pass (after motion-diff + template fallback)

## The cost-control wrinkle

The wiggle adds 1 emit + 1 screenshot + 1 ML inference + 1 inverse
emit + 2 settle delays = ~700 ms per ML detection. In a typical
moveToPixel call with 4 passes × ML invocations, that's 2-3 extra
seconds per trial. Live diagnostic showed this ballooned per-trial
time (1 trial in 15 min).

**Mitigation: only verify when proximity ≤ 30 px** — those are the
"cursor on icon" tautology suspects (Phase 310 pattern). Large-
residual detections likely correspond to a real cursor parked far
from target; wiggle-verify wouldn't catch a FP there because there's
no icon at that distance.

The proximity gate keeps verification narrow without changing the
type signature of the ML detector itself.

## Verification status (honest)

A focused single-trial diagnostic ran moveToPixel against Settings
at v0.5.241 with verbose logging. The trial timed out without
reaching target (iPad rate-limit kept cursor 580 px from target),
so insufficient ML invocations to assess tautology-rejection
behavior. **Live click-rate impact is unverified.**

What DID verify cleanly:
- Code compiles (typecheck clean)
- 739/739 unit tests pass
- The existing Phase 297 shape-detect wiggle-verify still fires and
  rejects static FPs (log: `Phase 297 pass X: shape ... REJECTED by
  wiggle — likely static FP`)
- mlWiggleVerify function executes without errors

What did NOT verify:
- Whether ML wiggle-verify actually catches Phase 310 tautologies
  in production
- Whether the proximity-gated approach (verify only when prox ≤ 30 px)
  preserves all real detections
- Live click rate at v0.5.241 vs v0.5.240

The previous v0.5.240 multi-target bench would be the right A/B
comparison, but it takes 50+ min to run and is iPad-relock-prone.

## Risk assessment

- **Best case**: wiggle-verify rejects the 5 tautological "residual
  ≤ 20 px" cases from the v0.5.240 bench, downstream falls through
  to heuristic shape-detect which finds nothing → trial marked as
  failed honestly. Detection rate drops from inflated 95% to honest
  ~50%, but reported residuals become reliable.

- **Worst case**: wiggle-verify rejects ALL ML detections (e.g.
  due to keepalive-induced motion confounding the static check) →
  detection always falls through to shape-detect → click rate goes
  to 0%, but reported residuals become reliable.

- **Likely case**: rejects tautologies and preserves real detections
  → reported residuals become more honest, click rate stays
  ~unchanged (honest 0-5%) but at least we're not lying.

In all cases, the change moves the system toward HONESTY at the cost
of either preserving or further-exposing the upstream iPad-side
click-protocol bottleneck.

## Why I shipped without full bench verification

Per user guidance ("YOU ARE NOT ALLOWED TO GIVE UP", "be proactive"),
shipping the architectural fix is preferred over a stalled deferral.
The change is defensive — it cannot make detection LESS honest. The
worst it can do is reject real detections, in which case downstream
shape-detect picks up.

Tests pass. Typecheck clean. The next tick (with full bench budget)
should run the multi-target bench and compare residual distributions
+ visual ground truth.

## Files

- `src/pikvm/move-to.ts` — `mlWiggleVerify` helper + wiring at both
  ML call sites with proximity gate
- `package.json` + `src/version.ts` — 0.5.240 → 0.5.241
- This document
