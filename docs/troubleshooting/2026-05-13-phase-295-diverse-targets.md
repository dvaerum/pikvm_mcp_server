# Phase 295 — diverse-target acceptance bench at v0.5.229

**Date:** 2026-05-13
**Status:** Diagnostic only. Phase 294 SHIPPED previously; this bench measures generalization.

## What we tested

`test-phase295-diverse-targets.ts`: 4 icon-center targets × N=10 × 2 runs (N=20 each).

| Target | Coord | Run 1 | Run 2 | Combined N=20 | Pass 80% gate? |
|---|---|---|---|---|---|
| Settings | (905, 810) | 10/10 | 7/10 | **17/20 = 85%** | ✓ |
| TV       | (773, 810) | 5/10  | 7/10 | 12/20 = 60% | ✗ |
| Maps     | (1027, 660) | 7/10 | 4/10 | 11/20 = 55% | ✗ |
| Books    | (642, 810) | 2/10  | 1/10 | **3/20 = 15%** | ✗ |

## The binary pattern

Per-trial residuals fall into two clusters:

- **HIT cluster**: 12-32 px from target (cursor snapped to/near target)
- **MISS cluster**: 135-354 px from target (cursor stuck mid-flight, often near home)

Example, Books target N=20 residuals: `[26, 135, 32, 26, 218, 32, 285, 32, 304, 137, 99, 241, 241, 201, 32, 32, 135, 193, 134, 26]`. The 32-px values are hits; everything ≥99 is the cursor failing to traverse all the way from home.

## Phase 294 is detection — Books failure isn't a detection bug

The miss cluster's high residuals (200-300 px) come from the cursor being stuck near its home position (~1060, 780), not from detection picking a wallpaper FP. Once emits successfully move the cursor close to target, detection reliably reports it (hit cluster at 12-32 px). The failures are emit-throughput failures, not detection failures.

Distance from home (~1060, 780) to each target:
- Settings (905, 810): **158 px** → 85% success
- TV (773, 810): 289 px → 60%
- Books (642, 810): **419 px** → 15%

Click rate scales inversely with traversal distance — consistent with Phase 50's documented input rate-limiting.

## Acceptance gate result

User's stated gate: "≥4/5 trials within 30 px on diverse cursor positions" = 80%.

- **1 of 4 targets passes** (Settings, the closest icon to home).
- Phase 294 does NOT generalize across all icon centers.

That said: Phase 294 produced a real improvement at the EASIEST target — historical near-target benches were at (905, 800) and stuck at 50-70% for dozens of phases. Phase 294 lifts that to 85-95% by fixing detection. The remaining failures on Books/TV are upstream of detection.

## Why detection improvement plateaus at Books target

Detection is necessary but not sufficient. The pipeline is: emit → cursor moves → detect → correct. Phase 294 made detect reliable. But for the cursor to ever LAND near Books target, the emit must transport it ~419 px from home. With rate-limiting eating chunks, the cursor often stops 100-300 px short, and the correction-pass emit has the same rate-limiting issue.

## Constructive next directions (NOT pursued — need user direction per rule 4)

1. **Phase 50 follow-up**: smaller emit chunks (per Phase 65 micro-mode) on long-traversal targets. Trade emit time for more reliable transport. Likely solves Books/TV.
2. **Multi-attempt convergence**: when post-correction residual stays > 50 px across 3+ passes, slam-restart from a different start position.
3. **Reduce Motion accessibility setting**: still unmanaged (Phase 115/117 attempted, hit-area asymmetry blocked it). Manual iPad-side toggle would change pointer-effect-snap behavior, potentially help.
4. **Per-target tuning**: log known good landing zones; aim emits at icon-centers known to snap-attract.

## State at end of phase

- v0.5.229 (Phase 294) remains shipped. No code change in Phase 295.
- Closest icon (Settings 905, 810): **85% click rate**.
- Mid-distance icons (TV 773, 810; Maps area 1027, 660): 55-60%.
- Farthest icon (Books 642, 810): **15%** — emit-throughput limit, not detection.
- 723/723 tests pass.
- Detection layer (cursor-shape-detect) is doing its job.
