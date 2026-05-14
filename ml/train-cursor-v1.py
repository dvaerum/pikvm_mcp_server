"""
Train v1 cursor detector on visually-verified ground truth.

Loads labels from data/cursor-training-v0/verified.jsonl (478 entries
created 2026-05-13 by visual inspection of every frame). Critical
differences vs train-cursor-v0.py:

  - 321 visible:true entries → Gaussian-heatmap target as before.
  - 157 visible:false entries → all-zero heatmap target. Crop is
    centered on algorithm_label (the FP region the model must learn
    to reject). v0 had ZERO negative examples; v1's whole point is
    fixing that.
  - Stratified 80/20 train/val split keeps positive/negative ratio
    in both splits.
  - Validation reports three metrics per epoch:
      * median Euclidean dist on positives (px)
      * FP rate on negatives at sigmoid > 0.5
      * detection rate on positives at sigmoid > 0.5
  - Best-checkpoint metric = median_dist + 100 * fp_rate.
    FP rate is heavily penalised because the Phase 310 tautology
    failure mode is "model hallucinates cursor when none present."

Output:
  ml/cursor-v1.pt    — PyTorch checkpoint
  ml/cursor-v1.onnx  — ONNX export
"""
import json
import random
import sys
from pathlib import Path
from typing import Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
from PIL import Image
import numpy as np

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data" / "cursor-training-v0"
VERIFIED = DATA_DIR / "verified.jsonl"
OUT_DIR = ROOT / "ml"

CROP_SIZE = 256
HEATMAP_SIZE = 64
GAUSSIAN_SIGMA = 2.0
BATCH_SIZE = 32
LR = 1e-3
EPOCHS = 30
VAL_FRACTION = 0.2
SEED = 1337

if torch.cuda.is_available():
    DEVICE = torch.device("cuda")
elif torch.backends.mps.is_available():
    DEVICE = torch.device("mps")
else:
    DEVICE = torch.device("cpu")
print(f"device: {DEVICE}")


def load_verified() -> list:
    rows = []
    with open(VERIFIED) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def stratified_split(rows: list, val_fraction: float, seed: int):
    rng = random.Random(seed)
    pos = [r for r in rows if r["cursor"]["visible"]]
    neg = [r for r in rows if not r["cursor"]["visible"]]
    rng.shuffle(pos)
    rng.shuffle(neg)
    val_pos = int(len(pos) * val_fraction)
    val_neg = int(len(neg) * val_fraction)
    val = pos[:val_pos] + neg[:val_neg]
    train = pos[val_pos:] + neg[val_neg:]
    rng.shuffle(val)
    rng.shuffle(train)
    print(
        f"train: {len(train)} ({len(pos) - val_pos} pos / "
        f"{len(neg) - val_neg} neg) | "
        f"val: {len(val)} ({val_pos} pos / {val_neg} neg)"
    )
    return train, val


class CursorDataset(Dataset):
    def __init__(self, rows: list, is_train: bool):
        self.rows = rows
        self.is_train = is_train
        # Augmentation only on train. ColorJitter applied to PIL
        # before ToTensor.
        self.color_jitter = (
            transforms.ColorJitter(brightness=0.2, contrast=0.2)
            if is_train else None
        )
        self.to_tensor = transforms.ToTensor()
        self.normalize = transforms.Normalize(
            mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225],
        )

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx: int):
        row = self.rows[idx]
        frame_name = row["frame"]
        img_path = DATA_DIR / frame_name
        img = Image.open(img_path).convert("RGB")
        W, H = img.size

        visible = row["cursor"]["visible"]
        if visible:
            cx, cy = row["cursor"]["x"], row["cursor"]["y"]
        else:
            # Crop around the algorithm's hallucinated position. This
            # is exactly where the model would naively look at
            # inference — make it explicitly learn to say "no cursor"
            # here.
            cx, cy = row["algorithm_label"]["x"], row["algorithm_label"]["y"]

        if self.is_train:
            jitter_x = int(np.random.randint(-40, 40))
            jitter_y = int(np.random.randint(-40, 40))
        else:
            jitter_x = 0
            jitter_y = 0
        crop_cx = cx + jitter_x
        crop_cy = cy + jitter_y
        crop_left = max(0, crop_cx - CROP_SIZE // 2)
        crop_top = max(0, crop_cy - CROP_SIZE // 2)
        crop_left = min(crop_left, W - CROP_SIZE)
        crop_top = min(crop_top, H - CROP_SIZE)

        img_crop = img.crop(
            (crop_left, crop_top, crop_left + CROP_SIZE, crop_top + CROP_SIZE)
        )
        if self.color_jitter is not None:
            img_crop = self.color_jitter(img_crop)

        img_tensor = self.normalize(self.to_tensor(img_crop))

        if visible:
            local_x = cx - crop_left
            local_y = cy - crop_top
            # If position jitter pushed cursor off the crop, mark as
            # negative (no peak in heatmap). Reasonable: if cursor
            # isn't in the crop, model should not predict one.
            if 0 <= local_x < CROP_SIZE and 0 <= local_y < CROP_SIZE:
                heatmap = build_gaussian_heatmap(
                    HEATMAP_SIZE, HEATMAP_SIZE,
                    local_x / 4.0, local_y / 4.0, GAUSSIAN_SIGMA,
                )
                has_target = 1.0
            else:
                heatmap = torch.zeros(1, HEATMAP_SIZE, HEATMAP_SIZE)
                has_target = 0.0
        else:
            heatmap = torch.zeros(1, HEATMAP_SIZE, HEATMAP_SIZE)
            has_target = 0.0

        return img_tensor, heatmap, torch.tensor(has_target)


def build_gaussian_heatmap(h, w, cx, cy, sigma):
    y = torch.arange(h).view(-1, 1).expand(h, w).float()
    x = torch.arange(w).view(1, -1).expand(h, w).float()
    gauss = torch.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2))
    return gauss.unsqueeze(0)


class CursorHeatmapNet(nn.Module):
    def __init__(self):
        super().__init__()
        backbone = mobilenet_v3_small(
            weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1
        )
        self.backbone = backbone.features
        self.up1 = nn.Sequential(
            nn.ConvTranspose2d(576, 128, 4, 2, 1), nn.ReLU(inplace=True)
        )
        self.up2 = nn.Sequential(
            nn.ConvTranspose2d(128, 64, 4, 2, 1), nn.ReLU(inplace=True)
        )
        self.up3 = nn.Sequential(
            nn.ConvTranspose2d(64, 32, 4, 2, 1), nn.ReLU(inplace=True)
        )
        self.head = nn.Conv2d(32, 1, 1)

    def forward(self, x):
        feats = self.backbone(x)
        x = self.up1(feats)
        x = self.up2(x)
        x = self.up3(x)
        return self.head(x)


def decode_heatmap_peak(heatmap: torch.Tensor):
    n, _, h, w = heatmap.shape
    flat = heatmap.view(n, h * w)
    argmax = flat.argmax(dim=1)
    peak_val = flat.gather(1, argmax.unsqueeze(1)).squeeze(1)
    y = argmax // w
    x = argmax % w
    return y.float(), x.float(), peak_val


def export_onnx(model: nn.Module, path: Path):
    model.eval()
    # ONNX exporter requires CPU tensors for some MPS ops; export
    # from a CPU copy to avoid backend-specific quirks.
    cpu_model = CursorHeatmapNet()
    cpu_model.load_state_dict(model.state_dict())
    cpu_model.eval()
    dummy = torch.randn(1, 3, CROP_SIZE, CROP_SIZE)
    torch.onnx.export(
        cpu_model, dummy, str(path),
        input_names=["frame"],
        output_names=["heatmap_logits"],
        dynamic_axes={"frame": {0: "batch"}, "heatmap_logits": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )


def main():
    OUT_DIR.mkdir(exist_ok=True)
    rows = load_verified()
    print(f"Loaded {len(rows)} verified labels.")
    train_rows, val_rows = stratified_split(rows, VAL_FRACTION, SEED)

    train_ds = CursorDataset(train_rows, is_train=True)
    val_ds = CursorDataset(val_rows, is_train=False)

    train_loader = DataLoader(
        train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=2
    )
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE, num_workers=2)

    model = CursorHeatmapNet().to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=EPOCHS
    )

    best_combined = float("inf")
    for epoch in range(EPOCHS):
        model.train()
        train_losses = []
        for img, target, has_target in train_loader:
            img = img.to(DEVICE)
            target = target.to(DEVICE)
            logits = model(img)
            # Per-sample pos_weight handling: clamp denominator to
            # avoid divide-by-zero when batch has only all-zero
            # targets (cursor-absent crops).
            pos_pixels = (target >= 0.1).float().sum().clamp(min=1)
            neg_pixels = (target < 0.1).float().sum()
            pos_weight = neg_pixels / pos_pixels
            loss = F.binary_cross_entropy_with_logits(
                logits, target, pos_weight=pos_weight
            )
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            train_losses.append(loss.item())

        scheduler.step()
        model.eval()
        val_losses = []
        pos_dists = []
        pos_peak_confs = []
        neg_peak_confs = []
        with torch.no_grad():
            for img, target, has_target in val_loader:
                img = img.to(DEVICE)
                target = target.to(DEVICE)
                logits = model(img)
                loss = F.binary_cross_entropy_with_logits(logits, target)
                val_losses.append(loss.item())
                probs = torch.sigmoid(logits)
                pred_y, pred_x, peak_val = decode_heatmap_peak(probs)
                # has_target=1 means cursor in crop, 0 means absent.
                for i in range(img.size(0)):
                    if has_target[i].item() > 0.5:
                        tgt_y, tgt_x, _ = decode_heatmap_peak(
                            target[i:i + 1]
                        )
                        dist = float(
                            torch.sqrt(
                                ((pred_x[i] - tgt_x[0]) * 4) ** 2 +
                                ((pred_y[i] - tgt_y[0]) * 4) ** 2
                            )
                        )
                        pos_dists.append(dist)
                        pos_peak_confs.append(peak_val[i].item())
                    else:
                        neg_peak_confs.append(peak_val[i].item())

        avg_train = sum(train_losses) / max(1, len(train_losses))
        avg_val = sum(val_losses) / max(1, len(val_losses))
        med_dist = float(np.median(pos_dists)) if pos_dists else float("nan")
        fp_rate_05 = (
            sum(1 for c in neg_peak_confs if c > 0.5) / len(neg_peak_confs)
            if neg_peak_confs else 0.0
        )
        det_rate_05 = (
            sum(1 for c in pos_peak_confs if c > 0.5) / len(pos_peak_confs)
            if pos_peak_confs else 0.0
        )
        combined = med_dist + 100.0 * fp_rate_05
        print(
            f"epoch {epoch:3d} train={avg_train:.4f} val={avg_val:.4f} "
            f"med_dist={med_dist:6.1f}px det@0.5={det_rate_05:.2%} "
            f"fp@0.5={fp_rate_05:.2%} combined={combined:.1f}"
        )

        if combined < best_combined:
            best_combined = combined
            torch.save(model.state_dict(), OUT_DIR / "cursor-v1.pt")
            try:
                export_onnx(model, OUT_DIR / "cursor-v1.onnx")
                print(
                    f"  saved checkpoint + ONNX "
                    f"(best combined={best_combined:.1f})"
                )
            except Exception as e:
                print(
                    f"  saved checkpoint only — ONNX export failed: {e}"
                )


if __name__ == "__main__":
    main()
