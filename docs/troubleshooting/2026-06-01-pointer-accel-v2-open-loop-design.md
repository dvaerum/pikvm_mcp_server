# Open-loop move-to design (1.12)

## Why this doc exists

1.12's stated goal: "demonstrate < 10 px median open-loop landing
using the iPad-app reported cursor position as ground truth." If
achieved, the screenshot detector becomes a verification layer rather
than the primary positioning input — two independent systems whose
disagreement is the SKIP signal.

This is the "think before code" piece. Write the planner design + test
methodology now, while 4.1 still has the iPad. Implement when 1.10's
v2 ONNX exists.

## What we'll have when v2 lands

A function `predictDisplacement(features) → {dx, dy}` (logical px per
~50 ms horizon). Features are the 8-dim vector from `pointer-accel.ts`:

```
[raw_dx, raw_dy,
 sum_dx_100ms, sum_dy_100ms, emit_count_100ms,
 dt_prev_emit_ms,
 cursor_vx_logical, cursor_vy_logical]
```

The model is *forward*: given an emit sequence + state, predict cursor
delta over the next horizon. 1.12 needs the inverse: given a target
delta, plan an emit sequence.

## Three candidate planners

### (a) Greedy chunk-by-chunk

```
emits = []
remaining = target_displacement
sim_cursor = (0, 0)
sim_velocity = (0, 0)
sim_t = 0

while ||remaining|| > tol and len(emits) < MAX_EMITS:
    # Pick chunk magnitude on dominant remaining axis
    sx, sy = sign(remaining.x), sign(remaining.y)
    if |remaining.x| > |remaining.y|:
        dx, dy = sx * chunkMag, 0
    else:
        dx, dy = 0, sy * chunkMag
    sim_t += chunkPaceMs

    # Build features from virtual emit history
    features = buildFeatures(emits + [{dx, dy, t: sim_t}])
    pred_disp = predictDisplacement(features)

    # Convert predicted (logical px) → HDMI px via calibration scale
    pred_hdmi = pred_disp * (HDMI_per_logical_px)

    # Update virtual state
    sim_cursor += pred_hdmi
    sim_velocity = pred_disp / horizon_ms
    remaining = target_displacement - sim_cursor
    emits.append({dx, dy, paceMs: chunkPaceMs})
```

**Pros:** simple, mirrors move-to's existing chunked-burst regime,
matches what v2 was trained on. **Cons:** one-axis-at-a-time can
zig-zag; doesn't exploit diagonal emits even when both axes are
positive.

### (b) Two-axis parallel chunks

Same as (a) but emit `dx=sx*chunkMag, dy=sy*chunkMag` simultaneously
whenever both axes have non-trivial remaining. **Pros:** straight-line
trajectory. **Cons:** v2's training data has separate-axis emits;
diagonal predictions may be OOD. Need to verify v2 covers 2-axis
emits in its dataset (the `DIRS_4` and `DIRS_8` sweeps in 1.8 do
include diagonals via `DIRS_8`, but chunkedBurst stays cardinal-only).

### (c) Inverse model

Train a separate g(target_displacement, state) → emit. **Pros:** one
forward pass per plan instead of N. **Cons:** doubles the training
work for unclear gain; greedy is fast enough at the scales we care
about (target moves of < 1000 HDMI px, ~10-30 chunks).

## Recommendation

Start with **(a)**. Reasons:

1. Matches v2's training distribution (one-axis chunks at chunkMag=20,
   chunkPaceMs=30 — exactly what `runChunkedBurst` in 1.8 captures).
2. Greedy convergence is well-defined; we can prove the inner loop
   terminates with `MAX_EMITS = 50` as a hard upper bound.
3. If greedy zig-zag becomes visually objectionable, (b) is a 5-line
   change once we have data showing whether diagonal emits work.
4. (c) gets revisited only if (a) and (b) both fail the < 10 px target.

## Test methodology

### Phase 1: planner unit test (Mac-only, no iPad)

```typescript
test('planOpenLoopEmits stops within tol given a perfect stub model', () => {
    const stubPredict = (features: number[]) => ({dx: features[0] * 0.5, dy: features[1] * 0.5});
    const emits = planOpenLoopEmits({dxPx: 100, dyPx: 0}, {chunkMag: 20, predict: stubPredict});
    const cumulativeDx = emits.reduce((s, e) => s + e.dx * 0.5, 0);
    expect(Math.abs(cumulativeDx - 100)).toBeLessThan(5);
});
```

The stub model has a known forward function (`f(dx) = 0.5 * dx`), so
the planner's iterative inversion can be tested independently of v2.

### Phase 2: replay test (Mac-only, no iPad)

Replay 1.9's chunked-burst trajectory data through the planner: for
each held-out (target_displacement, observed_emits) pair, run the
planner with v2 as the forward model and check the planner's emit
sequence cumulatively predicts within 10 px of target. **This is the
critical pass gate** — if the planner can't even predict its own
plan's outcome, the real run won't work.

### Phase 3: live iPad test (the real 1.12)

For each of 20 random target displacements (sampled to span 100-800 px
in each axis), run the planner to get emits, fire via PiKVM HID,
query iPadCollector for the actual landed position (ground truth, not
screenshot), record `landing_error = |actual_cursor - target|`.
Histogram + median. Pass criterion: **median < 10 px**.

Use iPadCollector ground truth, not screenshot. The screenshot
detector lies under known conditions (rejected-unverified-claims
memory: detector residual is not ground truth); the iPad app reports
where iPadOS actually thinks the cursor is, which is what determines
tap registration.

### Phase 4: combined system test (only if Phase 3 passes)

Add the open-loop plan to `moveToPixel` as the *initial* positioning
attempt (replacing the existing slam-then-correct), keep the
screenshot-based correction loop as a verification layer. The two
systems must agree (predicted landing within K px of detected landing)
before clicking. K is the noise budget for both systems — pick by
measuring screenshot-detector residual on the same 20 targets.

## Open questions to answer with actual data

| # | Question | When to answer |
|---|---|---|
| 1 | Does v2's MAE on chunkedBurst stay < 3 px per axis across the full mag×pace×chain matrix, or are there outlier corners? | After 1.10 trains |
| 2 | Do v2 predictions degrade as `dt_prev_emit_ms` shrinks toward 0? (v1's failure mode) | Phase 2 replay |
| 3 | Does the planner converge for diagonal targets, or does the one-axis greedy zig-zag never settle? | Phase 1 unit |
| 4 | Is the iPad-side cursor position deterministic given a fixed emit sequence, or is there ~px-level jitter we'd need to budget for? | Phase 3 live |
| 5 | What's the screenshot-detector residual at landing on the same targets the planner used? | Phase 4 |

## Risks / non-goals

- **Not optimizing wall-clock time** in this design. Open-loop plans
  may be longer than the existing chunked loop (greedy is iterative).
  If 10 chunks × 30 ms = 300 ms is too slow for some use case, address
  separately.
- **Not handling cursor-off-screen edge cases.** Planner assumes
  unbounded screen. Real iPadOS clamps at screen edges; if a chunk
  would push past the edge, the model's prediction will be wrong.
  Detect with `belief.isAtEdge()` (already exists, used by Phase 192-D)
  and fall back to the existing closed-loop path.
- **Not opting in by default.** Even if Phase 4 passes, ship behind a
  flag (`PIKVM_USE_OPEN_LOOP_BALLISTICS=1`) for one release cycle so
  the change is reversible if something breaks downstream.

## Code skeleton

```typescript
// src/pikvm/open-loop-planner.ts (new)
export interface PlannedEmit { dx: number; dy: number; paceMs: number; }
export interface PlanOpts {
    chunkMag: number;
    chunkPaceMs: number;
    horizonMs: number;
    tolPx: number;
    maxEmits: number;
    predict: (features: number[]) => Promise<{dx: number; dy: number}>;
    hdmiPerLogicalScale: { x: number; y: number };
}
export async function planOpenLoopEmits(
    target: { dxPx: number; dyPx: number },
    opts: PlanOpts,
): Promise<PlannedEmit[]>;
```

The planner is pure-async-ish (only the predict call is async); the
rest is deterministic given a stub predictor — exactly what we need
for the Phase 1 unit test.

## Related

- `docs/troubleshooting/2026-05-31-pointer-accel-1.6-fails.md` — why v1
  failed the chunked-burst regime; v2 is the targeted fix.
- `src/pikvm/pointer-accel.ts` — the forward model interface.
- `src/pikvm/move-to.ts:1439-1440` — production chunkMag=20, chunkPaceMs=30
  constants the planner mirrors.
- `bench-collect-trajectory.ts` `runChunkedBurst` (1.8) — the training
  distribution that makes (a) work.
