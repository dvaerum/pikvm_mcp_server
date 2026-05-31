# Pointer-accel v1 honest eval (Step 1.4)

- Trajectory: `data/cursor-trajectory-2026-05-31T02-43-11`
- Checkpoint: `ml/pointer-accel-v1.pt`
- Device: `mps`
- Total usable examples: 1342
- Val examples (recovered via SEED=1337, VAL_FRACTION=0.2): 268
- Per-family MAE threshold: 5.0 px (both axes)

## Overall val MAE

| metric | value |
| --- | --- |
| mae_x | 2.28 px |
| mae_y | 0.67 px |
| euclid_mae | 2.65 px |
| euclid_p95 | 7.79 px |

## Per-sequence-family breakdown

| family | n | mae_x | mae_y | p95_x | p95_y | max_x | max_y | euclid_mae | pass (<= 5px)? |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| burst | 129 | 3.71 | 0.51 | 10.64 | 0.82 | 19.69 | 1.45 | 3.92 | YES |
| direction | 20 | 1.44 | 2.20 | 2.80 | 4.62 | 2.81 | 4.79 | 2.87 | YES |
| linearity | 119 | 0.87 | 0.59 | 3.78 | 2.53 | 4.26 | 3.55 | 1.24 | YES |

## Verdict

PASS — every sequence family has MAE ≤ 5.0 px on both axes. Proceed to Step 1.5 (wire pointer-accel into `move-to.ts` behind `PIKVM_USE_LEARNED_BALLISTICS=1`).

### Caveats worth carrying into Step 1.5

- `burst` p95_x and max_x are noticeably wider than the per-axis MAE (see the table above). The biggest single residual sits on a `burst:+x:m20:n8:d0` row where the observed cursor moved ~26 px and the model predicted ~46 px (≈20 px over). This is the iPadOS emit-coalescing regime: when emits arrive faster than the iPad can process them, dropped emits collapse the *observed* displacement while the model still sees all the inputs. The model is right on average but a long tail remains.
- For the Step 1.5 wiring this means the learned forward model is trustworthy for **planning** an open-loop emit (mean residual is the planner's expected error) but a per-emit correction loop should still verify, not slam, when `d0` bursts are in play.

## Sample val rows (first 10)

| emit_dx | emit_dy | pred_dx | pred_dy | obs_dx | obs_dy | err_x | err_y | label |
| --: | --: | --: | --: | --: | --: | --: | --: | --- |
| 20 | 0 | 19.87 | -0.33 | 22.14 | 0.00 | 2.26 | 0.33 | `burst:+x:m20:n8:d25` |
| 0 | -50 | -0.95 | -4.03 | 0.00 | -7.13 | 0.95 | 3.11 | `linearity:-y:m50` |
| 20 | 0 | 0.56 | -0.35 | 0.00 | -1.17 | 0.56 | 0.81 | `burst:+x:m20:n8:d200` |
| 20 | 0 | 6.97 | 0.29 | 0.00 | -1.16 | 6.97 | 1.45 | `burst:+x:m20:n8:d200` |
| 20 | 0 | -0.07 | -0.35 | 0.00 | -1.16 | 0.07 | 0.82 | `burst:+x:m20:n8:d100` |
| 71 | 71 | 2.79 | 6.71 | 0.00 | 7.37 | 2.79 | 0.66 | `direction:SE:m100` |
| -2 | 0 | 0.16 | -0.02 | -0.04 | 0.00 | 0.20 | 0.02 | `linearity:-x:m2` |
| 0 | -20 | 0.02 | -1.77 | 0.00 | -1.29 | 0.02 | 0.48 | `linearity:-y:m20` |
| -1 | 0 | 0.30 | -0.04 | -0.04 | 0.00 | 0.34 | 0.04 | `linearity:-x:m1` |
| 20 | 0 | 45.65 | -0.59 | 25.95 | 0.00 | 19.69 | 0.59 | `burst:+x:m20:n8:d0` |
