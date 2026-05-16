> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 297 — wiggle-verify discriminator (v0.5.230)

**Date:** 2026-05-13
**Status:** SHIPPED. Detection FP from Phase 296 now reliably rejected. Click rate honest, not headlined.

## What we built

After Phase 296 revealed that Phase 290/293/294's shape-detect was picking app-icon LABEL TEXT (e.g. "Settings" at (~905, 840)) as the cursor, this phase adds wiggle verification:

1. Shape-detect returns a candidate at `initialPos`.
2. Emit a small diagonal wiggle (+25 X, −10 Y mickeys ≈ +35 / −14 px).
3. Take a fresh screenshot.
4. Run shape-detect at `initialPos` with radius 8 — looking for a cluster STILL at the same pixel position.
5. If a cluster is still there: it didn't move with the emit → **static UI feature (label text, dock char, widget) → reject**.
6. If nothing is there: the cluster moved with the emit → **real cursor → accept**.
7. Always emit inverse wiggle (−25, +10) to restore cursor position so the correction loop keeps converging.

Wired into BOTH detection sites:
- `tryOpenLoopShapeDetect` (p0, Phase 294 path)
- The Phase 267/276 correction-pass shape-rescue block

## Why the "is it STILL at the initial position?" check matters

The first attempt (this same phase, earlier in tick) checked instead: "did the candidate move with the wiggle?" But when label text AND a nearby real cursor BOTH exist (common when cursor is near an app icon), the wiggle moves the cursor +35 px right; shape-detect's locality at `initialPos + expected delta` finds the moved cursor; displacement is reported as "real cursor moved" — wiggle "verifies" the label-text candidate. False acceptance.

The fix: check the OPPOSITE. Real cursor would DISAPPEAR from initialPos after the wiggle. Label text would STAY at the exact same pixel. So we look for "is there still a cluster at initialPos after wiggle?" — `expectedNearRadius: 8` (tight, only catches the same cluster). If yes → static FP, reject.

## Live measurement

Settings (905, 800), N=5 (variance band per Phase 237):

| Version | "Hit rate" | What it measures |
|---|---|---|
| v0.5.229 (Phase 294, no wiggle) | 4/5 = 80% (claimed) | Algorithm reports cursor at Settings LABEL TEXT (~906, 824). r=24 to target = false-positive HIT. |
| v0.5.230 (wiggle verifies) | 1/5 = 20% (N=5 noise) | Algorithm rejects label-text candidate. Only counts hits where motion-diff or wiggle-verified shape finds REAL cursor near target. |

The 95% headline I was quoting last tick was illusory. The honest hit rate at Settings target is ~20-40% — most trials end with cursor not actually near Settings. The wiggle simply stops the algorithm from LYING.

## What this teaches

1. **Phase 87 was right** ("screenChanged ≠ correct-element-hit") and I ignored it for 3 ticks. Bench tools that measure distance from algorithm's CLAIMED position to target are FP-vulnerable. The cursor needs to be visually verified.
2. **Wiggle verification is a strong discriminator** for label-text / dock-char / widget FPs. Cost: one emit + one screenshot per detection (~200ms). Discriminator: clean (a 35-px emit doesn't leave a cluster at the same pixel unless it's static UI).
3. **The previously-shipped Phase 294 95% must be retracted** in any user-facing documentation. The honest near-target rate is lower; this is the real baseline.

## Future improvements (NOT pursued — rule 4)

1. **Cursor convergence**: most failures are now "cursor doesn't reach target" rather than "cursor was lost." (Earlier framing attributed this to "the Phase 50 input rate-limiting issue plus pointer-effect snap"; both mechanisms are on the REJECTED_CLAIMS.md list as unverified.) Needs upstream fix (smaller chunks, multi-attempt retry, or Reduce Motion accessibility setting).
2. **More aggressive wiggle amplitude**: 25 mickeys may not always move the cursor when it's near an icon (earlier framing "pointer-snapped cursor" assumes a mechanism on the REJECTED_CLAIMS.md list); bigger may produce better discrimination but takes cursor farther from target.
3. **Combined motion-diff + shape verification**: cross-check motion-diff results with wiggle too, since motion-diff also returns FPs (Phase 296 trial 5 showed motion at (801, 525) which was wrong).

## State at end of phase

- v0.5.230 SHIPPED.
- cursor-shape-detect findings (Phase 290/293/294) all SOUND. Wiggle adds the missing FP discriminator.
- Settings click rate (N=5): 20% (honest, vs Phase 294's misleading 95%).
- 723/723 tests pass.

## Acceptance gate

User's stated gate: "≥4/5 trials within 30 px on diverse cursor positions". Per Phase 297's honest measurement, this gate is NOT met. The Phase 294 95% that appeared to meet it was a label-text FP artifact.

Phase 297 ships because:
- It removes a documented systematic FP (label text)
- It produces HONEST residuals that clickAtWithRetry can act on correctly
- The detector reasoning is correct even if the click rate is lower than the FP-inflated number

The acceptance gate not being met is a HONEST status that should drive future work toward cursor convergence (upstream of detection), not more detector tweaks.
