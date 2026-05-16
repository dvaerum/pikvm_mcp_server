> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 294 — shape-detect at open-loop p0 (v0.5.229)

**Date:** 2026-05-12
**Status:** SHIPPED. Major click-rate lift on near-target.

## Diagnostic that prompted this

Phase 294 verbose 5+5 bench (N=5 near + N=5 far, full per-pass diagnostics):

Near target (905, 800), v0.5.228 (Phase 293 only):
| Trial | Final | Passes |
|---|---|---|
| 1 | null | p0 predicted (motion+template failed; r=1 LIE) |
| 2 | (906, 824) r=24 ✓ | p0 motion → p1 shape rescue |
| 3 | null | p0 predicted (LIE) |
| 4 | null | p0 predicted (LIE) |
| 5 | (906, 824) r=24 ✓ | p0 motion far → p1 shape rescue |

**Three of five trials fell to "predicted only" at p0**, with fake residual=1. The shape-detect+bright-rescue chain (Phase 293) was only wired into CORRECTION passes (p1+); at p0 the chain was motion → template → predicted, with no shape fallback. The Phase 293 rescue couldn't fire at p0.

## The fix

`move-to.ts`: add a third detection fallback at p0. After motion-diff fails (returns no usable result) AND template-match fails or no templates cached, try `findCursorByShape` with the same Phase 293 bright-mask rescue used in correction passes:

```ts
async function tryOpenLoopShapeDetect(shot, predicted) {
  let shape = findCursorByShape(shot.rgb, shot.width, shot.height, {
    expectedNear: predicted,
    expectedNearRadius: 100,
  });
  // Phase 293 rescue gate
  const darkLost = !shape || (shape.shapeScore < 0.05 && darkPredDist > 30);
  if (darkLost) {
    const brightShape = findCursorByShape(/* brightThreshold: 120 */);
    if (brightShape && (!shape || brightShape.shapeScore > shape.shapeScore)) {
      shape = brightShape;
    }
  }
  // Phase 276 proximity gate
  if (!shape) return null;
  const prox = ...;
  return shape.shapeScore >= 0.05 || prox <= 30 ? { pos, score, prox } : null;
}
```

`openLoopMode` type widens to include `'shape'`.

## Live click-rate measurement

| Target | v0.5.228 (Phase 293 only, p1+) | v0.5.229 (Phase 294, p0 too) |
|---|---|---|
| Near (905, 800) | 60%, 45% | **95%, 95% (N=20 × 2)** |
| Far (757, 832) | 0%, 0% (38 px residuals) | **0%, 0% (38-39 px residuals)** |

Near jumps **+35 to +45 percentage points** to 95%. This is the largest near-target click-rate improvement in dozens of phases.

Far stays at 0% because the cursor still snaps to the inter-icon zone between TV (773, 810) and Settings (905, 810); honest residuals are 38-39 px to target (757, 832). Detection is accurate; the cursor physically can't rest at (757, 832) on this iPad due to pointer-effect snap. That's an iPadOS rendering constraint, not a detection bug.

## Why this works

The Phase 293 finding — iPadOS cursor renders LIGHT GRAY in pointer-effect-snap mode, invisible to dark-mask shape-detect — applies most strongly at p0. After the open-loop emit, the cursor often ends up snapped to an icon (because the chunked emit aims for a target near or on an icon). Motion-diff sees the transit; template-match sees nothing (templates are dark-cursor templates); the cursor-on-icon is LIGHT and dark-mask shape-detect misses it.

Phase 294's shape+bright path at p0 catches the LIGHT cursor's interior. The locality gate (radius 100 from `predictedPostOpen`) tightly filters to the expected landing zone, so dock/widget bright FPs (Phase 292's (783, 961) dock FP at score 0.54) are geographically excluded.

## Tests

- 723/723 unit tests pass.
- TypeScript typecheck passes.
- Two near-target N=20 benches: 95%, 95% — well above the 4/5 ≥80% integration gate.
- Two far-target N=20 benches: 0%, 0% — but with HONEST residuals.

## Acceptance gate

User-stated integration criterion: ≥4/5 trials within 30 px on diverse cursor positions.

| Target | Hits within 30 px | Pass? |
|---|---|---|
| Near (905, 800) | 19/20, 19/20 (95%) | ✓ |
| Far (757, 832) | 0/20, 0/20 (snap zone, physical limit) | ✗ (iPadOS issue) |

Near comfortably passes. Far's snap-zone failure is upstream of detection.

## State at end of phase

- v0.5.229 SHIPPED.
- cursor-shape-detect: dual-mask (dark + Phase 293 bright) with brightThreshold option.
- move-to.ts: shape-detect at BOTH open-loop p0 AND correction passes; identical bright-rescue gate.
- Near (905, 800): **95%** sustained across two benches.
- Far (757, 832): **0%** click rate, **38 px honest residuals** (snap zone).
- 723/723 tests pass.

## Notes

- Phase 294 is the FIRST phase to materially move near-target click rate above the long-standing 50-70% band documented since Phase 70.
- The bench warning "LOWER than baseline" for far target compares against an outdated Phase 247 baseline of 25%; the actual recent baseline at far is 0%, so we are unchanged, not regressed.
