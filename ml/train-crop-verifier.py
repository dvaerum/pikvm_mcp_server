"""
Crop VERIFIER for the cascade (docs/detector-retrain-plan.md cycle 7). Binary
classifier on 96x96 crops: "is there a cursor ARROW here?" MobileNetV3-small
(ImageNet-pretrained) → GAP → Linear(1). Same backbone family as the single-stage
detector, but the INPUT is a high-res crop where the 31x38 arrow is ~40% of the
frame — so the classifier can key on SHAPE, which the 192x120 full-frame heatmap
could not (it FP'd on orange icons at 0.99). Data: data/synth-crops (composite-
crops.py). The current home screen is HELD OUT.

REAL-FRAME GATE (reported every epoch, NEVER trained on) — the generalization test:
  REJECT (label 0): 96px crop of hc13 centered on the Books icon (760,819) and on
    the Maps widget (1110,297) — the two things the single stage FP'd on.
  ACCEPT (label 1): 96px crop of clean-cursor (cursor @620,432) and of the Books
    frame (cursor @757,846) — real cursors on the real home screen.
A good verifier: REJECT crops << 0.5, ACCEPT crops >> 0.5.

Output: ml/crop-verifier.pt (+ periodic snapshots). Export ONNX after.
"""
import json
import os
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
from PIL import Image
import numpy as np

ROOT = Path(__file__).parent.parent
OUT_DIR = ROOT / "ml"
DATA = ROOT / "data" / "synth-crops"
SCRATCH = ROOT / "scratch"
CROP = 96
BATCH = 64
LR = 1e-3
EPOCHS = int(os.environ.get("VERIFIER_EPOCHS", "25"))
VAL_FRAC = 0.1
SEED = 1337

DEVICE = (torch.device("cuda") if torch.cuda.is_available()
          else torch.device("mps") if torch.backends.mps.is_available()
          else torch.device("cpu"))
print(f"device: {DEVICE}")

MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
_norm = transforms.Normalize(mean=MEAN, std=STD)
_to_tensor = transforms.ToTensor()

# Real-frame gate crops (frame, native center x,y, expected label).
GATE = [
    ("REJECT books-icon", SCRATCH / "hc13.jpg", 760, 819, 0),
    ("REJECT maps-widget", SCRATCH / "hc13.jpg", 1110, 297, 0),
    ("ACCEPT clean-cursor", SCRATCH / "clean-cursor.jpg", 620, 432, 1),
    ("ACCEPT books-cursor",
     SCRATCH / "instrumented-bench" / "MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg",
     757, 846, 1),
]


def crop_native(path: Path, cx: int, cy: int) -> Image.Image:
    """96px crop centered on (cx,cy) in the native 1920x1080 frame."""
    img = Image.open(path).convert("RGB")
    left, top = cx - CROP // 2, cy - CROP // 2
    return img.crop((left, top, left + CROP, top + CROP))


class CropDataset(Dataset):
    def __init__(self, rows, is_train):
        self.rows = rows
        self.jitter = transforms.ColorJitter(brightness=0.2, contrast=0.2) if is_train else None

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        r = self.rows[idx]
        img = Image.open(r["abs_frame_path"]).convert("RGB")
        if img.size != (CROP, CROP):
            img = img.resize((CROP, CROP), Image.BILINEAR)
        if self.jitter is not None:
            img = self.jitter(img)
        return _norm(_to_tensor(img)), torch.tensor(float(r["label"]))


class CropVerifier(nn.Module):
    def __init__(self):
        super().__init__()
        b = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1)
        self.backbone = b.features
        self.head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(576, 1))

    def forward(self, x):
        return self.head(self.backbone(x)).view(-1)


def gate_report(model):
    model.eval()
    out = []
    with torch.no_grad():
        for name, path, cx, cy, exp in GATE:
            if not path.exists():
                out.append(f"{name}:n/a"); continue
            t = _norm(_to_tensor(crop_native(path, cx, cy))).unsqueeze(0).to(DEVICE)
            p = torch.sigmoid(model(t)).item()
            ok = (p > 0.5) == bool(exp)
            out.append(f"{name}={p:.2f}{'ok' if ok else 'XX'}")
    return "  ".join(out)


def main():
    OUT_DIR.mkdir(exist_ok=True)
    torch.manual_seed(SEED)
    rows = [json.loads(l) for l in open(DATA / "manifest.jsonl") if l.strip()]
    # deterministic val split on index
    rng = np.random.RandomState(SEED); idx = rng.permutation(len(rows))
    n_val = int(len(rows) * VAL_FRAC)
    val_rows = [rows[i] for i in idx[:n_val]]
    train_rows = [rows[i] for i in idx[n_val:]]
    pos = sum(r["label"] for r in train_rows)
    print(f"train {len(train_rows)} ({pos} pos/{len(train_rows)-pos} neg)  val {len(val_rows)}")

    train_loader = DataLoader(CropDataset(train_rows, True), batch_size=BATCH, shuffle=True, num_workers=2)
    val_loader = DataLoader(CropDataset(val_rows, False), batch_size=BATCH, num_workers=2)

    model = CropVerifier().to(DEVICE)
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)

    for epoch in range(EPOCHS):
        model.train()
        tl = 0.0; n = 0
        for img, lbl in train_loader:
            img, lbl = img.to(DEVICE), lbl.to(DEVICE)
            loss = F.binary_cross_entropy_with_logits(model(img), lbl)
            opt.zero_grad(); loss.backward(); opt.step()
            tl += loss.item() * img.size(0); n += img.size(0)
        sched.step()

        model.eval()
        correct = 0; vn = 0
        with torch.no_grad():
            for img, lbl in val_loader:
                img = img.to(DEVICE)
                p = (torch.sigmoid(model(img)).cpu() > 0.5).float()
                correct += (p == lbl).sum().item(); vn += lbl.size(0)
        val_acc = correct / max(1, vn)
        print(f"epoch {epoch:3d} train={tl/max(1,n):.4f} val_acc={val_acc:.3f}  "
              f"GATE[ {gate_report(model)} ]", flush=True)

        torch.save(model.state_dict(), OUT_DIR / "crop-verifier.pt")
        if epoch % 5 == 0 or epoch == EPOCHS - 1:
            torch.save(model.state_dict(), OUT_DIR / f"crop-verifier-ep{epoch:02d}.pt")


if __name__ == "__main__":
    main()
