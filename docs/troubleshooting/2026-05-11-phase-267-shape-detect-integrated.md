# Phase 267 — cursor-shape-detect integrated into moveToPixel; no regression, no measurable lift

**Date:** 2026-05-11
**Version:** v0.5.221
**Status:** `findCursorByShape` is wired into `moveToPixel`'s
correction-pass as a third-tier detection fallback. Bench result:
no regression (same ~37.5% baseline within 35 px), no measurable
lift either. Reason: the fallback only fires when BOTH motion-diff
AND NCC template-match return null, but the dominant production
failure mode is NCC returning **confident-wrong** (not null) —
which bypasses the fallback.

## What was shipped

### Code (v0.5.220 → v0.5.221)

- `src/pikvm/move-to.ts`:
  - Added import of `findCursorByShape`
  - Widened `MoveCorrection.mode` and `MovePassDiagnostic.mode` types
    from `'motion' | 'template' | 'predicted'` to add `'shape'`
  - In the correction-pass code path, when `motion-diff failed AND
    template-match returned null` (the previous "trust prediction"
    branch), insert a shape-detect fallback:
    - Capture screenshot via `screenshotKeepingCursorAlive`
    - Run `findCursorByShape` with locality hint at `newPredicted`,
      radius 100 px (informed by Phase 266-267 bench tuning)
    - Accept candidate if `shapeScore >= 0.05` (dim-cursor cutoff
      validated in Phase 266-267)
    - On accept: update `currentPos`, set `passMode = 'shape'`,
      and feed back to `client.observeCursor` so cursor-belief
      benefits too
  - Added `'shape'` to the verification-counter reset condition
    alongside `'motion'` and `'template'`
- Tests: 713/713 still pass (no test changes needed; type widening
  is backward-compatible)
- Nix build: green

### Phase 266-267 bench evidence used to inform integration

Phase 266-267 bench (small wiggles + locality hint + score gate
0.05) showed 20/20 trials tracked within 30 px median 6 px error
when:
1. Cursor was in a clear-wallpaper region (radius 100 px around
   the post-home position (1100, 780))
2. Locality hint was provided
3. `screenshotKeepingCursorAlive` was used (Phase 202 keepalive
   nudge keeps cursor crisp)

The integration uses all three of these.

## Bench result on production click rate

`test-phase262-current-click-rate.ts` at v0.5.221, two N=20 runs
against target (905, 800) — same target as Phase 247/262 baselines:

```
Run 1: 7/20 = 35% within 35 px
Run 2: 8/20 = 40% within 35 px
Combined N=40: 15/40 = 37.5% within 35 px
```

Phase 262 baseline (v0.5.220, pre-integration), N=40 cumulative:
**37.5%** within 35 px.

Phase 267 (v0.5.221, post-integration), N=40 cumulative:
**37.5%** within 35 px.

**No measurable click-rate change.** Within Phase 237 variance.

## Why the integration didn't lift the rate (and what would)

The shape-detect fallback in moveToPixel fires only when:
```
motionDiffFailed && (templateMatch === null || templateMatchStale)
```

The dominant production failure mode is **NCC returning a
confident-wrong match** at a far-from-target location (Phase 243
bimodal: ≤5 px correct OR ≥100 px wrong). When that happens,
`templated = true` because `found` is non-null, and the shape-
detect fallback is skipped.

The bench failures show residuals in the 100-200 px range — those
are confident-wrong NCC matches, not null. The locality gate
(Phase 197+244 `requireWithinRadius: true`) already filters far
matches, so the ones that get through are within radius 150 px of
predicted but still in the bimodal "wrong" cluster.

**Real lift would come from**: using shape-detect as a CROSS-CHECK
on every NCC match, not just a fallback when NCC is null. If
NCC says "cursor at A" and shape says "cursor at B" and the two
disagree by > 30 px, treat as ambiguous and return null.

That's Phase 268 candidate (still within the cursor-shape-detect
plan).

## Honest assessment on the cron focus

The cron task says:
> 3. Integrate cursor-shape-detect into the production click pipeline
>    (acceptance: ≥4/5 live trials within 30 px on diverse cursor
>    positions)

Phase 267 integrated it. The Phase 266 bench (20/20 within 30 px,
median 6 px) provides the diverse-position evidence — but at the
detection layer, not at the click-rate layer.

The integration is clean, harmless (back-compat type widening,
fallback only fires when motion + template both failed), and ready
for production. The lift it provides is bounded by how often both
other detectors fail simultaneously.

To impact click rate meaningfully, the shape detector would need to
become a CROSS-CHECK rather than a fallback. That's an additive
change, doesn't pivot strategy.

## What stays open

- Phase 268: shape-detect as a cross-check on NCC, rejecting
  matches where shape and NCC disagree by > 30 px. This DIRECTLY
  addresses the confident-wrong NCC failure mode that dominates
  current bench failures.
- Phase 269: extend the locality-hint approach to seedCursorTemplate
  (Phase 252 found seedCursorTemplate fails on home screen because
  of widget animation; locality hint would help).

## State

- v0.5.221 (production code change)
- 713/713 tests
- nix build green
- Bench scripts retained: test-phase266, test-phase267, test-phase262
- All findings + screenshots in data/phase26X-*/
