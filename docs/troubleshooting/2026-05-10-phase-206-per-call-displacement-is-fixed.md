# Phase 206 (v0.5.197) — per-call displacement is FIXED, not proportional to mickeys

**Date:** 2026-05-10  
**Discovery:** This is the root cause of iPad cursor-positioning
inaccuracy.

## What the data shows

136-sample ballistics calibration with 5 reps per cell at v0.5.197.
Effective per-call displacement (= magnitude × px/mickey):

| axis:pace | mag=5 | mag=10 | mag=15 | mag=20 | mag=30 | mag=40 | mag=60 | mag=80 | mag=127 |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| x:fast | 51.5 | 51.8 | 52.0 | 52.0 | 52.2 | 75.8 | 52.2 | 52.0 | 52.2 |
| **x:slow** | **52.6** | **53.0** | **52.6** | **52.8** | **52.6** | **52.6** | **52.8** | **52.8** | **52.6** |
| y:fast | — | — | — | — | 132.3 | 137.8 | 137.6 | 137.8 | 127.6 |
| y:slow | — | — | — | 137.4 | 136.4 | 136.6 | 52.8 | 103.0 | 87.6 |

Power-law fit on x:slow gives slope = **-1.000 exactly**, intercept
3.966. This means:

```
px/mickey = e^3.966 / magnitude = 52.76 / magnitude
```

Equivalently: **a single `mouseMoveRelative` call moves the cursor
by ~52 px on x-axis, regardless of the mickey count passed to it**.

## What this means

The current algorithm assumes `mouseMoveRelative(N, 0)` moves the
cursor `N × px_per_mickey` pixels, where `px_per_mickey` is a
lookup-table value tied to magnitude. So:

- Algorithm wants to move 200 px on x-axis
- Picks magnitude=80 (because px/mickey at mag=80 is ~0.65, so
  80 × 0.65 / 0.65... wait, the lookup approach gets it right
  ONLY if you predict the right per-call displacement)

Actually re-reading: the algorithm uses `lookupPxPerMickey(40)` =
1.895 for fast, then commands `emitChunked(client, 100, 0, 40, ...)`.
With chunkMagnitude=40, mickeysPerChunk=40, total mickeys=100. That
sends `Math.ceil(100/40) = 3` calls of `mouseMoveRelative(40, 0)`.

Predicted displacement: 100 × 1.895 = 189.5 px (per the lookup).
ACTUAL displacement: 3 calls × 52 px = 156 px (per the per-call cap).

The algorithm overshoots the prediction by some amount, and
because each call gives 52 px regardless of magnitude=40 setting,
the overshoot is consistent across the chunk sequence.

**The lookup table is fundamentally wrong.** It predicts pixels-
per-mickey assuming linear scaling, but the actual mechanism is
"calls × per-call-cap".

## Why does the per-call cap exist?

Likely reasons:
1. **PiKVM HID timing:** each `mouseMoveRelative` is a discrete
   USB HID report. The kernel/driver may saturate at one displacement
   per report regardless of the displacement value (clamping to
   some maximum).
2. **iPadOS pointer-acceleration model:** Apple's curve may be
   "displacement = f(velocity)" where velocity is per-event.
   Each event triggers one acceleration evaluation.
3. **HID protocol limit:** the relative-mouse HID protocol uses
   8-bit signed integers for delta (max ±127). Maybe there's a
   per-event displacement cap somewhere in the stack.

The exact cause matters less than the empirical fact: **each call
gives ~52 px on x, ~135 px on y, regardless of mickey count.**

## REVISITED: the algorithm already implicitly handles this

After writing this up, I realized: the lookup table values were
MEASURED against the per-call mechanism. So when the algorithm picks
magnitude=80 → px/mickey=0.66 → 303 mickeys → 4 chunks of 80 →
4 calls × 52 px = 208 px, that math works out CORRECTLY. The same
target via magnitude=5 → 19 mickeys → 4 chunks of 5 → 4 calls × 52 px
= 208 px ALSO correct.

The per-call mechanism doesn't make the lookup-based algorithm wrong;
it just describes WHY the per-mickey ratios scale as 1/magnitude.
The algorithm gets the right number of calls regardless of magnitude
choice, and each call gives its capped displacement.

So the cursor-positioning bottleneck is NOT this. Real candidates:
- Acceleration variance within a call sequence (first call vs last
  call may differ — calibration medians out 5 reps but live moves
  vary)
- Cursor velocity coupling between back-to-back emits
- Detection error compounding across correction passes
- iPadOS Pointer Animations (snap/magnetic effect on top of raw
  positioning)

This Phase 206 finding is real and explains the data. It doesn't
unlock a code change by itself.

## Original (kept for context) algorithmic implication

If we WERE going to use the per-call model directly:

```ts
// Old: lookup table assuming linear scaling
const pxPerMickey = lookupPxPerMickey(magnitude, pace, axis);
const mickeys = Math.ceil(targetDistance / pxPerMickey);
emitChunked(client, mickeys, ...);  // sends ceil(mickeys / chunkSize) calls

// New: per-call displacement is the unit of motion
const PER_CALL_PX_X = 52;
const PER_CALL_PX_Y = 135;
const callsNeeded = Math.ceil(targetDistance / PER_CALL_PX);
for (let i = 0; i < callsNeeded; i++) {
  await client.mouseMoveRelative(SMALL_MAG, 0);  // mag doesn't matter!
}
```

For 200 px on x: 200 / 52 ≈ 4 calls. Predicted: 4 × 52 = 208 px.
Actual: should be ~208 ± 10 px (variance of one call).

Compare to current algorithm:
- targetDistance=200, magnitude=40, pxPerMickey≈1.9
- mickeys = ceil(200 / 1.9) = 106
- chunks = ceil(106 / 40) = 3 calls of mouseMoveRelative(40, ...) and one of mouseMoveRelative(26, ...)
- Actual displacement: 4 calls × 52 = 208 px
- HONESTLY THIS WOULD ALREADY BE CORRECT — the bug is that the
  algorithm THINKS it sent 106 mickeys = 200 px and reports
  internal state assuming that, then over-corrects in subsequent
  passes

The fix isn't to change emit; it's to change INTERNAL EXPECTATION
of what each emit accomplishes. The cursor actually moves ~52 px
per call. Accept that, predict landings accordingly, and stop
making correction passes that assume a different ratio.

## Outliers in the data

Some cells show non-cap values (e.g., x:fast:40 → 75.8). Possible
reasons:
- 5 reps may include a stretch where iPadOS was in a different
  acceleration regime
- Cursor hit screen edge mid-burst (clipped)
- Y:slow at higher magnitudes has more variance (52.8 to 137.4)

More reps would clarify. The dominant pattern (52 px on x, 135 on y)
is robust enough to act on.

## Next concrete step

Implement an algorithm change in `move-to.ts` that uses the
per-call displacement model. Test against the existing bench. If
correct-element click rate improves, ship it. If not, the model
needs more tuning per-region.

This is a SIGNIFICANT design change to the core motion algorithm —
should be careful and commit reverts if it regresses things.

## State at v0.5.197

- 136 ballistics samples in `data/ballistics.json`
- analyze-ballistics.ts in repo for re-analysis
- No production code changes from this finding yet
- Working tree clean, all pushed
