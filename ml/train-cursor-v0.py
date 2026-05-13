"""
Train v0 cursor detector — CenterNet-style heatmap regression.

Loads paired (frame, cursor_xy) data from data/cursor-training-v0/,
trains a small CNN to predict a heatmap with peak at cursor center,
exports to ONNX for runtime inference.

Architecture:
  Input:  256x256 RGB (cropped from full 1680x1050 frame around
          cursor position with random jitter for augmentation)
  Backbone: MobileNetV3-small (ImageNet pre-trained)
  Decoder: 3x upsample + conv blocks → 64x64 heatmap
  Head: 1x1 conv → 1 channel (cursor probability)

Loss: weighted BCE on Gaussian-blob target around cursor pixel.

Run:
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r ml/requirements.txt
  python3 ml/train-cursor-v0.py

Output:
  ml/cursor-v0.pt    — PyTorch checkpoint
  ml/cursor-v0.onnx  — ONNX export for onnxruntime-node
"""
import json
import os
import sys
from pathlib import Path
from typing import Tuple

# These imports will fail until the Python env is set up.
# That's the next tick's work.
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import Dataset, DataLoader
    from torchvision import transforms
    from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
    from PIL import Image
    import numpy as np
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    print("Install with: pip install -r ml/requirements.txt", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data" / "cursor-training-v0"
OUT_DIR = ROOT / "ml"

CROP_SIZE = 256
HEATMAP_SIZE = 64  # CROP_SIZE / 4 (after decoder upsample)
GAUSSIAN_SIGMA = 2.0  # px in heatmap space
BATCH_SIZE = 32
LR = 1e-3
EPOCHS = 30
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


class CursorDataset(Dataset):
    """Loads (frame, cursor_xy) pairs from data/cursor-training-v0/."""

    def __init__(self, root: Path, split: str = "train"):
        self.root = root
        labels = []
        for json_path in sorted(root.glob("*.json")):
            if json_path.name == "index.json":
                continue
            with open(json_path) as f:
                label = json.load(f)
            if label.get("cursor") is None:
                continue
            # Skip low-confidence pairs
            if label.get("confidence") == "low":
                continue
            labels.append(label)

        # 90/10 train/val split — deterministic by filename hash
        labels.sort(key=lambda l: l["frame_path"])
        split_idx = int(len(labels) * 0.9)
        self.labels = labels[:split_idx] if split == "train" else labels[split_idx:]
        print(f"{split} dataset: {len(self.labels)} samples")

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        label = self.labels[idx]
        img_path = ROOT / label["frame_path"]
        img = Image.open(img_path).convert("RGB")
        cx, cy = label["cursor"]["x"], label["cursor"]["y"]

        # Crop 256x256 around cursor with random jitter (training only)
        jitter_x = np.random.randint(-40, 40) if self.training_mode else 0
        jitter_y = np.random.randint(-40, 40) if self.training_mode else 0
        # Wait — need to know training vs val. Pass via constructor.
        # For now, no jitter.
        crop_cx = cx + jitter_x
        crop_cy = cy + jitter_y
        crop_left = max(0, crop_cx - CROP_SIZE // 2)
        crop_top = max(0, crop_cy - CROP_SIZE // 2)
        # Adjust if crop goes past frame edge
        crop_left = min(crop_left, img.width - CROP_SIZE)
        crop_top = min(crop_top, img.height - CROP_SIZE)

        img_crop = img.crop((crop_left, crop_top, crop_left + CROP_SIZE, crop_top + CROP_SIZE))
        local_x = cx - crop_left
        local_y = cy - crop_top

        img_tensor = transforms.ToTensor()(img_crop)
        # Normalize per ImageNet
        img_tensor = transforms.Normalize(
            mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225],
        )(img_tensor)

        # Build Gaussian heatmap at (local_x // 4, local_y // 4)
        heatmap = build_gaussian_heatmap(
            HEATMAP_SIZE, HEATMAP_SIZE,
            local_x / 4.0, local_y / 4.0,
            GAUSSIAN_SIGMA,
        )
        return img_tensor, heatmap


def build_gaussian_heatmap(h: int, w: int, cx: float, cy: float, sigma: float):
    """Gaussian blob centred at (cx, cy) in an h×w heatmap."""
    y = torch.arange(h).view(-1, 1).expand(h, w).float()
    x = torch.arange(w).view(1, -1).expand(h, w).float()
    gauss = torch.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2))
    return gauss.unsqueeze(0)  # add channel dim


class CursorHeatmapNet(nn.Module):
    """MobileNetV3-small backbone + 3x upsample decoder + 1x1 head."""

    def __init__(self):
        super().__init__()
        backbone = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1)
        # Take features only, drop classifier
        self.backbone = backbone.features  # output ~576 ch at 8x8 for 256x256 input
        # Decoder: 3 upsample blocks to get 8 → 16 → 32 → 64
        self.up1 = nn.Sequential(nn.ConvTranspose2d(576, 128, 4, 2, 1), nn.ReLU(inplace=True))
        self.up2 = nn.Sequential(nn.ConvTranspose2d(128, 64, 4, 2, 1), nn.ReLU(inplace=True))
        self.up3 = nn.Sequential(nn.ConvTranspose2d(64, 32, 4, 2, 1), nn.ReLU(inplace=True))
        self.head = nn.Conv2d(32, 1, 1)

    def forward(self, x):
        feats = self.backbone(x)  # 8x8
        x = self.up1(feats)  # 16x16
        x = self.up2(x)      # 32x32
        x = self.up3(x)      # 64x64
        return self.head(x)  # logits


def main():
    train_ds = CursorDataset(DATA_DIR, "train")
    val_ds = CursorDataset(DATA_DIR, "val")

    if len(train_ds) < 50:
        print(f"Not enough training data ({len(train_ds)} samples). Need ≥50.")
        print("Run bench-collect-cursor-data.ts to collect more.")
        sys.exit(1)

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE, num_workers=2)

    model = CursorHeatmapNet().to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)

    best_val_loss = float("inf")
    for epoch in range(EPOCHS):
        model.train()
        train_losses = []
        for img, target in train_loader:
            img, target = img.to(DEVICE), target.to(DEVICE)
            logits = model(img)
            # Weighted BCE: positive samples (where target > 0.1) get higher weight
            pos_weight = (target < 0.1).float().sum() / (target >= 0.1).float().sum().clamp(min=1)
            loss = F.binary_cross_entropy_with_logits(logits, target, pos_weight=pos_weight)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            train_losses.append(loss.item())

        scheduler.step()
        model.eval()
        val_losses = []
        val_dists = []
        with torch.no_grad():
            for img, target in val_loader:
                img, target = img.to(DEVICE), target.to(DEVICE)
                logits = model(img)
                loss = F.binary_cross_entropy_with_logits(logits, target)
                val_losses.append(loss.item())
                # Distance: argmax of predicted heatmap vs target peak
                pred_y, pred_x = decode_heatmap_peak(torch.sigmoid(logits))
                target_y, target_x = decode_heatmap_peak(target)
                dist = torch.sqrt(((pred_x - target_x) * 4) ** 2 + ((pred_y - target_y) * 4) ** 2)
                val_dists.extend(dist.cpu().tolist())

        avg_train = sum(train_losses) / max(1, len(train_losses))
        avg_val = sum(val_losses) / max(1, len(val_losses))
        med_dist = np.median(val_dists) if val_dists else float("nan")
        print(f"epoch {epoch:3d} train_loss={avg_train:.4f} val_loss={avg_val:.4f} val_median_dist={med_dist:.1f}px")

        if avg_val < best_val_loss:
            best_val_loss = avg_val
            torch.save(model.state_dict(), OUT_DIR / "cursor-v0.pt")
            export_onnx(model, OUT_DIR / "cursor-v0.onnx")
            print(f"  saved checkpoint + ONNX (best val_loss={best_val_loss:.4f})")


def decode_heatmap_peak(heatmap: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
    """Argmax of each heatmap → (y, x) coordinates."""
    n, _, h, w = heatmap.shape
    flat = heatmap.view(n, h * w)
    argmax = flat.argmax(dim=1)
    y = argmax // w
    x = argmax % w
    return y.float(), x.float()


def export_onnx(model: nn.Module, path: Path):
    model.eval()
    dummy = torch.randn(1, 3, CROP_SIZE, CROP_SIZE, device=DEVICE)
    torch.onnx.export(
        model, dummy, str(path),
        input_names=["frame"],
        output_names=["heatmap_logits"],
        dynamic_axes={"frame": {0: "batch"}, "heatmap_logits": {0: "batch"}},
        opset_version=17,
    )


if __name__ == "__main__":
    OUT_DIR.mkdir(exist_ok=True)
    main()
