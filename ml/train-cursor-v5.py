"""
Train v5 full-frame cursor detector with separate presence head.

Architecture rationale: v1/v4 use a crop-around-hint architecture that
finds the most cursor-like blob inside a 256×256 window. This fails
when the cursor is absent or far from the hint — model picks
icon-internal features (page-indicator dots, gear teeth) and reports
them as the cursor with high confidence. v5 fixes this two ways:

  1. **Full-frame input.** Model sees the entire 1680×1050 screen
     (resized to 768×480, preserving aspect 1.6). No hint needed — the
     model decides where the cursor is globally.

  2. **Separate presence head.** A classification output that says
     "cursor present in this frame? yes/no", trained on the 472
     positive + 176 negative samples in our combined dataset. If
     presence says no, downstream consumers ignore any heatmap peak.

Sources (same as train-cursor-v4):
  - data/cursor-training-v0/verified.jsonl (478 entries)
  - data/cursor-training-v0-emit/verified.jsonl (170 entries)
"""
import json
import math
import random
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
from PIL import Image
import numpy as np

ROOT = Path(__file__).parent.parent
SOURCE_V0 = ROOT / "data" / "cursor-training-v0" / "verified.jsonl"
SOURCE_V0_BASE = ROOT / "data" / "cursor-training-v0"
SOURCE_EMIT = ROOT / "data" / "cursor-training-v0-emit" / "verified.jsonl"
OUT_DIR = ROOT / "ml"

# Input is 768×480 — full PiKVM frame (1680×1050) resized preserving aspect.
INPUT_W, INPUT_H = 768, 480
# Heatmap output is 1/4 scale of input.
HEATMAP_W, HEATMAP_H = INPUT_W // 4, INPUT_H // 4  # 192×120
GAUSSIAN_SIGMA = 2.0  # in heatmap space (=8 input-px = ~17 native-px)
BATCH_SIZE = 16  # smaller because full-frame is bigger
LR = 1e-3
EPOCHS = 40
VAL_FRACTION = 0.2
SEED = 1337

# Native screenshot dimensions — we assume frames are 1680×1050 (PiKVM).
NATIVE_W, NATIVE_H = 1680, 1050

if torch.cuda.is_available():
    DEVICE = torch.device("cuda")
elif torch.backends.mps.is_available():
    DEVICE = torch.device("mps")
else:
    DEVICE = torch.device("cpu")
print(f"device: {DEVICE}")


def load_sources() -> list:
    rows = []
    if SOURCE_V0.exists():
        with open(SOURCE_V0) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                abs_path = SOURCE_V0_BASE / r["frame"]
                rows.append({
                    "abs_frame_path": str(abs_path),
                    "cursor": r["cursor"],
                })
    n_v0 = len(rows)
    if SOURCE_EMIT.exists():
        with open(SOURCE_EMIT) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                rows.append({
                    "abs_frame_path": r["abs_frame_path"],
                    "cursor": r["cursor"],
                })
    print(f"loaded: {n_v0} from v0, {len(rows)-n_v0} from emit-residuals (total {len(rows)})")
    return rows


def stratified_split(rows, val_fraction, seed):
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


def build_gaussian_heatmap(h, w, cx, cy, sigma):
    y = torch.arange(h).view(-1, 1).expand(h, w).float()
    x = torch.arange(w).view(1, -1).expand(h, w).float()
    return torch.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2))


class CursorDataset(Dataset):
    def __init__(self, rows, is_train):
        self.rows = rows
        self.is_train = is_train
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

    def __getitem__(self, idx):
        row = self.rows[idx]
        img = Image.open(row["abs_frame_path"]).convert("RGB")
        W_orig, H_orig = img.size
        # Resize to input dims (preserves aspect since 1680/1050 ≈ 768/480 = 1.6).
        img = img.resize((INPUT_W, INPUT_H), Image.BILINEAR)
        if self.color_jitter is not None:
            img = self.color_jitter(img)
        img_tensor = self.normalize(self.to_tensor(img))

        visible = bool(row["cursor"]["visible"])
        if visible:
            cx_native = row["cursor"]["x"]
            cy_native = row["cursor"]["y"]
            # Scale to heatmap coordinates.
            cx_hm = cx_native * (HEATMAP_W / W_orig)
            cy_hm = cy_native * (HEATMAP_H / H_orig)
            if 0 <= cx_hm < HEATMAP_W and 0 <= cy_hm < HEATMAP_H:
                heatmap = build_gaussian_heatmap(
                    HEATMAP_H, HEATMAP_W, cx_hm, cy_hm, GAUSSIAN_SIGMA,
                )
                presence = 1.0
            else:
                heatmap = torch.zeros(HEATMAP_H, HEATMAP_W)
                presence = 0.0  # cursor outside expected area, treat as absent
        else:
            heatmap = torch.zeros(HEATMAP_H, HEATMAP_W)
            presence = 0.0

        return img_tensor, heatmap.unsqueeze(0), torch.tensor(presence)


class CursorFullFrameNet(nn.Module):
    def __init__(self):
        super().__init__()
        backbone = mobilenet_v3_small(
            weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1
        )
        self.backbone = backbone.features  # output: 1/32 scale, 576 channels

        # Position head: deconv to 1/4 of input scale.
        # Backbone out for 768×480 input is ~24×15×576. Upsample to 192×120.
        self.up1 = nn.Sequential(
            nn.ConvTranspose2d(576, 128, 4, 2, 1), nn.ReLU(inplace=True)
        )
        self.up2 = nn.Sequential(
            nn.ConvTranspose2d(128, 64, 4, 2, 1), nn.ReLU(inplace=True)
        )
        self.up3 = nn.Sequential(
            nn.ConvTranspose2d(64, 32, 4, 2, 1), nn.ReLU(inplace=True)
        )
        self.position_head = nn.Conv2d(32, 1, 1)

        # Presence head: global pool + linear.
        self.presence_head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(576, 1),
        )

    def forward(self, x):
        feats = self.backbone(x)
        # Position branch
        p = self.up1(feats)
        p = self.up2(p)
        p = self.up3(p)
        heatmap_logits = self.position_head(p)
        # Presence branch — keep as [N, 1] to avoid 0-dim collapse on batch=1.
        presence_logit = self.presence_head(feats)
        return heatmap_logits, presence_logit


def decode_heatmap_peak(heatmap_logits):
    """Return (x_input_px, y_input_px, peak_prob) for each item in batch."""
    n, _, h, w = heatmap_logits.shape
    probs = torch.sigmoid(heatmap_logits)
    flat = probs.view(n, -1)
    argmax = flat.argmax(dim=1)
    peak = flat.gather(1, argmax.unsqueeze(1)).squeeze(1)
    y = argmax // w
    x = argmax % w
    # Scale to input pixel space (heatmap was 1/4 of input).
    scale = INPUT_W / w
    return x.float() * scale, y.float() * scale, peak


def export_onnx(model, path):
    model.eval()
    cpu_model = CursorFullFrameNet()
    cpu_model.load_state_dict(model.state_dict())
    cpu_model.eval()
    dummy = torch.randn(1, 3, INPUT_H, INPUT_W)
    torch.onnx.export(
        cpu_model, dummy, str(path),
        input_names=["frame"],
        output_names=["heatmap_logits", "presence_logit"],
        dynamic_axes={
            "frame": {0: "batch"},
            "heatmap_logits": {0: "batch"},
            "presence_logit": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )


def main():
    OUT_DIR.mkdir(exist_ok=True)
    rows = load_sources()
    train_rows, val_rows = stratified_split(rows, VAL_FRACTION, SEED)

    train_ds = CursorDataset(train_rows, is_train=True)
    val_ds = CursorDataset(val_rows, is_train=False)

    train_loader = DataLoader(
        train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=2
    )
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE, num_workers=2)

    model = CursorFullFrameNet().to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=EPOCHS
    )

    best_combined = float("inf")
    for epoch in range(EPOCHS):
        model.train()
        train_loss_sum = 0.0
        n = 0
        for img, heatmap, presence in train_loader:
            img = img.to(DEVICE)
            heatmap = heatmap.to(DEVICE)
            presence = presence.to(DEVICE)
            pred_heatmap, pred_presence = model(img)

            # Position loss only counts on present samples.
            # Use pos_weight to reweight the sparse Gaussian peak.
            pos_pixels = (heatmap >= 0.1).float().sum().clamp(min=1)
            neg_pixels = (heatmap < 0.1).float().sum()
            pos_weight = neg_pixels / pos_pixels
            pos_loss_per_sample = F.binary_cross_entropy_with_logits(
                pred_heatmap, heatmap, pos_weight=pos_weight, reduction="none"
            ).mean(dim=(1, 2, 3))  # [batch]
            pos_loss = (pos_loss_per_sample * presence).sum() / presence.sum().clamp(min=1)

            pres_loss = F.binary_cross_entropy_with_logits(
                pred_presence.view(-1), presence
            )

            loss = pos_loss + pres_loss
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            train_loss_sum += loss.item() * img.size(0)
            n += img.size(0)
        scheduler.step()
        train_loss_avg = train_loss_sum / max(1, n)

        # Validation
        model.eval()
        val_pos_dists = []
        val_pos_peaks = []
        val_neg_peaks = []
        val_pos_presence = []
        val_neg_presence = []
        with torch.no_grad():
            for img, heatmap, presence in val_loader:
                img = img.to(DEVICE)
                heatmap = heatmap.to(DEVICE)
                presence_dev = presence.to(DEVICE)
                pred_heatmap, pred_presence = model(img)
                pred_presence_prob = torch.sigmoid(pred_presence.view(-1)).cpu()
                pred_x, pred_y, pred_peak = decode_heatmap_peak(pred_heatmap)
                tgt_x_hm = torch.zeros(img.size(0))
                tgt_y_hm = torch.zeros(img.size(0))
                for i in range(img.size(0)):
                    # Reconstruct target peak (heatmap-coords -> input-coords).
                    hm_i = heatmap[i, 0]
                    flat_i = hm_i.view(-1)
                    if flat_i.max() > 0.1:
                        idx = flat_i.argmax()
                        ty = (idx // HEATMAP_W).float()
                        tx = (idx % HEATMAP_W).float()
                        tgt_x_hm[i] = tx * (INPUT_W / HEATMAP_W)
                        tgt_y_hm[i] = ty * (INPUT_H / HEATMAP_H)

                for i in range(img.size(0)):
                    if presence[i].item() > 0.5:
                        dist = float(torch.sqrt(
                            (pred_x[i] - tgt_x_hm[i]) ** 2 +
                            (pred_y[i] - tgt_y_hm[i]) ** 2
                        ))
                        val_pos_dists.append(dist)
                        val_pos_peaks.append(pred_peak[i].item())
                        val_pos_presence.append(pred_presence_prob[i].item())
                    else:
                        val_neg_peaks.append(pred_peak[i].item())
                        val_neg_presence.append(pred_presence_prob[i].item())

        med_dist = float(np.median(val_pos_dists)) if val_pos_dists else float("nan")
        # Detection rate at presence > 0.5
        det_rate = (
            sum(1 for p in val_pos_presence if p > 0.5) / len(val_pos_presence)
            if val_pos_presence else 0.0
        )
        # FP rate at presence > 0.5
        fp_rate = (
            sum(1 for p in val_neg_presence if p > 0.5) / len(val_neg_presence)
            if val_neg_presence else 0.0
        )
        combined = med_dist + 100.0 * fp_rate

        print(
            f"epoch {epoch:3d} train={train_loss_avg:.4f} "
            f"med_dist={med_dist:5.1f}px(input)  "
            f"presence@0.5 det={det_rate:.2%} fp={fp_rate:.2%}  "
            f"combined={combined:.1f}"
        )

        if combined < best_combined:
            best_combined = combined
            torch.save(model.state_dict(), OUT_DIR / "cursor-v5.pt")
            try:
                export_onnx(model, OUT_DIR / "cursor-v5.onnx")
                print(f"  saved (best combined={best_combined:.1f})")
            except Exception as e:
                print(f"  saved checkpoint; ONNX export failed: {e}")


if __name__ == "__main__":
    main()
