"""
Train v11 — MobileNetV3 cursor detector trained on the FULL 1030-frame
human-labeled corpus (vs v10's 700). The new pieces vs v10:

  - 200 'presence-diverse' frames adding edge, mid-flight, and varied
    delays to the position distribution
  - 50 'absent-targeted' frames with the cursor faded by Auto-Hide
    (15 s waits). v10 had ZERO absent training examples; v11's
    presence head finally has a real negative class to learn from.
  - 20 'v10-livebench' frames (mostly absent live conditions)
  - 60 'PA26' frames (post-click visible cursor positions)

Hypothesis: v10's poor live generalization came from (a) no absent
training and (b) too-narrow positional distribution. v11 has both
fixed; expect better live presence-rejection and fewer hallucinations
near static iPad-UI features.

Output: ml/cursor-v11.pt + ml/cursor-v11.onnx
"""
import json
import random
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
DATA_ROOT = ROOT / "data"

# Every entry's "frame" field is relative to data/.
SOURCES = {
    "orange-1900":     DATA_ROOT / "cursor-collect-2026-05-27T19-00-08" / "human-verified-real.jsonl",
    "orange-1929":     DATA_ROOT / "cursor-collect-2026-05-27T19-29-10" / "human-verified-real.jsonl",
    "orange-1932":     DATA_ROOT / "cursor-collect-2026-05-27T19-32-25" / "human-verified-real.jsonl",
    "presence-diverse":DATA_ROOT / "cursor-collect-presence-2026-05-30T07-28-52" / "human-verified.jsonl",
    "absent-targeted": DATA_ROOT / "cursor-collect-absent-2026-05-30T08-03-23" / "human-verified.jsonl",
    "v10-livebench":   DATA_ROOT / "cursor-collect-v10-livebench-2026-05-30T07-00-55" / "human-verified.jsonl",
    "pa26":            DATA_ROOT / "verify-pa26" / "human-verified.jsonl",
}

INPUT_W, INPUT_H = 768, 480
HEATMAP_W, HEATMAP_H = INPUT_W // 4, INPUT_H // 4
GAUSSIAN_SIGMA = 4.0
BATCH_SIZE = 16
LR = 1e-3
EPOCHS = 40
VAL_FRACTION = 0.2
SEED = 1337

if torch.cuda.is_available():
    DEVICE = torch.device("cuda")
elif torch.backends.mps.is_available():
    DEVICE = torch.device("mps")
else:
    DEVICE = torch.device("cpu")
print(f"device: {DEVICE}")


def load_latest_per_frame(path: Path) -> dict:
    latest = {}
    if not path.exists():
        return latest
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            d = json.loads(line)
            latest[d["frame"]] = d
    return latest


def load_sources() -> list:
    rows = []
    for name, jsonl_path in SOURCES.items():
        latest = load_latest_per_frame(jsonl_path)
        kept = 0
        skipped_skip = 0
        skipped_null = 0
        for fid, entry in latest.items():
            decision = entry.get("decision")
            if decision == "skip":
                skipped_skip += 1
                continue
            cursor = entry.get("cursor")
            if cursor is None:
                skipped_null += 1
                continue
            abs_path = DATA_ROOT / fid
            rows.append({
                "source": name,
                "frame_id": fid,
                "abs_frame_path": str(abs_path),
                "cursor": cursor,
            })
            kept += 1
        print(f"{name}: kept {kept} (skip={skipped_skip}, null={skipped_null})")
    vis = sum(1 for r in rows if r["cursor"]["visible"])
    print(f"Total: {len(rows)} (visible={vis}, absent={len(rows) - vis})")
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
        img = img.resize((INPUT_W, INPUT_H), Image.BILINEAR)
        if self.color_jitter is not None:
            img = self.color_jitter(img)
        img_tensor = self.normalize(self.to_tensor(img))

        visible = bool(row["cursor"]["visible"])
        if visible:
            cx_native = row["cursor"]["x"]
            cy_native = row["cursor"]["y"]
            cx_hm = cx_native * (HEATMAP_W / W_orig)
            cy_hm = cy_native * (HEATMAP_H / H_orig)
            if 0 <= cx_hm < HEATMAP_W and 0 <= cy_hm < HEATMAP_H:
                heatmap = build_gaussian_heatmap(
                    HEATMAP_H, HEATMAP_W, cx_hm, cy_hm, GAUSSIAN_SIGMA,
                )
                presence = 1.0
            else:
                heatmap = torch.zeros(HEATMAP_H, HEATMAP_W)
                presence = 0.0
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
        self.position_head = nn.Conv2d(32, 1, 1)
        self.presence_head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(576, 1),
        )

    def forward(self, x):
        feats = self.backbone(x)
        p = self.up1(feats)
        p = self.up2(p)
        p = self.up3(p)
        heatmap_logits = self.position_head(p)
        presence_logit = self.presence_head(feats)
        return heatmap_logits, presence_logit


def decode_heatmap_peak(heatmap_logits):
    n, _, h, w = heatmap_logits.shape
    probs = torch.sigmoid(heatmap_logits)
    flat = probs.view(n, -1)
    argmax = flat.argmax(dim=1)
    peak = flat.gather(1, argmax.unsqueeze(1)).squeeze(1)
    y = argmax // w
    x = argmax % w
    scale = INPUT_W / w
    return x.float() * scale, y.float() * scale, peak


def main():
    OUT_DIR.mkdir(exist_ok=True)
    rows = load_sources()
    if not rows:
        print("no training rows; aborting")
        return
    train_rows, val_rows = stratified_split(rows, VAL_FRACTION, SEED)

    val_manifest = OUT_DIR / "cursor-v11-val-manifest.jsonl"
    with open(val_manifest, "w") as f:
        for r in val_rows:
            f.write(json.dumps({
                "source": r["source"],
                "frame_id": r["frame_id"],
                "abs_frame_path": r["abs_frame_path"],
                "cursor": r["cursor"],
            }) + "\n")
    print(f"saved val manifest: {val_manifest}")

    train_ds = CursorDataset(train_rows, is_train=True)
    val_ds = CursorDataset(val_rows, is_train=False)
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE, num_workers=2)

    model = CursorFullFrameNet().to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)

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

            pos_pixels = (heatmap >= 0.1).float().sum().clamp(min=1)
            neg_pixels = (heatmap < 0.1).float().sum()
            pos_weight = neg_pixels / pos_pixels
            pos_loss_per_sample = F.binary_cross_entropy_with_logits(
                pred_heatmap, heatmap, pos_weight=pos_weight, reduction="none"
            ).mean(dim=(1, 2, 3))
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

        model.eval()
        val_pos_dists = []
        val_pos_presence = []
        val_neg_presence = []
        with torch.no_grad():
            for img, heatmap, presence in val_loader:
                img = img.to(DEVICE)
                heatmap = heatmap.to(DEVICE)
                pred_heatmap, pred_presence = model(img)
                pred_presence_prob = torch.sigmoid(pred_presence.view(-1)).cpu()
                pred_x, pred_y, _ = decode_heatmap_peak(pred_heatmap)
                tgt_x_hm = torch.zeros(img.size(0))
                tgt_y_hm = torch.zeros(img.size(0))
                for i in range(img.size(0)):
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
                        val_pos_presence.append(pred_presence_prob[i].item())
                    else:
                        val_neg_presence.append(pred_presence_prob[i].item())

        med_dist = float(np.median(val_pos_dists)) if val_pos_dists else float("nan")
        det_rate = (
            sum(1 for p in val_pos_presence if p > 0.5) / len(val_pos_presence)
            if val_pos_presence else 0.0
        )
        fp_rate = (
            sum(1 for p in val_neg_presence if p > 0.5) / len(val_neg_presence)
            if val_neg_presence else 0.0
        )
        combined = med_dist + 100.0 * fp_rate

        print(
            f"epoch {epoch:3d} train={train_loss_avg:.4f} "
            f"med_dist={med_dist:5.1f}px(input)  "
            f"presence@0.5 det={det_rate:.2%} fp={fp_rate:.2%}  "
            f"combined={combined:.1f}",
            flush=True,
        )

        if combined < best_combined:
            best_combined = combined
            torch.save(model.state_dict(), OUT_DIR / "cursor-v11.pt")
            print(f"  saved (best combined={best_combined:.1f})", flush=True)


if __name__ == "__main__":
    main()
