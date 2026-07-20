"""
Train v14 — robust cursor detector. v14 = v13's EXACT recipe + the diverse-
background synthetic corpus (data/synth-v14, ml/composite-cursor.py) that pastes
the KNOWN cursor sprite onto maximally diverse backgrounds (real cursor-free app
screenshots incl. Maps/Clock/TV textures + procedural gradient/noise/blobs/maps).

WHY (verified, see docs/detector-retrain-plan.md): v13 keys on "orange/colorful
blob" not the arrow SHAPE, so it FALSE-POSITIVES on the home-screen Maps widget
(0.999) and MISSES the real cursor on the orange Books icon (0.0012). Root cause:
v13's backgrounds were too clean/narrow. Fix = train the invariant sprite against
a huge background diversity, with the hard textures present as cursor-FREE
negatives too. ROBUSTNESS BY DESIGN, not per-screen memorization (user directive,
memory feedback_detector_must_generalize_any_screen).

The ONLY change vs v13 is adding the synth-v14 source. Same model, same LR/epochs/
metric, same ImageNet-pretrained start — so any change is attributable to the data.

GENERALIZATION PROOF (the whole point): the current home screen's Maps widget is
HELD OUT of training entirely (synth-v14 uses the Maps *app* interior, never the
home widget layout). Each epoch we REPORT — but never SELECT on — two hold-outs:
  - home-FP: 4 verified no-cursor current-home frames (hc13/15/17/18). A robust v14
    must NOT fire on the Maps widget it never trained on.
  - books-det: the exact frame v13 missed (real cursor on Books icon @757,846).
Selection stays on synth-val combined (same as v13) so the hold-out stays clean; if
the best-synth-val model still FPs on home, the fix is MORE/harder negative data,
NOT cherry-picking an epoch (memory feedback_decisions_best_practice_long_term).

Output: ml/cursor-v14.pt + ml/cursor-v14-val-manifest.jsonl. Export ONNX after.
"""
import hashlib
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
DATA_ROOT = ROOT / "data"
SCRATCH = ROOT / "scratch"

ON_ICON_JSONL = DATA_ROOT / "cursor-collect-on-icon-2026-06-03T19-45-07" / "verified.jsonl"
ON_ICON_EVAL_FRACTION = 0.20
SYNTH_V14_JSONL = DATA_ROOT / "synth-v14" / "manifest.jsonl"

# v13's SOURCES verbatim (the real human-verified + synthetic corpora that give
# the ~11px recognition) PLUS the new robustness corpus, synth-v14.
SOURCES = {
    "orange-1900":     DATA_ROOT / "cursor-collect-2026-05-27T19-00-08" / "human-verified-real.jsonl",
    "orange-1929":     DATA_ROOT / "cursor-collect-2026-05-27T19-29-10" / "human-verified-real.jsonl",
    "orange-1932":     DATA_ROOT / "cursor-collect-2026-05-27T19-32-25" / "human-verified-real.jsonl",
    "presence-diverse":DATA_ROOT / "cursor-collect-presence-2026-05-30T07-28-52" / "human-verified.jsonl",
    "absent-targeted": DATA_ROOT / "cursor-collect-absent-2026-05-30T08-03-23" / "human-verified.jsonl",
    "v10-livebench":   DATA_ROOT / "cursor-collect-v10-livebench-2026-05-30T07-00-55" / "human-verified.jsonl",
    "pa26":            DATA_ROOT / "verify-pa26" / "human-verified.jsonl",
    "synthetic-train": DATA_ROOT / "cursor-collect-synthetic-2026-05-30T16-46-52" / "verified.jsonl",
    "synth-v14":       SYNTH_V14_JSONL,  # <-- the ONLY change vs v13
}

EXTERNAL_VAL_SOURCES = {
    "synthetic-val": DATA_ROOT / "cursor-collect-synthetic-2026-05-30T17-46-59" / "verified.jsonl",
}

# HELD-OUT generalization frames (never in training). Labels are known by hand.
HOME_FP_FRAMES = [SCRATCH / f"hc{n}.jpg" for n in (13, 15, 17, 18)]  # no-cursor home
BOOKS_POS = {"path": SCRATCH / "instrumented-bench" /
             "MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg",
             "x": 757, "y": 846}  # real cursor on Books icon; v13 scored 0.0012 here

INPUT_W, INPUT_H = 768, 480
HEATMAP_W, HEATMAP_H = INPUT_W // 4, INPUT_H // 4
GAUSSIAN_SIGMA = 4.0
BATCH_SIZE = 16
LR = 1e-3
EPOCHS = int(os.environ.get("V14_EPOCHS", "40"))
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
            # v13 corpora key on "frame"; synth-v14 keys on "frame_id".
            key = d.get("frame", d.get("frame_id"))
            latest[key] = d
    return latest


def load_sources(sources: dict) -> list:
    rows = []
    for name, jsonl_path in sources.items():
        latest = load_latest_per_frame(jsonl_path)
        kept = 0
        skipped_skip = 0
        for fid, entry in latest.items():
            if entry.get("decision") == "skip":
                skipped_skip += 1
                continue
            cursor = entry.get("cursor") or {"visible": False}
            # synth-v14 carries an absolute path already; v13 corpora are relative.
            abs_path = Path(entry["abs_frame_path"]) if entry.get("abs_frame_path") else DATA_ROOT / fid
            if not abs_path.exists():
                abs_path = jsonl_path.parent / fid
            if not abs_path.exists():
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
    """Deterministic sha1 split keyed on frame_id — SAME salt as v13 so the
    on-icon held-out set is identical, keeping v13↔v14 comparison honest."""
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

        if bool(row["cursor"]["visible"]):
            cx_hm = row["cursor"]["x"] * (HEATMAP_W / W_orig)
            cy_hm = row["cursor"]["y"] * (HEATMAP_H / H_orig)
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
        return self.position_head(p), self.presence_head(feats)


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
    pos_dists_all, pos_pres_all, neg_pres_all = [], [], []
    model.eval()
    with torch.no_grad():
        for img, heatmap, presence in loader:
            img = img.to(DEVICE, non_blocking=True)
            heatmap = heatmap.to(DEVICE, non_blocking=True)
            presence = presence.to(DEVICE, non_blocking=True)
            pred_heatmap, pred_presence = model(img)
            pred_presence_prob = torch.sigmoid(pred_presence.view(-1))
            pred_x, pred_y, _ = decode_heatmap_peak(pred_heatmap)

            hm_flat = heatmap.view(heatmap.size(0), -1)
            _, hm_argmax = hm_flat.max(dim=1)
            ty = (hm_argmax // HEATMAP_W).float() * (INPUT_H / HEATMAP_H)
            tx = (hm_argmax % HEATMAP_W).float() * (INPUT_W / HEATMAP_W)

            dist = torch.sqrt((pred_x - tx) ** 2 + (pred_y - ty) ** 2)
            pos_mask = (presence > 0.5).cpu()
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


def _infer_one(model, path):
    """Full-frame inference matching the ONNX/production path exactly: bilinear
    resize to 768x480, ImageNet-normalize, argmax the heatmap → (x,y) in native
    px + peak + presence-prob. Returns (nx, ny, peak, presence)."""
    tf = transforms.Compose([
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])
    img = Image.open(path).convert("RGB")
    W0, H0 = img.size
    t = tf(img.resize((INPUT_W, INPUT_H), Image.BILINEAR)).unsqueeze(0).to(DEVICE)
    model.eval()
    with torch.no_grad():
        hm, pres = model(t)
        px, py, peak = decode_heatmap_peak(hm)
    nx = float(px[0]) / INPUT_W * W0
    ny = float(py[0]) / INPUT_H * H0
    return nx, ny, float(peak[0]), float(torch.sigmoid(pres.view(-1))[0])


def eval_holdout(model):
    """Report the two generalization hold-outs. NOT used for model selection."""
    home_hits = 0
    for p in HOME_FP_FRAMES:
        if not p.exists():
            continue
        _, _, _, pres = _infer_one(model, p)
        if pres > 0.5:
            home_hits += 1
    n_home = sum(1 for p in HOME_FP_FRAMES if p.exists())
    books = None
    if BOOKS_POS["path"].exists():
        nx, ny, peak, pres = _infer_one(model, BOOKS_POS["path"])
        dist = ((nx - BOOKS_POS["x"]) ** 2 + (ny - BOOKS_POS["y"]) ** 2) ** 0.5
        books = (dist, peak, pres)
    return home_hits, n_home, books


def main():
    OUT_DIR.mkdir(exist_ok=True)
    torch.manual_seed(SEED)

    print("--- non-on-icon training sources (incl. synth-v14) ---")
    train_rows = load_sources(SOURCES)
    if not train_rows:
        print("no training rows; aborting")
        return

    print("--- on-icon corpus (split into train + held-out eval, v13 salt) ---")
    on_icon_rows = load_sources({"on-icon-2026-06-03": ON_ICON_JSONL})
    if not on_icon_rows:
        print("on-icon source missing; aborting")
        return
    on_icon_train, on_icon_eval = stable_eval_split(on_icon_rows, ON_ICON_EVAL_FRACTION)
    print(f"on-icon: train {len(on_icon_train)} / eval {len(on_icon_eval)}")
    train_rows.extend(on_icon_train)

    print("--- external val (existing synth-val, same as v12/v13) ---")
    val_rows = load_sources(EXTERNAL_VAL_SOURCES)
    if not val_rows:
        print("no external val rows; aborting")
        return

    pos_t = sum(1 for r in train_rows if r["cursor"]["visible"])
    print(f"train: {len(train_rows)} ({pos_t} pos / {len(train_rows) - pos_t} neg)")

    val_manifest = OUT_DIR / "cursor-v14-val-manifest.jsonl"
    with open(val_manifest, "w") as f:
        for r in val_rows:
            f.write(json.dumps({
                "source": r["source"], "frame_id": r["frame_id"],
                "abs_frame_path": r["abs_frame_path"], "cursor": r["cursor"],
            }) + "\n")
    print(f"saved manifest: {val_manifest}")

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
        train_loss_sum, n = 0.0, 0
        for img, heatmap, presence in train_loader:
            img = img.to(DEVICE)
            heatmap = heatmap.to(DEVICE)
            presence = presence.to(DEVICE)
            pred_heatmap, pred_presence = model(img)

            pos_pixels = (heatmap >= 0.1).float().sum().clamp(min=1)
            neg_pixels = heatmap.numel() - pos_pixels
            pos_weight = neg_pixels / pos_pixels
            pos_loss_per_sample = F.binary_cross_entropy_with_logits(
                pred_heatmap, heatmap, pos_weight=pos_weight, reduction="none"
            ).mean(dim=(1, 2, 3))
            pos_loss = (pos_loss_per_sample * presence).sum() / presence.sum().clamp(min=1)
            pres_loss = F.binary_cross_entropy_with_logits(pred_presence.view(-1), presence)
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
        home_hits, n_home, books = eval_holdout(model)

        combined = v_med + 100.0 * v_fp  # selection metric — synth-val only (clean)
        books_str = (f"dist={books[0]:5.0f}px peak={books[1]:.3f} pres={books[2]:.2f}"
                     if books else "n/a")
        star = " *SEL*" if combined < best_combined else ""
        print(
            f"epoch {epoch:3d} train={train_loss_avg:.4f}  "
            f"synth-val: med={v_med:5.1f}px det={v_det:.2%} fp={v_fp:.2%}  "
            f"on-icon: med={oi_med:5.1f}px det={oi_det:.2%}  "
            f"[HOLDOUT home-FP={home_hits}/{n_home} books:{books_str}]  "
            f"combined={combined:.1f}{star}",
            flush=True,
        )

        # synth-val is SATURATED for v14 (the heatmap aces the clean synth-val set
        # from epoch 0: 4px/99.9%/0%fp), so strict-< selection FROZE the checkpoint
        # at an undertrained epoch 0 (verified: books presence 0.20). The metric that
        # matters — presence/peak SEPARATION between real cursors and real no-cursor
        # screens — is not in synth-val. So save the LATEST model every epoch (fully
        # trained by the end) + periodic snapshots, and make the REAL selection
        # downstream via the ONNX hold-out gate + LIVE N=80, which cannot be gamed.
        if combined < best_combined:
            best_combined = combined
        torch.save(model.state_dict(), OUT_DIR / "cursor-v14.pt")
        if epoch % 5 == 0 or epoch == EPOCHS - 1:
            torch.save(model.state_dict(), OUT_DIR / f"cursor-v14-ep{epoch:02d}.pt")


if __name__ == "__main__":
    main()
