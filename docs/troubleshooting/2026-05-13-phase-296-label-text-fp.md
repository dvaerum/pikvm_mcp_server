> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 296 — CORRECTION: Phase 294's 95% is a label-text false positive

**Date:** 2026-05-13
**Status:** **Critical honesty correction.** Phase 294 click-rate claims are misleading. The algorithm is NOT finding the cursor — it's finding the app-icon LABEL TEXT below the target.

## What I found

`test-phase296-books-diag.ts` (N=5 verbose Books target) + `test-phase296b-settings-verify.ts` (N=5 Settings target) saved per-trial settled frames and compared the algorithm's reported `finalDetectedPosition` to the cursor's VISUAL position on the post-frame.

### Trial 1, Books target (642, 810)
- Algorithm: cursor at (652, 840) r=32 → **claimed HIT**
- Visual: cursor at ~(845, 813) — **207 px from target, NOT at Books**
- What's at (652, 840)? The dark "Books" LABEL TEXT below the icon

### Trial 3, Settings target (905, 800)
- Algorithm: cursor at (906, 825) r=24 → **claimed HIT** across 4 shape passes
- Visual: cursor at ~(1145, 825) — **240 px from target, at the right edge of screen**
- What's at (906, 825)? The dark "Settings" LABEL TEXT below the icon

### Trial 1, Settings target (905, 800)
- Algorithm: (879, 822) r=34 → **claimed HIT** (just barely)
- Visual inspection needed but pattern matches: label text at (~895, 840) is ~22 px below target center

## The systematic FP

iPadOS app icons display a LABEL TEXT below the icon (e.g., "Books", "TV", "Settings", "Maps") rendered as small dark characters on the wallpaper. Each label is:
- Cursor-sized: ~50-80 dark pixels in connected component
- Bbox aspect: roughly square (e.g., "Books" 5 chars wide, 1 line tall — but kerning + boldness give ~30×15 bbox per word, square-ish)
- Asymmetric: text has irregular mass distribution → asymmetry > 1
- Off-centroid: characters have varied widths → centroid offset from bbox center
- Grayscale: text rendering is dark gray on light wallpaper, low chroma

The label text passes EVERY cursor-shape-detect feature. The Phase 290 cluster-bbox-aware refactor doesn't filter it out. The Phase 293 bright-mask rescue doesn't filter it out. The Phase 294 p0 shape-detect locks onto it.

When the locality hint is `predictedPostOpen` (typically near the target icon center), the locality gate (radius 100) INCLUDES the label text ~30 px below. Shape-detect picks it. Algorithm reports it as cursor.

## What this means for Phase 294's numbers

| Target | Phase 294 "hit rate" | Likely actual click correctness |
|---|---|---|
| Settings (905, 800) | 95% (claimed) | Unknown — cursor may be elsewhere; "Settings" label text always at ~r=30 |
| Books (642, 810)    | 15% | Most "hits" likely Books label-text FP; cursor near home |
| TV (773, 810)       | 60% | Many "hits" likely TV label-text FP |
| Maps area           | 55% | Maps icon row gap |

The "hits cluster at 12-32 px residual" pattern in Phase 295 is consistent with each target's icon-label position being ~20-32 px below the icon center: the algorithm finds the label text and reports it as cursor.

**The honest measure of correctness is NOT residual to claimed position — it's whether the right app opens when click_at fires.** Phase 87 explicitly warned about this: "screenChanged ≠ correct-element-hit." I missed it.

## What's still true

- Phase 290 cluster-bbox-aware refactor: structurally correct, no regression
- Phase 293 brightThreshold option: catches light-rendered cursor (near icons) when truly visible. (Earlier framing called this "pointer-effect light cursor"; the pointer-effect mechanism is on the REJECTED_CLAIMS.md list as unverified. The light-rendering observation stands.)
- Phase 294 shape-detect at p0: improves detection chain but is fooled by label text

## What's NOT true

- "Near click rate is now 95%" — UNVERIFIED. Algorithm reports 95% but the cursor isn't where the algorithm says. A real click at target coordinates may activate the icon (when cursor happens to land nearby — earlier framing "in pointer-effect snap" is on the REJECTED_CLAIMS.md list as unverified) or activate the wrong thing (when cursor is at icon-row edge).

## Memory entry corrected

The `project_phase_294_breakthrough.md` memory needs urgent correction. The "95%" claim is reading off algorithm's reported residual, which is an FP-influenced measurement, not real click landing.

## Why no immediate fix shipped

The label-text FP is a SYSTEMATIC issue that needs a real discriminator. Possible approaches (NOT yet implemented):

1. **Wiggle verification**: emit a small move; if candidate doesn't move with it, it's static FP. Cost: extra emit + screenshot per detection (~200ms).
2. **Two-pass differential**: compare cluster positions at t and t+200ms; static features filter out. Same idea, simpler.
3. **Stroke-topology**: cursor has an arrow tip (one endpoint where strokes converge). Label text has multiple endpoints (one per character stroke). Detect by skeleton endpoint count.
4. **Aspect threshold tightening**: but label text often passes the aspect ratio filter.

Implementing wiggle verification is the highest-leverage fix. Defer to next tick.

## State at end of phase

- v0.5.229 (Phase 294) still shipped — no regression, but its "95% near" headline is misleading.
- Memory updated to flag the label-text FP.
- New ticks should not quote "95% near" without verifying click correctness via wiggle-test or screenChange semantics.
- 723/723 tests pass.
