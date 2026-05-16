> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 298 — honest click-rate bench at v0.5.230 (post-wiggle)

**Date:** 2026-05-13
**Status:** Measurement only. No code change. Documents the REAL click rate after Phase 297's wiggle-verify removed the systematic label-text FP.

## What we measured

Phase 295 bench (4 icon-center targets × N=10 × 2) re-run at v0.5.230 with Phase 297 wiggle-verify enabled. Same script (`test-phase295-diverse-targets.ts`), same iPad state, just newer code.

## Combined N=20 results

| Target | Phase 295 v0.5.229 (FP-inflated) | Phase 298 v0.5.230 (wiggle honest) | Δ |
|---|---|---|---|
| Books (642, 810)    | 15% | 15% (3/20) | unchanged |
| TV (773, 810)       | 60% | **0% (0/20)** | **−60 pp** |
| Settings (905, 810) | 85% | **30% (6/20)** | **−55 pp** |
| Maps (1027, 660)    | 55% | **0% (0/20)** | **−55 pp** |

## Interpretation

The dramatic drops for TV, Settings, and Maps confirm Phase 295's higher numbers were systematically inflated by app-icon LABEL TEXT false positives that Phase 297's wiggle now correctly rejects.

- **Settings**: 85% → 30%. The 55 pp drop is the magnitude of the label-text FP. The remaining 30% are likely real-cursor detections (motion-diff catching cursor on Settings icon) OR genuine wiggle-verified shape picks where the cursor truly is at the icon.
- **TV**: 60% → 0%. ALL prior TV "hits" were the "TV" label-text FP. With wiggle, no true detection makes it through.
- **Maps**: 55% → 0%. Same pattern as TV.
- **Books**: 15% → 15%. Anomalous. Possible reasons: Books label text shaped differently (5 chars, asymmetric "Books"); the few honest hits are real-cursor; or both. Either way, Books's pre-Phase 297 number was already a real baseline.

## Why Settings retained 30% while TV/Maps went to 0%

Hypothesis: Settings is the closest icon to home (1060, 780). The cursor reaches Settings vicinity more reliably (the "Phase 50 rate-limiting" framing — distance scales failure rate — is on the REJECTED_CLAIMS.md list as causation-unproven). When the cursor IS at the Settings icon, motion-diff catches it at the residual 24-27 px range (close to label-text position but real). For TV (290 px from home), Maps area (320 px from home), the cursor barely reaches the locality — most detection attempts fail.

## What this means for the user's acceptance gate

User's stated gate: "≥4/5 trials within 30 px on diverse cursor positions" = 80%.

**No target passes the gate.** Settings at 30% is the best.

The honest current state of cursor-shape-detect + click pipeline:
- Detection layer (cursor-shape-detect) works correctly when cursor is present and not in label-text FP region
- Wiggle verification eliminates label-text FPs systematically
- The remaining click-rate failures come from cursor not reaching target. (Earlier framing listed "Phase 50 rate-limit, pointer-effect snap, emit chunk loss" as causes; the first two are on the REJECTED_CLAIMS.md list as unverified.)

## Why this is BETTER than a 95% headline

A 95% headline that's actually FPs is dangerous:
- clickAtWithRetry's residual gate accepts the FP position → fires a click at target → wrong app activates
- Users believe the click pipeline works → don't notice silent mis-clicks
- Memory & docs propagate the false rate

A 0-30% HONEST rate is dangerous in a different way (worse UX), but:
- clickAtWithRetry now correctly REFUSES to click when detection failed
- maxResidualPx gate fires correctly
- The user knows the system has limits and can adjust expectations

## Acceptable next directions (per rule 4, need user direction)

1. **Reduce Motion accessibility setting**: was hypothesised to disable "pointer-effect snap" (REJECTED_CLAIMS.md: mechanism unverified). Phase 115 attempted via Spotlight; Phase 117 hit a UI obstacle. Manual physical interaction on the iPad would unblock — but whether the setting affects click behaviour we care about is untested.
2. **Phase 50 emit-throughput fix**: smaller emit chunks (Phase 65 micro mode) might transport the cursor more reliably to distant targets. (Original framing called this a "rate-limit fix"; the rate-limit mechanism is on the REJECTED_CLAIMS.md list as unverified.)
3. **Cursor-belief recovery**: when wiggle rejects all candidates AND motion-diff fails, the algorithm now correctly returns null. clickAtWithRetry's retry logic could trigger an "unstick" emit (slam-to-known-position) and retry.
4. **Wiggle amplitude tuning**: 25 mickeys may not always move the cursor when near an icon (earlier framing "pointer-snapped cursors" assumes a mechanism on the REJECTED_CLAIMS.md list). A 50-mickey wiggle might verify more reliably, at the cost of moving the cursor further from target.

Not pursued. Phase 297's wiggle is the right architectural addition; tuning is for a future tick.

## State at end of phase

- v0.5.230 (Phase 297) shipped. No regression on Books (15% both before and after).
- Settings honest rate: 30% (was 85% inflated).
- TV / Maps area honest rate: 0% (were 60/55% inflated).
- 723/723 tests pass.

## Lessons (for memory)

1. **"Residual to claimed position" is FP-vulnerable.** A bench that doesn't verify visually is measuring algorithm self-consistency, not click correctness. Phase 87 said it; I ignored it for 3+ ticks.
2. **Wiggle-verify is robust against static UI FPs.** A 35-px emit doesn't leave a cluster at the same pixel unless the cluster is static UI. This is the simplest and most reliable label-text discriminator.
3. **The cursor's click rate ceiling is upstream of detection** for this iPad. The detector now works correctly but cursor convergence isn't always achievable through detect-and-correct.
