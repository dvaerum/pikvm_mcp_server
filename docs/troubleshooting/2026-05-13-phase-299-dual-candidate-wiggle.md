# Phase 299 — dual-candidate wiggle verify (v0.5.231)

**Date:** 2026-05-13
**Status:** SHIPPED. +20 pp at Settings target (the cursor-reaches-target case). Others unchanged because cursor doesn't reach those targets (upstream Phase 50 rate-limit).

## What changed

Phase 297's wiggle-verify only tested the TOP scoring candidate from shape-detect. If the top was a label-text FP, wiggle correctly rejected it, but the next-best candidate (often the bright-mask cursor in pointer-effect mode) was never tried.

Phase 299 enumerates BOTH dark-mask and bright-mask candidates, sorts by score, and wiggle-verifies each in turn. First that passes wins.

Wired into both detection sites:
- `tryOpenLoopShapeDetect` (p0)
- Correction-pass shape rescue (p1+)

## Live click-rate measurement (N=10 × 2 per target)

| Target | v0.5.230 (single-candidate) | v0.5.231 (dual-candidate) | Δ |
|---|---|---|---|
| Books (642, 810) | 15% | 5% (1/20) | −10 pp (variance) |
| TV (773, 810) | 0% | 5% (1/20) | +5 pp (variance) |
| **Settings (905, 810)** | **30%** | **50% (10/20)** | **+20 pp** |
| Maps (1027, 660) | 0% | 0% | unchanged |

Settings — the only target the cursor reliably reaches given Phase 50 rate-limiting — saw a real +20 pp lift. Other targets are still rate-limit-bottlenecked; detection improvements can't help when cursor doesn't physically arrive.

## Why it helps Settings specifically

When the cursor lands on the Settings icon, it goes into pointer-effect mode (light-gray rendering). The dark-mask shape-detect picks up the "Settings" LABEL TEXT below the icon (Phase 296 finding). Wiggle correctly rejects label text. Previously the algorithm fell to "predicted" mode. Now Phase 299 also tries the bright-mask candidate — which catches the light-gray pointer-effect cursor on the icon itself. Wiggle verifies the bright candidate (cursor moves with emit). Algorithm reports cursor position correctly.

For TV/Maps/Books, the cursor doesn't arrive in the locality at all, so neither dark nor bright candidate represents the real cursor.

## Honest current state

| Distance from home | Target | Click rate |
|---|---|---|
| 158 px | Settings (905, 810) | **50%** |
| 289 px | TV (773, 810) | 0-5% |
| ~320 px | Maps area (1027, 660) | 0% |
| 419 px | Books (642, 810) | 0-15% |

Distance correlation still dominates. The detection layer is now clean (Phase 297/299 wiggle eliminates label-text FP). The remaining work is upstream of cursor-shape-detect.

## State

- v0.5.231 shipped.
- Settings target: 50% honest click rate (was 30% with single-candidate wiggle, 85% with label-text FP).
- Other targets unchanged. The 4/5 acceptance gate still not met.
- 723/723 tests pass.

## Constructive next directions (NOT pursued, rule 4)

Same as Phase 298 documented:
1. Reduce Motion accessibility setting (manual iPad-side toggle)
2. Smaller emit chunks (Phase 65 micro mode for far targets)
3. Cursor-belief unstick when null
4. Bigger wiggle amplitude

These all live outside cursor-shape-detect.
