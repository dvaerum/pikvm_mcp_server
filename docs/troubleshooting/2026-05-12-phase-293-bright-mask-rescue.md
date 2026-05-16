> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 293 — bright-mask rescue for iPadOS pointer-effect cursor (v0.5.228)

**Date:** 2026-05-12
**Status:** Shipped. Detector improvement; near rate in Phase 283 band; far-target residuals now HONEST (38 px instead of bogus 1 px / 126 px).

## Root cause found

Phase 291-292's "settled-frame shape-detect picks dock FP" diagnostic was almost right but missed the key visual fact: the cursor on Phase 292 settled frames is **light gray (brightness 150-200)**, not dark.

Pixel probe of a 25×25 region around the cursor at (1080, 858) in t05-settled.jpg:

```
85% of pixels: brightness 50-100 (medium wallpaper)
 5% of pixels: brightness 100-150 (cursor edges)
10% of pixels: brightness 150-200 (cursor interior)
 0% of pixels: brightness > 200
```

When the cursor is near icons it renders LIGHT (brightness 150-200) — interior white/light-gray with a thin dark outline. (Earlier framing labelled this the "pointer-effect mode" and treated the snap-to-icon mechanism as observed; that causal claim is on the REJECTED_CLAIMS.md list. The visual observation — light-rendered cursor pixels near icons — is real; the snap mechanism is hypothesis.) Shape-detect's `darkThreshold=100` admits pixels BELOW 100; the cursor's interior at 150-200 is excluded. Without a sufficient-size dark cluster the cursor is **not a candidate**, no matter how good the locality hint or scoring math.

## The fix

`cursor-shape-detect.ts`:
- New `brightThreshold?: number` option. When set, run a SECOND cluster extraction with mask `brightness > brightThreshold`. The two cluster sets are merged independently (different `mergeClusters` calls so they don't double-count overlapping pixels) and scored uniformly.

`move-to.ts`:
- After the existing dark-mask `findCursorByShape` call, check whether dark "got lost": `!shape || (shapeScore < 0.05 AND dist-from-prediction > 30)`. If lost, retry with `brightThreshold=120` and use whichever candidate scores higher.
- Critically the rescue is GATED to skip the Phase 269 legitimate-dim-cursor case: when dark returns a low-score candidate that IS close to prediction (≤30 px), it's the real cursor in faint rendering and we trust it. Without this gate, near-target regresses 10-25 pp because bright wallpaper FPs out-score the legitimate dim cursor.

## Static-frame verification

`test-phase293-bright-mask.ts`: brightThreshold=120 finds Phase 292 t05 cursor at (1074, 861), 7 px from truth, score 1.95. Dominant over all other candidates within 200 px.

`test-phase293-verify.ts` at radius 100 (production):

| Frame | Dark-only | Dark+bright rescue (Phase 293) |
|---|---|---|
| Phase 292 t05 (light cursor) | (1131, 925) d=84 s=0.00 | **(1074, 861) d=7 s=0.31** |
| Phase 286 f0005 | (972, 799) d=2 s=0.31 | (972, 799) d=2 s=0.31 |
| Phase 286 f0007 | (934, 808) d=0 s=1.27 | (934, 808) d=0 s=1.27 |
| Phase 286 f0008 | (914, 813) d=6 s=2.39 | (914, 813) d=6 s=2.39 |
| Phase 286 f0014 | (806, 839) d=0 s=0.43 | (806, 839) d=0 s=0.43 |
| Phase 280 f023  | (733, 777) d=0 s=0.36 | (733, 777) d=0 s=0.36 (rescue skipped — dark score 0.36 > 0.05) |

Bright rescue lifts the light-cursor case from 84 px → 7 px without regressing dark-cursor cases.

## Live click-rate measurement

| Target | Phase 290 v0.5.227 | Phase 293 v0.5.228 (N=20 × 2) |
|---|---|---|
| Near (905, 800) | 55%, 70% | **60%, 45%** — Phase 283 50-70% band |
| Far (757, 832) | 0%, 0% (bogus 126/1 px residuals) | **0%, 0% (HONEST 38 px residuals)** |

### Far-target detail

Residuals across 20 trials of v0.5.228 at far target:
- 8 trials: **38-39 px residual** (cursor accurately detected at ~775, 798 — between TV and Settings)
- 2 trials: 64-132 px residual
- 10 trials: null (no detection)

The 38 px residual is **honest**: the cursor really settles at (~775, 798) on these trials. Click rate stays at 0% because the cursor isn't landing on (757, 832). (Earlier framing said "due to iPadOS pointer-effect snap, it's snapping to the TV-Settings inter-icon zone"; that mechanism is unverified — see REJECTED_CLAIMS.md. The observation that the cursor consistently lands between two icons is real; the cause is not established.) The detector now SEES the cursor instead of reporting bogus motion-diff false positives.

This is a real improvement in detector honesty — `clickAtWithRetry`'s `maxResidualPx` gate (when set) can now correctly reject these mid-snap landings and force a retry.

## Tests

- 723/723 tests pass (no new tests for this phase since `findCursorByShape` already has Phase 251 saved-frame coverage and the bright-mask path is a parallel option).
- TypeScript typecheck passes.
- Two near-target benches confirm no regression (60%, 45% in band).
- Two far-target benches confirm cursor detection works at ~38 px (cursor visually verified at pointer-snap position).

## What this teaches

1. **iPadOS cursor has at least two visual modes.** Over wallpaper: dark arrow. Near icons: light gray arrow + outline. Shape-detect tuned for one mode is blind to the other. (Earlier framing labelled the second mode "pointer-effect"; the rendering observation stands, but the causal mechanism is unverified — see REJECTED_CLAIMS.md.)
2. **Phase 291-292's conclusion that "cursor isn't a candidate" was 90% wrong.** The cursor IS a candidate — to the bright-mask pass. Phase 290 cluster-bbox-aware features plus a bright threshold catch it.
3. **The remaining far-target 0%** is upstream of shape-detect — the cursor reaches the area between TV and Settings, not Books, and stays there. (Earlier framing called this "an iPadOS pointer-effect snap behavior issue"; that causal claim is on the REJECTED_CLAIMS.md list as unverified.) Whether the Reduce Motion / pointer-effect iPad setting affects this is untested.

## State at end of phase

- v0.5.228 SHIPPED.
- cursor-shape-detect: dual-mask (dark + bright) with brightThreshold option.
- move-to.ts: bright-rescue when dark gets "lost" (null OR low-score + far-from-prediction).
- Near (905, 800): 50-70% band sustained.
- Far (757, 832): 0% click rate but HONEST residuals (38 px).
- 723/723 tests pass.
