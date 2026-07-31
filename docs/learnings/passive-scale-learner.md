# Passive curve-scale learner (#41) — experimental, off by default

## What it is

The iPad emit→pixel scale the curve-mover applies (`curveScaleX/Y`, warm-started
from the shipped `DEFAULT_CURVE_SCALE_Y`) drifts as the detected HDMI region
changes. Instead of a hardcoded constant going stale, the idea was to *passively*
learn the scale from every real move's free planned-vs-achieved residual
(first-shot only, per-axis, ≥150px gate, rolling window, median estimator,
SE-gated ≤2%/update), adapting a global per-axis scale with no extra motion.

Code: `src/pikvm/scale-learner.ts` (estimator + guards), `src/pikvm/scale-persist.ts`
(sibling `data/mover-scale.json`, never merged into `ballistics.json`),
`src/index.ts` (wiring + the 3 `pikvm_mover_scale_*` tools).

## The decision: ship it OFF by default + EXPERIMENTAL (georg, 2026-07-31)

On the real iPad rig the auto-adaptation **did not beat a one-time human
measurement**, so it ships as an opt-in experiment, not a production default:

- **Default OFF.** Not opted in ⇒ the learner is inert, the 3 `pikvm_mover_scale_*`
  tools are **not registered** (they vanish from `tools/list` and dispatch), and
  the mover uses the static shipped default. A true no-op — zero behaviour change
  from before the feature existed.
- **Opt in per-process** with `PIKVM_MOVER_LEARN=1`. Then the learner runs and the
  tools appear. The `pikvm_mover_scale_control` tool freezes/resumes *within* an
  opted-in session.
- **When enabled it ships the STABLE median, clamped to ±1% of the shipped
  default** — so even opted in it cannot move the mover more than 1% off the
  hand-measured value.

## Why — the estimator problem (rig-verified)

`implied = achieved / planned`. With a constant along-travel offset `c`,
`implied = s + c/P`, so **every sample carries a `c/P` bias** and the window
median inherits it. Measured on the rig: the median first-update landed ~1.020
against an independent optimum ~1.031 (≈1% low; worse on the X axis, whose smaller
mean distance makes `c/P` bite harder).

The along-travel residual regression (the same fit the fault detector runs)
factors `c` into the **intercept**, so its **slope** is the pure multiplicative
error and is unbiased by `c` — confirmed in
`scratch/yscale-convergence-sim.ts` (0.02% bias vs the median's `c/P`).

**But the unbiased slope was WORSE on hardware — it wandered ±2-3%** (peaks 1.059),
while the biased median sat stable. Two compounding reasons:

1. The rig's real traffic (`scratch/learn-speed.ts` `long`) gives each axis only
   **two distinct `|planned|` values** (Y `{888,444}`, X `{600,300}`). A
   least-squares slope over two clusters reduces to `(mean₂−mean₁)/(x₂−x₁)` —
   cluster-mean noise divided by a short baseline, so it's amplified.
2. **The rate limit CAPS, it does not AVERAGE.** Each update chases the newest
   noisy target, so estimator variance converts *directly* into applied-value
   wander — there is no damping on the applied value itself.

The convergence sim under-priced this because it measured the *estimator's*
point-estimate variance at a fixed window, not the *applied-value trajectory* under
the rolling-window + rate-cap loop. Unbiasedness buys nothing without damping.

**Conclusion:** biased-but-stable (median) beats unbiased-but-noisy (slope) for an
opt-in, and the ±1% clamp bounds the median's residual bias so it cannot materially
hurt.

## The drift DETECTION is the reliable half

Independent of whether the *applied* value adapts well, the learner's warnings are
trustworthy and valuable, and ship coupled to the feature (also off by default):

- constant landing **offset** (regression intercept > ~10px) ⇒ detector/pacing
  fault, NOT geometry drift — re-check the detector;
- reject-rate spike among **qualified** (≥150px) moves ⇒ detector likely degraded;
- **estimate** divergence > 2% from the shipped default ⇒ re-measure + re-bake
  `DEFAULT_CURVE_SCALE_{X,Y}`. This reads the *unclamped* window-median estimate,
  not the ±1%-clamped applied value, so the ±1% clamp cannot silence it.

## If anyone revisits the experiment

The two changes that would make the *adaptation* converge (both foreclosed by the
stop rule this round):

1. an **EMA / damping on the applied value** so estimator variance averages instead
   of the rate cap only capping it;
2. a **distance-diversity gate** (analogous to the existing balanced-direction gate)
   so a window spanning only two distinct distances can't drive a slope fit at all.

## Verify

`npm run typecheck` · `npx vitest run --no-file-parallelism` ·
`nix build .#pikvm-mcp-server` + `./result/bin/pikvm-mcp-server --help` (dlopen
smoke). The estimator/guard analysis lives in `scratch/yscale-convergence-sim.ts`
and `scratch/yscale-estimator-sim.ts` (read-only, seeded).
