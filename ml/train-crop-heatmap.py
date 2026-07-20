"""
Crop DUAL-HEAD DETECTOR for the cascade (docs/detector-retrain-plan.md cycle 16-17).
A small fully-convolutional net on the 96px crop with TWO heads (the proposer's own
architecture, at crop resolution):
  - PRESENCE head (global avg-pool → linear): "is there a cursor anywhere in this crop?"
    Global pooling averages out local confusers → strong rejection of icons/nav-arrows/
    map (a heatmap-MAX plateaued ~0.87 on the Books icon / Maps widget, cycle 16). Trained
    with the tip jittered across the WHOLE crop → OFFSET-INVARIANT accept (the binary
    classifier's offset-sensitivity was from its narrow ±22 jitter, NOT global pooling).
  - HEATMAP head (Gaussian tip + soft-argmax): sub-pixel POSITION (the small-button /
    crop-refiner goal), offset-robust.
Detection = presence>thresh (accept/reject) → heatmap soft-argmax for position.

Data: data/synth-crops (composite-crops.py, cursor:{visible,x,y} tip target, wide jitter).
Colour cue kept (no sat/hue jitter) for the black-outlined orange arrow vs camouflage.
Gate is INDICATIVE (PIL); FINAL selection on the production-faithful TS gate.
Output: ml/crop-heatmap.pt (+ snapshots).
"""
import json
import os
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from PIL import Image
import numpy as np

ROOT = Path(__file__).parent.parent
OUT_DIR = ROOT / "ml"
DATA = ROOT / "data" / "synth-crops"
CROP = 96
HM = 24
SCALE = CROP / HM
SIGMA = 1.5
BATCH = 64
LR = 1e-3
EPOCHS = int(os.environ.get("HEATMAP_EPOCHS", "20"))
VAL_FRAC = 0.1
SEED = 1337

DEVICE = (torch.device("cuda") if torch.cuda.is_available()
          else torch.device("mps") if torch.backends.mps.is_available()
          else torch.device("cpu"))
print(f"device: {DEVICE}")

MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
_norm = transforms.Normalize(mean=MEAN, std=STD)
_to_tensor = transforms.ToTensor()

# Eval-gate frames: the committed reproducibility seed (data/seeds/eval-frames),
# relocated from scratch/ so a from-scratch reproduce depends ONLY on tracked data.
SEEDS = ROOT / "data" / "seeds" / "eval-frames"
BOOKS = SEEDS / "MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg"
MAPSICON = SEEDS / "MISS-t10-Books-frac0.01-rnull.jpg"
GATE = [
    ("REJ books-icon", SEEDS / "hc13.jpg", 760, 819, 0),
    ("REJ maps-widget", SEEDS / "hc13.jpg", 1110, 297, 0),
    ("REJ maps-app-icon", SEEDS / "hc13.jpg", 1162, 570, 0),
    ("REJ map-terrain", SEEDS / "hc17.jpg", 1218, 186, 0),
    ("ACC clean-cursor", SEEDS / "clean-cursor.jpg", 620, 432, 1),
    ("ACC books-cursor", BOOKS, 757, 846, 1),
    ("ACC mapsicon-cursor", MAPSICON, 1180, 600, 1),
]


def gaussian_hm(cx, cy):
    y = torch.arange(HM).view(-1, 1).float()
    x = torch.arange(HM).view(1, -1).float()
    return torch.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * SIGMA ** 2))


class CropDataset(Dataset):
    def __init__(self, rows, is_train):
        self.rows = rows
        self.aug = transforms.Compose([
            transforms.ColorJitter(brightness=0.15, contrast=0.15),
            transforms.RandomApply([transforms.GaussianBlur(3, sigma=(0.1, 1.2))], p=0.3),
        ]) if is_train else None

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        r = self.rows[idx]
        img = Image.open(r["abs_frame_path"]).convert("RGB")
        if img.size != (CROP, CROP):
            img = img.resize((CROP, CROP), Image.BILINEAR)
        if self.aug is not None:
            img = self.aug(img)
        t = _norm(_to_tensor(img))
        vis = bool(r["cursor"]["visible"])
        hm = gaussian_hm(r["cursor"]["x"] / SCALE, r["cursor"]["y"] / SCALE) if vis else torch.zeros(HM, HM)
        return t, hm.unsqueeze(0), torch.tensor(float(vis))


class CropDetector(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = nn.Sequential(
            nn.Conv2d(3, 16, 3, padding=1), nn.ReLU(inplace=True),
            nn.Conv2d(16, 16, 3, padding=1), nn.ReLU(inplace=True), nn.MaxPool2d(2),   # 48
            nn.Conv2d(16, 64, 3, padding=1), nn.ReLU(inplace=True),
            nn.Conv2d(64, 64, 3, padding=1), nn.ReLU(inplace=True), nn.MaxPool2d(2),   # 24
        )
        self.heatmap_head = nn.Conv2d(64, 1, 1)
        self.presence_head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(64, 1))

    def forward(self, x):
        f = self.backbone(x)
        return self.heatmap_head(f), self.presence_head(f).view(-1)


def decode(hm_logits, pres_logit):
    """presence (sigmoid) + soft-argmax tip (crop px) for a single sample."""
    presence = torch.sigmoid(pres_logit).item()
    hm = hm_logits.view(-1)
    p = torch.softmax(hm, dim=0).view(HM, HM)
    xs = (p.sum(0) * torch.arange(HM, device=p.device).float()).sum().item()
    ys = (p.sum(1) * torch.arange(HM, device=p.device).float()).sum().item()
    return presence, xs * SCALE, ys * SCALE


def gate_eval(model):
    model.eval()
    out, accs, rejs, ok = [], [], [], 0
    tf = transforms.Compose([_to_tensor, _norm])
    with torch.no_grad():
        for name, path, cx, cy, exp in GATE:
            if not path.exists():
                out.append(f"{name}:n/a"); continue
            crop = Image.open(path).convert("RGB").crop((cx - 48, cy - 48, cx + 48, cy + 48))
            hml, pl = model(tf(crop).unsqueeze(0).to(DEVICE))
            presence, _, _ = decode(hml[0], pl[0])
            good = (presence > 0.5) == bool(exp)
            ok += good
            (accs if exp else rejs).append(presence)
            out.append(f"{name}={presence:.2f}{'' if good else 'X'}")
    amin = min(accs) if accs else 0.0
    rmax = max(rejs) if rejs else 1.0
    return "  ".join(out), amin, rmax, ok


def main():
    OUT_DIR.mkdir(exist_ok=True)
    torch.manual_seed(SEED)
    rows = [json.loads(l) for l in open(DATA / "manifest.jsonl") if l.strip()]
    rng = np.random.RandomState(SEED); idx = rng.permutation(len(rows))
    n_val = int(len(rows) * VAL_FRAC)
    train_rows = [rows[i] for i in idx[n_val:]]
    print(f"train {len(train_rows)}  val {n_val}")
    train_loader = DataLoader(CropDataset(train_rows, True), batch_size=BATCH, shuffle=True, num_workers=2)

    model = CropDetector().to(DEVICE)
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)

    best = -1.0
    for epoch in range(EPOCHS):
        model.train()
        tl = 0.0; n = 0
        for img, hm, vis in train_loader:
            img, hm, vis = img.to(DEVICE), hm.to(DEVICE), vis.to(DEVICE)
            pred_hm, pred_pres = model(img)
            pos = (hm >= 0.1).float().sum().clamp(min=1)
            pw = (hm.numel() - pos) / pos
            hm_loss_ps = F.binary_cross_entropy_with_logits(pred_hm, hm, pos_weight=pw, reduction="none").mean(dim=(1, 2, 3))
            hm_loss = (hm_loss_ps * vis).sum() / vis.sum().clamp(min=1)   # position only on positives
            pres_loss = F.binary_cross_entropy_with_logits(pred_pres, vis)
            loss = hm_loss + pres_loss
            opt.zero_grad(); loss.backward(); opt.step()
            tl += loss.item() * img.size(0); n += img.size(0)
        sched.step()

        report, amin, rmax, ok = gate_eval(model)
        margin = amin - rmax
        sel = ""
        if ok == len(GATE) and margin > best:
            best = margin
            torch.save(model.state_dict(), OUT_DIR / "crop-heatmap.pt")
            sel = f" *SEL m={margin:.2f}*"
        print(f"epoch {epoch:3d} loss={tl/max(1,n):.4f}  GATE[ {report} ] margin={margin:+.2f}{sel}", flush=True)
        if epoch % 5 == 0 or epoch == EPOCHS - 1:
            torch.save(model.state_dict(), OUT_DIR / f"crop-heatmap-ep{epoch:02d}.pt")


if __name__ == "__main__":
    main()
