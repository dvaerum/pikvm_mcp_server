"""
Train an MLP to predict observed cursor displacement from (state,
intended emit). Input features:
  - cursor x, y (normalized to 0..1 in 1680x1050 frame)
  - emit dx, dy (raw mickeys, scaled by 1/100)
  - emit magnitude (raw, scaled by 1/200)
  - emit direction (sin/cos of angle)
Output: observed dx, dy in pixels (scaled by 1/100).

Training data: data/emit-residuals/samples.jsonl
"""
import json
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader

ROOT = Path(__file__).parent.parent
SAMPLES = ROOT / "data" / "emit-residuals-combined.jsonl"
OUT = ROOT / "ml"

DEVICE = (
    torch.device("cuda") if torch.cuda.is_available()
    else torch.device("mps") if torch.backends.mps.is_available()
    else torch.device("cpu")
)
print(f"device: {DEVICE}")

VAL_FRACTION = 0.2
SEED = 1337
BATCH = 32
LR = 1e-3
EPOCHS = 200
HIDDEN = 64


def load_samples():
    rows = []
    with open(SAMPLES) as f:
        for line in f:
            r = json.loads(line)
            if r.get("observed_dx") is None:
                continue
            if r.get("pre_pred") is None:
                continue
            # Require pre+post detection confidence > 0.6
            if r["pre_pred"]["confidence"] < 0.6:
                continue
            if r.get("post_pred") is not None and r["post_pred"]["confidence"] < 0.6:
                continue
            rows.append(r)
    return rows


def featurize(r):
    cx = r["pre_pred"]["x"] / 1680.0
    cy = r["pre_pred"]["y"] / 1050.0
    dx = r["emit"]["dx"] / 100.0
    dy = r["emit"]["dy"] / 100.0
    mag = r["magnitude"] / 200.0
    rad = r["direction_deg"] * np.pi / 180.0
    return np.array([cx, cy, dx, dy, mag, np.sin(rad), np.cos(rad)], dtype=np.float32)


def label(r):
    ox = r["observed_dx"] / 100.0
    oy = r["observed_dy"] / 100.0
    return np.array([ox, oy], dtype=np.float32)


class S(Dataset):
    def __init__(self, rows):
        self.rows = rows
    def __len__(self):
        return len(self.rows)
    def __getitem__(self, i):
        r = self.rows[i]
        return featurize(r), label(r)


class MLP(nn.Module):
    def __init__(self, in_dim=7, hidden=HIDDEN, out_dim=2):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, out_dim),
        )
    def forward(self, x):
        return self.net(x)


def main():
    rows = load_samples()
    print(f"Usable samples (conf>0.6): {len(rows)}")
    rng = random.Random(SEED)
    rng.shuffle(rows)
    val_n = int(len(rows) * VAL_FRACTION)
    val_rows = rows[:val_n]
    train_rows = rows[val_n:]
    print(f"train: {len(train_rows)} | val: {len(val_rows)}")

    train_loader = DataLoader(S(train_rows), batch_size=BATCH, shuffle=True)
    val_loader = DataLoader(S(val_rows), batch_size=BATCH)
    model = MLP().to(DEVICE)
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)

    # Baseline: predict (dx, dy) = (emit.dx * 1.3, emit.dy * 1.3) (constant ratio)
    val_baseline_loss = 0.0
    val_baseline_l2 = 0.0
    n = 0
    for r in val_rows:
        pred_x = r["emit"]["dx"] * 1.3
        pred_y = r["emit"]["dy"] * 1.3
        true_x = r["observed_dx"]
        true_y = r["observed_dy"]
        val_baseline_l2 += ((pred_x - true_x) ** 2 + (pred_y - true_y) ** 2) ** 0.5
        n += 1
    val_baseline_l2 /= max(1, n)
    print(f"Baseline (constant 1.3 ratio) val L2: {val_baseline_l2:.1f} px")

    best_val = float("inf")
    for epoch in range(EPOCHS):
        model.train()
        train_loss = 0.0
        tn = 0
        for x, y in train_loader:
            x = x.to(DEVICE)
            y = y.to(DEVICE)
            pred = model(x)
            loss = nn.functional.mse_loss(pred, y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            train_loss += loss.item() * x.size(0)
            tn += x.size(0)
        sched.step()
        train_loss /= max(1, tn)

        model.eval()
        val_loss = 0.0
        val_l2 = 0.0
        vn = 0
        with torch.no_grad():
            for x, y in val_loader:
                x = x.to(DEVICE)
                y = y.to(DEVICE)
                pred = model(x)
                val_loss += nn.functional.mse_loss(pred, y).item() * x.size(0)
                # L2 distance in actual pixels (de-scaled by ×100)
                l2 = torch.sqrt(((pred - y) * 100) ** 2).sum(dim=1).sum().item()
                val_l2 += l2
                vn += x.size(0)
        val_loss /= max(1, vn)
        val_l2 /= max(1, vn)

        if val_loss < best_val:
            best_val = val_loss
            torch.save(model.state_dict(), OUT / "emit-mlp.pt")

        if epoch % 20 == 0 or epoch == EPOCHS - 1:
            print(
                f"epoch {epoch:3d} train={train_loss:.4f} val={val_loss:.4f} "
                f"val_L2_px={val_l2:.1f}px (best so far: {best_val:.4f})"
            )

    print()
    print(f"Final val L2: {val_l2:.1f}px (baseline {val_baseline_l2:.1f}px)")
    print(f"  Lift: {(val_baseline_l2 - val_l2) / val_baseline_l2 * 100:.0f}% reduction")


if __name__ == "__main__":
    main()
