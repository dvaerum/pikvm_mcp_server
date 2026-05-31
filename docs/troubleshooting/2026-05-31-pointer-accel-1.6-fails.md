# Step 1.6 — learned-ballistics A/B fails (verdict: don't ship)

**Bench:** `benches/bench-click-production.ts 5` (20 trials, `forbidSlamFallback: true` per script default)
**Date:** 2026-05-31
**Result:** treatment dramatically worse than baseline; learned-ballistics integration is fundamentally broken in its current form.

## Numbers

### Baseline (`PIKVM_USE_LEARNED_BALLISTICS` unset)

```
Target      | hit | skip | miss | nolaunch | n
------------+-----+------+------+----------+----
Settings    | 0/5 |  0/5 |  0/5 |      5/5 | 5
Books       | 0/5 |  0/5 |  0/5 |      5/5 | 5
AppStore    | 0/5 |  0/5 |  0/5 |      5/5 | 5
Files       | 3/5 |  0/5 |  0/5 |      2/5 | 5
------------+-----+------+------+----------+----
TOTAL       | 3/20 = 15% real launch
NOLAUNCH    | 17/20 = 85% (cursor at target, tap not registered by iPadOS)
```

iPad state was already degraded vs the morning bench (was 40%). The 85 % NO-LAUNCH says the dominant failure is the iPadOS snap-zone tap-registration issue (Stage 3 territory), not ballistics. Even a perfect ballistics fix would only address residual MISSes, not NO-LAUNCH.

### Treatment (`PIKVM_USE_LEARNED_BALLISTICS=1`)

```
Target      | hit | skip | miss | nolaunch | n
------------+-----+------+------+----------+----
Settings    | 0/5 |  5/5 |  0/5 |      0/5 | 5
Books       | 0/5 |  3/5 |  0/5 |      2/5 | 5
AppStore    | 1/5 |  3/5 |  1/5 |      0/5 | 5
Files       | 0/5 |  5/5 |  0/5 |      0/5 | 5
------------+-----+------+------+----------+----
TOTAL       | 1/20 = 5% real launch
SKIP        | 16/20 = 80% (algorithm refused to click)
NO-LAUNCH   | 2/20 = 10%
```

Residual numbers (cursor distance from target after each retry) jumped from baseline's typical 38–91 px range up to **199–767 px**. Residuals decreased across retries — characteristic halving pattern of "px/mickey ratio is off by ~2–4×".

**Treatment is strictly worse: 15 % → 5 % real launch (–10 pp). SKIP rate 0 % → 80 %**. NO-LAUNCH dropped from 85 % to 10 % only because SKIP fires before the bad click registers (the algorithm correctly notices it can't position the cursor and refuses to click — safer but less useful).

Treatment delta: –10 pp HIT. Pass criterion was treatment ≥ baseline + 15 pp. **Fails by 25 pp.**

## Root cause — the model is being asked the wrong question

The integration in `src/pikvm/move-to.ts` (`learnedBallisticsPxPerMickey`) builds a cold-start feature vector — empty emit history, zero recent cursor velocity, `dt_prev_emit_ms = 0` — and asks the model for a one-shot displacement prediction. It then divides by `chunkMag` to get a per-mickey ratio used to plan the whole move.

Two independent problems with that:

### (1) Cold-start is out-of-distribution

The trainer (`ml/train-pointer-accel.py`) builds examples from the trajectory bench's continuous emit stream. Even the `linearity:*` sequences have 800 ms settle between emits, so the trained `dt_prev_emit_ms` feature is always **~800**, not 0. Querying with 0 gives nonsense:

```
+x 20, dt=0    → pred=[+59.38, -1.20]  (3× too large on x, basically random)
+y 20, dt=0    → pred=[ +0.57, -0.27]  (~zero — drops the y signal entirely)
-x 20, dt=0    → pred=[ -0.86, -0.28]  (~zero — drops the x signal)
-y 20, dt=0    → pred=[+18.46, -0.99]  (predicts +x for a -y emit!)

with dt=800 instead:
+x 20, dt=800  → pred=[ +5.66, -0.35]  (in-distribution — small + sensible)
+y 20, dt=800  → pred=[ +0.01, +2.27]  (in-distribution — small + sensible)
```

The model behaves erratically across input axes when given dt=0 because the network never saw that region of feature-space during training.

### (2) Even with `dt=800` the model predicts the wrong physical quantity

The trainer predicts cursor displacement over the **next 50 ms** following a **single** emit (with `HORIZON_MS=50`). That's the iPad's response to *one* mickey burst followed by settle. For 20 mickeys followed by an 800 ms gap, the model predicts ~5.66 logical px → 0.28 logical px/mickey → 0.24 HDMI px/mickey.

`moveToPixel` wants a different thing: the **steady-state** px/mickey during a *chunked burst* of emits (20 mickeys at 30 ms pace, repeated). In that regime the iPad's effective rate is ~1.0 HDMI px/mickey (the existing `fallback` constant, tuned from live observation). So the model under-predicts by ~4×, the loop emits 4× too many mickeys, and the iPad overshoots wildly.

The decreasing-residual pattern (717 → 388 → 199 — halving each pass) is exactly what happens when the planner under-predicts px/mickey: each correction pass overshoots by the remaining error, ends up roughly the same distance from target on the other side, retries with the same wrong ratio, halves again. Eventually `maxResidualPx=35` kicks in and it SKIPs.

## What this means for the model

`pointer-accel-v1` itself is not "wrong" — within its trained input distribution it predicts well (eval: per-family MAE all ≤ 5 px). But it's a **next-50ms-displacement** model, not a **steady-state px/mickey** oracle. Using it as the latter requires either:

- **a) Re-train on the chunked-burst regime.** The trajectory bench currently has linearity-with-settle and burst-coalescing-without-settle. The actual production move-to behavior (20 mickey chunks at 30 ms pace, repeated continuously) is a *third* regime that the dataset doesn't directly cover. Need a new sequence type that matches.
- **b) Use the model inside the chunk loop.** Query mid-burst with proper accumulated history to predict where the next chunk will land, use that to early-exit the loop. Doesn't need re-training; does need a more invasive `move-to.ts` change.
- **c) Drop the steady-state-ratio approach entirely.** The model isn't built for that, the existing constant `fallback: 1.0` is well-tuned, and even a perfect ballistics fix wouldn't dent the 85 % NO-LAUNCH baseline (the dominant failure is tap-registration, not positioning).

## Recommendation

**Defer learned-ballistics integration.** The `PIKVM_USE_LEARNED_BALLISTICS=1` flag stays off by default (no production impact). Mark roadmap step 1.6 `[!]` blocked, step 1.7 `[!]` blocked on 1.6.

**Pivot Stage 1 budget to Stage 3** (iPadOS tap-registration investigation). 85 % NO-LAUNCH on a *good* day means positioning fixes can move the needle at most 15 pp; tap-registration fixes can move it 50+ pp.

If Stage 3 closes and learned-ballistics still looks like a useful lever, come back with approach (b) — query mid-burst, use it to gate the chunked-emit loop, no re-training needed.
