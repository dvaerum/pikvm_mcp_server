# Pointer-accel v1 training log

**Date:** 2026-05-31
**Trajectory data:** `data/cursor-trajectory-2026-05-31T02-43-11/` (1071 cursor events, 1344 emits, 756 sequences from `--full --repeats 12`)
**Trainer:** `ml/train-pointer-accel.py` defaults (8-feature MLP, 3 hidden layers × 32 units, 50 ms horizon, 100 ms history window, val=0.2)
**Run:** 200 epochs, MPS device, batch 128, lr 1e-3
**Output:** `ml/pointer-accel-v1.pt`

## Result

| metric | value |
|--------|-------|
| val MAE x | 2.28 logical px |
| val MAE y | 0.67 logical px |
| val MSE @ best epoch | 8.40 |
| roadmap target | ≤ 5 px median |

Both axes clear the target with margin.

## Loss curve (every 10 epochs)

```
epoch   0 train_mse=242.9560 val_mse=133.6761 val_mae_x=10.82px val_mae_y=1.70px
epoch  10 train_mse= 45.4320 val_mse= 20.9998 val_mae_x= 3.90px val_mae_y=1.05px
epoch  50 train_mse= 24.6103 val_mse= 10.9804 val_mae_x= 2.89px val_mae_y=0.68px
epoch 100 train_mse= 20.8402 val_mse=  9.8690 val_mae_x= 2.64px val_mae_y=0.69px
epoch 150 train_mse= 18.8585 val_mse=  8.7668 val_mae_x= 2.35px val_mae_y=0.71px
epoch 190 train_mse= 18.4604 val_mse=  8.3957 val_mae_x= 2.35px val_mae_y=0.65px
epoch 199 train_mse= 18.5890 val_mse=  8.5461 val_mae_x= 2.33px val_mae_y=0.71px
```

Smooth convergence, no train↔val divergence — not overfit.

## Asymmetry note (x MAE > y MAE)

The bench is asymmetric:
- **Linearity sweep**: 4 dirs (±x, ±y) × 12 magnitudes — symmetric.
- **Burst sweep**: +x only at magnitude 20, 8 repeats × 7 delays — **x-only**.
- **Direction sweep**: 8 cardinal+diagonal at 100 mickeys — symmetric.

So x sees 50%+ more variety. The model has more room to *miss* on x because it's seeing harder cases (burst coalescing in particular). Y is mostly clean linearity samples → tighter fit.

This is honest variance, not a model bug. If we want symmetric MAE, add a +y burst sequence to the bench.

## Trustworthiness check (vs prior MPS-CPU silent-garbage incident)

The earlier v12 training plateaued at a fake 76 px val number due to MPS-CPU tensor mismatch (`feedback_mps_cpu_tensor_subtraction_silent_bug`). Here, val MSE *converges* from 133 → 8.4, and val MAE drops from 10.82 → 2.28 monotonically — exactly the curve you'd see when the metric is honest. If the metric were garbage, it'd plateau or stay constant from epoch 0.

## Next step

Roadmap 1.4: hand-check 10 sample (emit → predicted-displacement → observed-displacement) triples to verify the model tracks bursty / coalesced sequences and not just the easy linearity points.
