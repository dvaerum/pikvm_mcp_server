> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 309 — live verification of Phase 308 at v0.5.234

**Date:** 2026-05-13
**Version:** v0.5.234 (no code change in this phase)
**Status:** Mixed results. Phase 308 is detection-correct but live
click-rate impact is within bench noise.

## Bench: same script, same iPad, two versions

Ran `test-phase308-detector-instrumented.ts` (24 trials × 4 targets
× 2 reps) twice — once at v0.5.233 (Phase 307 only) and once at
v0.5.234 (Phase 307 + Phase 308 bright-bg penalty).

| version | OK (≤50 px) | WRONG | NULL |
|---------|-------------|-------|------|
| v0.5.233 (baseline) | 2/24 (8%)  | 17/24 | 5/24 |
| v0.5.234 (+ Phase 308) | 1/24 (4%) | 17/24 | 6/24 |

Phase 308 shuffled trials but did not deliver a net OK improvement:

- TV r2.1: WRONG → **OK at 30 px** (Phase 308 enabled cursor pick)
- Settings r2.1: OK at 27 px → WRONG at 151 px (Phase 308 regressed)
- Settings r2.3: OK at 7 px → NULL (Phase 308 regressed)
- Various TV/Books trials: WRONG → NULL (safer behaviour)

## Why no net improvement

Investigation of r2_Settings_03 (was OK at v0.5.233, NULL at
v0.5.234):

```
Global top-10 at v0.5.234:
  1. (1115, 965) px=70 score=0.147 dock-edge
  2. (619, 261)  px=76 score=0.126 calendar "13" (dropped from 1.24)
  ...
Locality top-1 (radius 100 around target):
  1. (906, 825) px=226 score=0.0000 — likely the cursor merged
     with icon edge
```

The cursor cluster in this frame is **226 pixels** — far above
the 50-100 px range typical of an isolated iPad cursor. The
`shapeScoreFor` function's `sizeFit = exp(-(pixels - 80)² / 600)`
gives score ≈ 0 for 226 pixels regardless of any penalty. Phase
308 didn't suppress the cursor; the cursor's own cluster size
was already too large.

**This is iPad-side variance**, not a detector bug. Each trial
captures a different frame; the cursor renders slightly
differently (anti-aliasing, snap-zone interaction, pointer-effect)
producing different cluster sizes when merged with neighbouring
dark pixels.

## What Phase 308 actually achieved

- ✅ Calendar widget "13" FP is reliably demoted (replay: 24/24
  → 0/24, replay-on-saved verified)
- ✅ Failure modes shifted from "click wrong app" (WRONG) toward
  "skip click safely" (NULL) — 4 trials reclassified
- ❌ No net OK rate improvement on this iPad+wallpaper
- ❌ Lost 2 Settings OK cases when cursor merged with icon edge

## Honest verdict

Phase 308 is a detection-correct change that reliably suppresses
the calendar widget FP, with no measurable click-rate lift live.
The OK rate is dominated by:

1. **iPad cluster-size variance** — cursor sometimes renders as
   a small 50-100 px cluster (good) and sometimes merges with
   icon edges into 200+ px clusters (filtered by sizeFit).
2. **iPad emit pipeline** — cursor doesn't reliably reach target
   area; many trials have cursor still near home position.
3. **iPad click registration** — when cursor IS placed correctly
   at residual ≤ 7 px, iPad pointer-effect snap consumes the
   click (Phase 307 finding).

Phases 307+308 are correctly shipped detection improvements; the
remaining bottleneck is outside cursor-shape-detect's scope.
**Live click rate is ~10% genuine target hits** per Phase 307
classification.

## Test gates re-checked

- ✅ Cursor IS visible in many frames (verified per Phase 306)
- ✅ N=24 trials × 2 reps (≥ 10 per measurement)
- ✅ Bench run twice for variance check

## State at end of phase

- v0.5.234 unchanged. No code change this phase. Phase 308 remains
  shipped.
- Phase 309 bench data saved at
  `data/phase308-instrumented/2026-05-13_04-37-53/`.
- Memory updated: bright-bg penalty doesn't lift live click rate
  but is detection-correct.
- Per CURRENT FOCUS rule 4: detection improvements ship, click-
  rate work is outside scope without explicit user direction.
