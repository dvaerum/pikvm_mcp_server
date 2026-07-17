"""
Train v13 — MobileNetV3 cursor detector. v13 = v12 SOURCES + the new
on-icon corpus from bench-collect-on-icon (2026-06-03, 134 frames of
cursor on Settings / Books / AppStore / Files at ±25 px offsets).

This addresses the 1.13b/4.1' audit finding: v12 hallucinates cursor
position on cursor-on-orange-icon frames (Books in particular).
Hypothesis: adding 134 targeted on-icon frames to the existing 1030
human-verified + 10k synthetic corpus measurably reduces hallucination
on cursor-on-icon eval. 134 is small (memory: project_bench_noise_floor
says <10pp lifts are invisible at N=20), but a cursor-on-icon-specific
held-out eval gives a direct measurement of THE failure mode this
corpus was collected to address — distinct from the global synth-val
metric v12 already maximizes for.

Held-out plan: deterministically split the 134 on-icon frames into
~107 train + 27 eval (split key = `frame` field hash, seed=1337). The
27 eval frames are reported as a third metric every epoch alongside
the main synth-val numbers. Direct comparison with v12 baseline is
valid via the existing synth-val (5000 frames) — both v12 and v13
share that eval set unchanged.

Output: ml/cursor-v13.pt + ml/cursor-v13.onnx + the two eval manifests.
"""
import hashlib
import json
import os
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

ON_ICON_JSONL = DATA_ROOT / "cursor-collect-on-icon-2026-06-03T19-45-07" / "verified.jsonl"
ON_ICON_EVAL_FRACTION = 0.20  # ~27 of 134

# Mirrors v12's SOURCES exactly, plus the on-icon corpus (training subset
# only — eval subset is held out below).
SOURCES = {
    "orange-1900":     DATA_ROOT / "cursor-collect-2026-05-27T19-00-08" / "human-verified-real.jsonl",
    "orange-1929":     DATA_ROOT / "cursor-collect-2026-05-27T19-29-10" / "human-verified-real.jsonl",
    "orange-1932":     DATA_ROOT / "cursor-collect-2026-05-27T19-32-25" / "human-verified-real.jsonl",
    "presence-diverse":DATA_ROOT / "cursor-collect-presence-2026-05-30T07-28-52" / "human-verified.jsonl",
    "absent-targeted": DATA_ROOT / "cursor-collect-absent-2026-05-30T08-03-23" / "human-verified.jsonl",
    "v10-livebench":   DATA_ROOT / "cursor-collect-v10-livebench-2026-05-30T07-00-55" / "human-verified.jsonl",
    "pa26":            DATA_ROOT / "verify-pa26" / "human-verified.jsonl",
    "synthetic-train": DATA_ROOT / "cursor-collect-synthetic-2026-05-30T16-46-52" / "verified.jsonl",
    # on-icon-train is loaded separately so we can split deterministically.
}

EXTERNAL_VAL_SOURCES = {
    "synthetic-val": DATA_ROOT / "cursor-collect-synthetic-2026-05-30T17-46-59" / "verified.jsonl",
}

INPUT_W, INPUT_H = 768, 480
HEATMAP_W, HEATMAP_H = INPUT_W // 4, INPUT_H // 4
GAUSSIAN_SIGMA = 4.0
BATCH_SIZE = 16
LR = 1e-3
EPOCHS = int(os.environ.get("V13_EPOCHS", "40"))
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


def load_sources(sources: dict) -> list:
    rows = []
    for name, jsonl_path in sources.items():
        latest = load_latest_per_frame(jsonl_path)
        kept = 0
        skipped_skip = 0
        for fid, entry in latest.items():
            decision = entry.get("decision")
            if decision == "skip":
                skipped_skip += 1
                continue
            cursor = entry.get("cursor")
            if cursor is None:
                cursor = {"visible": False}
            abs_path = DATA_ROOT / fid
            if not abs_path.exists():
                abs_path = jsonl_path.parent / fid
            if not abs_path.exists():
                # Frame referenced by the jsonl but missing on disk —
                # pa26's 55/60 frames went missing between when v12
                # trained and now; we just drop those rows.
                continue
            rows.append({
                "source": name,
                "frame_id": fid,
                "abs_frame_path": str(abs_path),
                "cursor": cursor,
            })
            kept += 1
        print(f"{name}: kept {kept} (skip={skipped_skip})")
    vis = sum(1 for r in rows if r["cursor"]["visible"])
    print(f"Total: {len(rows)} (visible={vis}, absent={len(rows) - vis})")
    return rows


def stable_eval_split(rows, eval_fraction, salt="on-icon-v13"):
    """Deterministic eval split keyed on the frame_id. Same row → same
    side of the split regardless of dict iteration order, file mtimes,
    or random seed reshuffles. Lets us re-run v13 (or train v14 later
    with more frames added) and still compare against the original
    held-out set."""
    train, evl = [], []
    for r in rows:
        h = hashlib.sha1(f"{salt}|{r['frame_id']}".encode()).hexdigest()
        bucket = int(h[:8], 16) / 0xFFFFFFFF
        (evl if bucket < eval_fraction else train).append(r)
    return train, evl


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


def eval_split(model, loader):
    """Returns (median_dist_input_px, det_rate, fp_rate, n_pos, n_neg).

    Vectorized across each batch — no per-sample Python loop or
    intermediate .item() sync. Prior version forced a GPU→CPU sync
    per sample × 5000 synth-val frames × 40 epochs = 200 k syncs.
    """
    pos_dists_all: list[float] = []
    pos_pres_all: list[float] = []
    neg_pres_all: list[float] = []
    model.eval()
    with torch.no_grad():
        for img, heatmap, presence in loader:
            img = img.to(DEVICE, non_blocking=True)
            heatmap = heatmap.to(DEVICE, non_blocking=True)
            presence = presence.to(DEVICE, non_blocking=True)
            pred_heatmap, pred_presence = model(img)
            pred_presence_prob = torch.sigmoid(pred_presence.view(-1))
            pred_x, pred_y, _ = decode_heatmap_peak(pred_heatmap)

            # Target heatmap argmax → (tx, ty) in input-px, batched.
            # heatmap shape is [B, 1, H, W]; flatten spatial dims.
            hm_flat = heatmap.view(heatmap.size(0), -1)
            hm_max, hm_argmax = hm_flat.max(dim=1)
            ty = (hm_argmax // HEATMAP_W).float() * (INPUT_H / HEATMAP_H)
            tx = (hm_argmax % HEATMAP_W).float() * (INPUT_W / HEATMAP_W)
            # Peak <=0.1 → the target-heatmap was masked to zero (absent
            # frame); still compute (tx,ty) but the presence gate below
            # routes that sample into the neg bucket regardless.

            dist = torch.sqrt((pred_x - tx) ** 2 + (pred_y - ty) ** 2)
            is_pos = presence > 0.5
            # Single .cpu() sync per batch instead of one per sample.
            pos_mask = is_pos.cpu()
            dist_cpu = dist.cpu()
            pres_cpu = pred_presence_prob.cpu()
            for i in range(pos_mask.size(0)):
                if pos_mask[i]:
                    pos_dists_all.append(float(dist_cpu[i]))
                    pos_pres_all.append(float(pres_cpu[i]))
                else:
                    neg_pres_all.append(float(pres_cpu[i]))
    med = float(np.median(pos_dists_all)) if pos_dists_all else float("nan")
    det = (sum(1 for p in pos_pres_all if p > 0.5) / len(pos_pres_all)) if pos_pres_all else 0.0
    fp = (sum(1 for p in neg_pres_all if p > 0.5) / len(neg_pres_all)) if neg_pres_all else 0.0
    return med, det, fp, len(pos_pres_all), len(neg_pres_all)


def main():
    OUT_DIR.mkdir(exist_ok=True)
    print("--- non-on-icon training sources ---")
    train_rows = load_sources(SOURCES)
    if not train_rows:
        print("no non-on-icon training rows; aborting")
        return

    print("--- on-icon corpus (split into train + held-out eval) ---")
    on_icon_rows = load_sources({"on-icon-2026-06-03": ON_ICON_JSONL})
    if not on_icon_rows:
        print("on-icon source missing or empty — re-check ON_ICON_JSONL path")
        return
    on_icon_train, on_icon_eval = stable_eval_split(
        on_icon_rows, ON_ICON_EVAL_FRACTION
    )
    print(
        f"on-icon: train {len(on_icon_train)} / eval {len(on_icon_eval)} "
        f"(deterministic sha1 split, fraction={ON_ICON_EVAL_FRACTION})"
    )
    train_rows.extend(on_icon_train)

    print("--- external val (existing synth-val, same as v12) ---")
    val_rows = load_sources(EXTERNAL_VAL_SOURCES)
    if not val_rows:
        print("no external val rows; aborting")
        return

    pos_t = sum(1 for r in train_rows if r["cursor"]["visible"])
    pos_v = sum(1 for r in val_rows if r["cursor"]["visible"])
    pos_e = sum(1 for r in on_icon_eval if r["cursor"]["visible"])
    print(
        f"train: {len(train_rows)} ({pos_t} pos / {len(train_rows) - pos_t} neg) | "
        f"synth-val: {len(val_rows)} ({pos_v} pos / {len(val_rows) - pos_v} neg) | "
        f"on-icon-eval: {len(on_icon_eval)} ({pos_e} pos / {len(on_icon_eval) - pos_e} neg) "
    )

    val_manifest = OUT_DIR / "cursor-v13-val-manifest.jsonl"
    with open(val_manifest, "w") as f:
        for r in val_rows:
            f.write(json.dumps({
                "source": r["source"], "frame_id": r["frame_id"],
                "abs_frame_path": r["abs_frame_path"], "cursor": r["cursor"],
            }) + "\n")
    on_icon_manifest = OUT_DIR / "cursor-v13-on-icon-eval-manifest.jsonl"
    with open(on_icon_manifest, "w") as f:
        for r in on_icon_eval:
            f.write(json.dumps({
                "source": r["source"], "frame_id": r["frame_id"],
                "abs_frame_path": r["abs_frame_path"], "cursor": r["cursor"],
            }) + "\n")
    print(f"saved manifests: {val_manifest}, {on_icon_manifest}")

    train_ds = CursorDataset(train_rows, is_train=True)
    val_ds = CursorDataset(val_rows, is_train=False)
    on_icon_ds = CursorDataset(on_icon_eval, is_train=False)
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE, num_workers=2)
    on_icon_loader = DataLoader(on_icon_ds, batch_size=BATCH_SIZE, num_workers=2)

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
            # neg = total − pos avoids a second full reduction over the
            # heatmap tensor per batch (same result mathematically).
            neg_pixels = heatmap.numel() - pos_pixels
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

        v_med, v_det, v_fp, v_p, v_n = eval_split(model, val_loader)
        oi_med, oi_det, oi_fp, oi_p, oi_n = eval_split(model, on_icon_loader)

        combined = v_med + 100.0 * v_fp

        print(
            f"epoch {epoch:3d} train={train_loss_avg:.4f}  "
            f"synth-val: med={v_med:5.1f}px det={v_det:.2%} fp={v_fp:.2%} "
            f"({v_p}+/{v_n}-)  "
            f"on-icon-eval: med={oi_med:5.1f}px det={oi_det:.2%} "
            f"({oi_p}+/{oi_n}-)  "
            f"combined={combined:.1f}",
            flush=True,
        )

        if combined < best_combined:
            best_combined = combined
            torch.save(model.state_dict(), OUT_DIR / "cursor-v13.pt")
            print(f"  saved (best combined={best_combined:.1f})", flush=True)


if __name__ == "__main__":
    main()
