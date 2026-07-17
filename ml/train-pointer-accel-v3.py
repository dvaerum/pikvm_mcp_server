"""
Train pointer-accel-v3 — retry of v2 with anti-overfit + class-imbalance
fixes. Same architecture family (MLP over 10 emit-history features), same
training data (1.3 + 1.9 trajectory dirs, 3751 examples across 5 emit
families), but with:

  1. **Feature standardization** — v2 fed raw scales (dx ∈ ±127,
     count ∈ [0,20], vx ∈ ±1) into the MLP, biasing early-layer
     gradients. v3 subtracts train-mean and divides by train-std per
     feature (mean/std saved alongside the checkpoint so inference can
     apply the same transform).
  2. **Per-family sample weighting** (inverse-frequency) — v2's val MAE
     table showed the majority family (randomWalk, 40% of data) dominated
     the loss; the minority-hard families (chunkedBurst, 15%) got
     underfit at 7-12 px. v3 weights each sample by 1/count(family) so
     the loss balances contribution.
  3. **Stratified per-family train/val split** — v2's random 80/20
     shuffle mixed families in val. v3 splits each family independently
     so per-family val N is stable and comparable.
  4. **Dropout 0.15 + AdamW weight_decay 1e-4** — v2 had neither, and
     val_mse minimized at epoch 50 then climbed steadily (classic
     overfit signature). Dropout on hidden layers + weight decay on
     linear params + cosine LR schedule to 60 epochs give the run a
     proper regularization stack.
  5. **Early stopping with patience** — 20-epoch patience on val loss;
     the best checkpoint is what gets saved (not last).

Same 3 px-per-axis per-family pass criterion as v2. Prints the per-family
MAE table at the end for direct comparison with the roadmap's v2 numbers.

CLI:
  python train-pointer-accel-v3.py <traj_dir> [<traj_dir>...]
                                  [--epochs 60]
                                  [--output ml/pointer-accel-v3.pt]
                                  [--seed 1337]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import List, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader

from pointer_accel_common import (
    DEVICE,
    FEATURE_DIM,
    OUTPUT_DIM,
    HORIZON_MS,
    PointerAccelMLP,
    TrajectoryDataset,
    build_examples_with_families,
    load_trajectory,
    per_family_report,
)

# --- Hyperparams (v3 defaults) ---------------------------------------

VAL_FRACTION = 0.2
BATCH_SIZE = 128
LR = 1e-3
WEIGHT_DECAY = 1e-4
DROPOUT = 0.15
EPOCHS_DEFAULT = 60           # v2 overfit around epoch 50; 60 with cosine + early-stop
EARLY_STOP_PATIENCE = 20
HIDDEN_DIM = 64
HIDDEN_LAYERS = 4


# --- Split + weighting -----------------------------------------------

def stratified_split(
    families: List[str], val_fraction: float, seed: int
) -> Tuple[np.ndarray, np.ndarray]:
    """Return (train_idx, val_idx). Each family contributes exactly
    round(count × val_fraction) rows to val. Deterministic per seed."""
    rng = np.random.default_rng(seed)
    by_family: dict[str, List[int]] = {}
    for i, f in enumerate(families):
        by_family.setdefault(f, []).append(i)
    train_idx: List[int] = []
    val_idx: List[int] = []
    for f in sorted(by_family):
        idxs = np.array(by_family[f])
        rng.shuffle(idxs)
        n_val = max(1, int(round(len(idxs) * val_fraction))) if len(idxs) > 1 else 0
        val_idx.extend(idxs[:n_val].tolist())
        train_idx.extend(idxs[n_val:].tolist())
    return np.array(sorted(train_idx)), np.array(sorted(val_idx))


def inverse_frequency_weights(
    families: List[str], indices: np.ndarray,
) -> np.ndarray:
    """Per-sample weight = 1/count(family_of_sample), normalized so mean = 1.
    Applied to train rows only — val is uniformly-weighted for a fair MAE."""
    fam_of = [families[i] for i in indices]
    counts: dict[str, int] = {}
    for f in fam_of:
        counts[f] = counts.get(f, 0) + 1
    w = np.array([1.0 / counts[f] for f in fam_of], dtype=np.float32)
    # normalize to mean=1 so LR scale is preserved vs v2
    w *= len(w) / w.sum()
    return w


# --- Training loop ---------------------------------------------------

def train(
    X: np.ndarray,
    Y: np.ndarray,
    families: List[str],
    epochs: int,
    output_path: Path,
    seed: int,
) -> dict:
    """Train v3 with standardization + weighted MSE + early stopping.

    Returns a summary dict with best epoch, best val_mse, per-arm MAE
    at the best checkpoint, and the feature-standardization parameters
    (so inference can apply the same transform).
    """
    train_idx, val_idx = stratified_split(families, VAL_FRACTION, seed)
    print(f"stratified split: train={len(train_idx)} val={len(val_idx)} (per-family val counts printed at end)")

    X_train, Y_train = X[train_idx], Y[train_idx]
    X_val, Y_val = X[val_idx], Y[val_idx]

    # Feature standardization — mean/std computed on TRAIN only, then
    # applied to both splits. Guard against zero std with a floor of 1e-6.
    feat_mean = X_train.mean(axis=0).astype(np.float32)
    feat_std = X_train.std(axis=0).astype(np.float32)
    feat_std = np.maximum(feat_std, 1e-6)
    X_train_std = (X_train - feat_mean) / feat_std
    X_val_std = (X_val - feat_mean) / feat_std
    print(f"feature standardization: mean per-dim range [{feat_mean.min():.2f}, {feat_mean.max():.2f}], "
          f"std per-dim range [{feat_std.min():.3f}, {feat_std.max():.3f}]")

    train_weights = inverse_frequency_weights(families, train_idx)
    # Print per-family train counts + weights for the audit trail.
    fam_counts: dict[str, int] = {}
    for i in train_idx:
        fam_counts[families[i]] = fam_counts.get(families[i], 0) + 1
    print(f"train per-family counts: {dict(sorted(fam_counts.items()))}")
    print(f"train weights (inverse-frequency, normalized mean=1): min={train_weights.min():.3f} max={train_weights.max():.3f}")

    train_ds = TrajectoryDataset(X_train_std, Y_train, train_weights)
    val_ds = TrajectoryDataset(X_val_std, Y_val)
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE)

    model = PointerAccelMLP(
        in_dim=FEATURE_DIM,
        hidden=HIDDEN_DIM,
        out_dim=OUTPUT_DIM,
        hidden_layers=HIDDEN_LAYERS,
        dropout=DROPOUT,
    ).to(DEVICE)
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    best_val = math.inf
    best_epoch = -1
    best_mae_x = math.inf
    best_mae_y = math.inf
    epochs_since_improve = 0

    for epoch in range(epochs):
        model.train()
        tr_loss = 0.0
        tr_n = 0
        for xb, yb, wb in train_loader:
            xb = xb.to(DEVICE)
            yb = yb.to(DEVICE)
            wb = wb.to(DEVICE)
            pred = model(xb)
            # Weighted MSE — the mean is over samples, so multiply by wb
            # (already normalized to mean=1 so LR stays comparable to v2).
            per_row = ((pred - yb) ** 2).mean(dim=1)  # (N,)
            loss = (per_row * wb).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            tr_loss += loss.item() * xb.size(0)
            tr_n += xb.size(0)
        scheduler.step()
        tr_loss /= max(1, tr_n)

        model.eval()
        val_loss = 0.0
        abs_err_x = 0.0
        abs_err_y = 0.0
        vn = 0
        with torch.no_grad():
            for xb, yb, _ in val_loader:
                xb = xb.to(DEVICE)
                yb = yb.to(DEVICE)
                pred = model(xb)
                val_loss += ((pred - yb) ** 2).mean(dim=1).sum().item()
                err = (pred - yb).abs()
                abs_err_x += err[:, 0].sum().item()
                abs_err_y += err[:, 1].sum().item()
                vn += xb.size(0)
        val_loss /= max(1, vn)
        mae_x = abs_err_x / max(1, vn)
        mae_y = abs_err_y / max(1, vn)

        improved = val_loss < best_val
        if improved:
            best_val = val_loss
            best_epoch = epoch
            best_mae_x = mae_x
            best_mae_y = mae_y
            epochs_since_improve = 0
            output_path.parent.mkdir(parents=True, exist_ok=True)
            torch.save({
                "state_dict": model.state_dict(),
                "feat_mean": feat_mean.tolist(),
                "feat_std": feat_std.tolist(),
                "hidden_dim": HIDDEN_DIM,
                "hidden_layers": HIDDEN_LAYERS,
                "dropout": DROPOUT,
                "epoch": epoch,
                "val_mse": val_loss,
            }, output_path)
        else:
            epochs_since_improve += 1

        if epoch % 5 == 0 or epoch == epochs - 1 or improved:
            marker = " *" if improved else "  "
            print(
                f"epoch {epoch:3d}{marker} train_mse={tr_loss:.4f} "
                f"val_mse={val_loss:.4f} val_mae_x={mae_x:.2f}px "
                f"val_mae_y={mae_y:.2f}px lr={scheduler.get_last_lr()[0]:.5f}"
            )

        if epochs_since_improve >= EARLY_STOP_PATIENCE:
            print(f"early stop: {EARLY_STOP_PATIENCE} epochs without val improvement (best epoch {best_epoch})")
            break

    return {
        "best_epoch": best_epoch,
        "best_val_mse": best_val,
        "best_mae_x": best_mae_x,
        "best_mae_y": best_mae_y,
        "feat_mean": feat_mean,
        "feat_std": feat_std,
        "val_idx": val_idx.tolist(),
    }


# --- CLI -------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("trajectory_dirs", type=Path, nargs="+")
    p.add_argument("--epochs", type=int, default=EPOCHS_DEFAULT)
    p.add_argument("--output", type=Path, default=Path("ml/pointer-accel-v3.pt"))
    p.add_argument("--seed", type=int, default=1337)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    print(f"device: {DEVICE}")

    Xs: List[np.ndarray] = []
    Ys: List[np.ndarray] = []
    all_families: List[str] = []
    total_skipped = 0
    for traj_dir in args.trajectory_dirs:
        if not traj_dir.exists():
            print(f"ERROR: trajectory directory does not exist: {traj_dir}", file=sys.stderr)
            return 2
        emits, cursor, manifest = load_trajectory(traj_dir)
        if not emits or not cursor:
            print(f"WARN: no trajectory data in {traj_dir}; skipping.", file=sys.stderr)
            continue
        print(
            f"[{traj_dir.name}] emits={len(emits)} cursor_events={len(cursor)} "
            f"manifest_keys={sorted(manifest.keys())}"
        )
        X_dir, Y_dir, fams_dir, skipped = build_examples_with_families(emits, cursor)
        Xs.append(X_dir)
        Ys.append(Y_dir)
        all_families.extend(fams_dir)
        total_skipped += skipped
        print(
            f"[{traj_dir.name}] usable examples: {X_dir.shape[0]} "
            f"(skipped {skipped} emits with no +{HORIZON_MS:.0f}ms window)"
        )

    if not Xs:
        print("ERROR: no usable trajectory data across any input dir.", file=sys.stderr)
        return 2

    X = np.concatenate(Xs, axis=0)
    Y = np.concatenate(Ys, axis=0)
    print()
    print(f"combined: examples={len(X)} skipped_total={total_skipped}")
    fam_all: dict = {}
    for f in all_families:
        fam_all[f] = fam_all.get(f, 0) + 1
    print(f"per-family counts (all): {dict(sorted(fam_all.items()))}")

    if len(X) < 10:
        print("ERROR: fewer than 10 usable examples; collect more trajectory data.", file=sys.stderr)
        return 2

    result = train(X, Y, all_families, args.epochs, args.output, args.seed)
    print()
    print(f"best checkpoint -> {args.output} (epoch {result['best_epoch']}, val_mse={result['best_val_mse']:.4f})")
    print(f"val MAE x: {result['best_mae_x']:.2f} logical px")
    print(f"val MAE y: {result['best_mae_y']:.2f} logical px")

    # Per-family MAE on the same val split we trained against.
    print()
    print("--- per-family MAE on val split (same 3px-per-axis criterion as v2) ---")
    val_idx = np.array(result["val_idx"])
    val_X = X[val_idx]
    val_Y = Y[val_idx]
    val_families = [all_families[i] for i in val_idx]

    # Rebuild the exact best checkpoint on CPU for eval.
    ckpt = torch.load(args.output, map_location="cpu", weights_only=True)
    model = PointerAccelMLP(
        in_dim=FEATURE_DIM,
        hidden=ckpt["hidden_dim"],
        out_dim=OUTPUT_DIM,
        hidden_layers=ckpt["hidden_layers"],
        dropout=ckpt["dropout"],
    )
    model.load_state_dict(ckpt["state_dict"])
    # Apply the SAME feature-standardization the checkpoint was trained with.
    feat_mean = np.array(ckpt["feat_mean"], dtype=np.float32)
    feat_std = np.array(ckpt["feat_std"], dtype=np.float32)
    val_X_std = (val_X - feat_mean) / feat_std
    per_family_report(model, val_X_std, val_Y, val_families)

    # Emit a summary JSON alongside the checkpoint for programmatic
    # comparison with v2's numbers (roadmap Stage 1.10 table).
    summary_path = args.output.with_suffix(".summary.json")
    with open(summary_path, "w") as f:
        json.dump({
            "trainer": "train-pointer-accel-v3.py",
            "trajectory_dirs": [str(d) for d in args.trajectory_dirs],
            "seed": args.seed,
            "hyperparams": {
                "epochs_max": args.epochs,
                "batch_size": BATCH_SIZE,
                "lr": LR,
                "weight_decay": WEIGHT_DECAY,
                "dropout": DROPOUT,
                "hidden_dim": HIDDEN_DIM,
                "hidden_layers": HIDDEN_LAYERS,
                "val_fraction": VAL_FRACTION,
                "early_stop_patience": EARLY_STOP_PATIENCE,
                "features": ["raw_dx", "raw_dy", "sum_dx", "sum_dy", "count",
                             "dt_prev", "vx", "vy", "last_dx", "last_dy"],
            },
            "best_epoch": result["best_epoch"],
            "best_val_mse": float(result["best_val_mse"]),
            "best_val_mae_x": float(result["best_mae_x"]),
            "best_val_mae_y": float(result["best_mae_y"]),
            "n_train": len(X) - len(val_idx),
            "n_val": len(val_idx),
        }, f, indent=2)
    print(f"\nsummary -> {summary_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
