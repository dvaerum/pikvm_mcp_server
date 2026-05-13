# Phase 305 — null-detection training capture + slam-unstick (DEFERRED)

**Date:** 2026-05-13
**Version:** v0.5.232
**Status:** Capture mechanism SHIPS opt-in. Slam-unstick SHIPS opt-in
with a strong "DO NOT USE without iPad keepalive" warning.
Cursor-shape-detect itself **NOT** modified this tick — bench was
confounded by iPad autolock state.

## What changed

Two opt-in options on `clickAtWithRetry`, both gated on
`requireVerifiedCursor && finalDetectedPosition === null`:

### `captureNullDetectionFrames: boolean` (works as designed)

Saves screenshot + JSON sidecar to
`data/null-detection-snapshots/{ts}_t{x}-{y}_a{attempt}.{jpg,json}`
every time a click is skipped because the cursor wasn't verified
after the move. The user's framing: *"each cases which are good for
testing and training of the mouse pointer llm we are talking about
training."*

Sidecar fields: `target`, `attempt`, `timestampISO`, `version`,
`belief.{position, variance}`, full `moveResult` diagnostics
(`predicted`, `emittedMickeys`, `usedPxPerMickey`, `chunkCount`,
`strategy`, `finalDetectedPosition`, `finalResidualPx`,
`passesSinceLastVerification`, `bailedToBestPass`, per-pass
`diagnostics`).

Best-effort; capture failure never breaks the click path.

### `enableSlamUnstickOnNull: boolean` (DEFAULT OFF, USE WITH CARE)

When true, every null-detection skip calls `slamToCorner(client,
{ corner: 'top-left', paceMs: 60 })` then
`client.belief.reset({x:0, y:0}, 1.0)` before the next retry.

**Observed risk (live bench, Books target, 2026-05-13):** When
`enableSlamUnstickOnNull` was on, one trial fired 4 consecutive slams
across the retry loop and the iPad entered lock-screen state. Across
the 6 Books trials I ran (before stopping the bench):

| Trial | success | attempts | nullSkips | slamFires |
|-------|---------|----------|-----------|-----------|
| 1     | false   | 4        | 0         | 0         |
| 2     | false   | 4        | 0         | 0         |
| 3     | false   | 4        | 4         | 4         |
| 4     | **true**  | 1      | 0         | 0         |
| 5     | false   | 4        | 0         | 0         |
| 6     | false   | 4        | 0         | 0         |

Trial 3's null-detection captures all show the iPad **lock screen**
(`Wed 13 May / 05:26`, large clock, no app icons). The cursor IS
visible in each captured frame (small dark arrow mid-left), but
there's no app to click — verifying the click rate at 0/5 cases
where the screen has no target. The bench called `unlockIpad()`
once at start and `ipadGoHome({forceHomeViaSwipe: true})` per trial;
neither re-unlocks an already-locked iPad.

It's unclear whether the slams *caused* the lock or simply happened
during it. Either way, the slam path was never demonstrated to help.

Per Phase 45 memory: aggressive slam-to-edge can trigger iPad system
gestures. `paceMs: 60` is supposed to mitigate, but doesn't appear
to prevent the lock-screen confound observed here.

## What this means for cursor-shape-detect

Looking at the captured sidecars (Books.3 attempts 1-4):

```
diagnostics: [{
  pass: 0,
  mode: "predicted",
  detectedAt: { x: 641.5, y: 810 },
  residualPx: 0.5,
  reason: "template-match below threshold across 4 templates
           (motion: no clusters in 4-90px size range)"
}]
```

The function ran open-loop in `predicted` mode (math estimate of
post-emit landing — NOT a verified detection). Open-loop verification
(template + motion-diff) failed. `currentPos` became the predicted
target ≈ `(641.5, 810)`, so residual to target ≈ 0.5 px.

The correction loop at `move-to.ts:2048` exits when `residual <
stopPx`. With residual ≈ 0, **the correction loop exits before
running any pass — including cursor-shape-detect, which only runs as
a correction-pass fallback at `move-to.ts:2271+`**.

So in these null-detection cases, **cursor-shape-detect was never
called**. The function returned `finalDetectedPosition: null` not
because shape-detect failed, but because the correction loop bailed
on a zero-residual `predicted` position without ever attempting the
shape fallback.

This is a real bug — but it doesn't validate or invalidate
cursor-shape-detect itself. To honestly evaluate the detector, the
correction loop's early-exit needs to require
`passesSinceLastVerification === 0` (currently only the
icon-tolerance exit at line 2024 has this guard).

## Honest verdict for this tick

- **Capture mechanism**: ships as designed. Generated 4 valid
  training frames + sidecars during a single bench run.
- **Slam-unstick**: ships opt-in. NOT recommended without further
  investigation; correlates with iPad autolock during testing.
- **Cursor-shape-detect**: NOT modified. The bench did not exercise
  it because the correction loop exited at residual ≈ 0 in predicted
  mode. The lock-screen confound also prevents drawing any
  conclusion about its performance on home-screen frames.

Per user CURRENT FOCUS rule 4: "Honestly report failure of the
above and stop — do NOT pivot to a different detection approach
without explicit user direction." This is that report.

## Next-tick candidates (not pursued this tick)

1. **Fix the early-exit guard at `move-to.ts:2048`** — require
   `passesSinceLastVerification === 0` (or `finalDetectedPosition !==
   null`) before allowing the stopPx exit. Without this, correction
   passes that include cursor-shape-detect never run when open-loop
   falls back to `predicted` and predicts ≈ exactly the target.
2. **Add `unlockIpad()` to bench per-trial**, or shorten test
   duration, to remove the autolock confound.
3. **Capture confident-but-wrong failures** (where
   `finalDetectedPosition` is non-null but click misses). Currently
   only null cases are captured; the label-text-FP failure mode
   produces non-null wrong positions which the capture path skips.

None of these are cursor-shape-detect modifications — they are
infrastructure work that needs to land before cursor-shape-detect
can be honestly benched against the production click pipeline.

## State at end of phase

- v0.5.232 shipped.
- 723/723 unit tests pass; typecheck clean; `nix flake check` passes.
- `cursor-shape-detect.ts` UNCHANGED — not modified this tick.
- Two opt-in helpers added: `captureNullDetectionEvidence`,
  `slamUnstick`. Pure functions, exported for testability.
- Defaults preserve pre-Phase-305 behaviour. No existing caller
  changes.
- Bench script: `test-phase305-slam-unstick.ts`.
- Captured frames land under `data/null-detection-snapshots/`. Not
  committed to git (under `data/` gitignore rule).
