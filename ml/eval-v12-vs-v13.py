"""
Head-to-head: cursor-v12 vs cursor-v13 on the same held-out 34
on-icon frames. The v13 trainer's per-epoch on-icon-eval median may
not distinguish the two models if both bottom out at quantization
(suspected during the v13 run — synth-val and on-icon-eval reported
identical medians of 4.0 / 5.7 px at epochs 0/1).

This script runs BOTH models on EXACTLY the SAME 34 frames
(ml/cursor-v13-on-icon-eval-manifest.jsonl), with no augmentation, no
dropout, no randomness. Output: per-frame side-by-side distances + a
failure-mode bucketing that directly tests the 1.13b hallucination
claim — "cursor on icon, model says cursor far away."

Failure buckets (using HALLUCINATION_THRESHOLD_PX = 35, matching the
production residual-skip gate):
  - both_correct     : v12_dist < 35 AND v13_dist < 35
  - v13_fixed_hallu  : v12_dist >= 35 AND v13_dist < 35  (v13 win)
  - v13_regressed    : v12_dist < 35 AND v13_dist >= 35  (v13 loss)
  - both_hallucinate : v12_dist >= 35 AND v13_dist >= 35
"""
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torchvision import transforms
from torchvision.models import mobilenet_v3_small
from PIL import Image

ROOT = Path(__file__).parent.parent
ML_DIR = ROOT / "ml"
MANIFEST = ML_DIR / "cursor-v13-on-icon-eval-manifest.jsonl"
V12_CKPT = ML_DIR / "cursor-v12.pt"
V13_CKPT = ML_DIR / "cursor-v13.pt"

INPUT_W, INPUT_H = 768, 480
HEATMAP_W, HEATMAP_H = INPUT_W // 4, INPUT_H // 4
HALLUCINATION_THRESHOLD_PX = 35  # production residual-skip gate
# Match findCursorByV8FullFrame's default (src/pikvm/cursor-ml-detect.ts).
# Frames a model would ABSTAIN on in production (presence<threshold)
# must be classified as "abstain" here, not fed into the distance
# bucketer — otherwise v13 correctly declining is scored as a hallu-
# cination/regression on the heatmap-argmax coord it wouldn't emit.
PRESENCE_THRESHOLD = 0.5

if torch.cuda.is_available():
    DEVICE = torch.device("cuda")
elif torch.backends.mps.is_available():
    DEVICE = torch.device("mps")
else:
    DEVICE = torch.device("cpu")
print(f"device: {DEVICE}")


class CursorFullFrameNet(nn.Module):
    """Identical to train-cursor-v12.py / train-cursor-v13.py — both
    checkpoints serialize this exact architecture. weights=None
    because every param is overwritten by load_state_dict below;
    downloading ImageNet weights just to discard them wastes ~20 MB
    of network/disk per invocation."""
    def __init__(self):
        super().__init__()
        backbone = mobilenet_v3_small(weights=None)
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


def load_model(ckpt_path: Path) -> nn.Module:
    if not ckpt_path.exists():
        raise FileNotFoundError(f"missing checkpoint: {ckpt_path}")
    model = CursorFullFrameNet().to(DEVICE)
    state = torch.load(ckpt_path, map_location=DEVICE)
    model.load_state_dict(state)
    model.eval()
    return model


def preprocess(img_path: str) -> tuple[torch.Tensor, int, int]:
    img = Image.open(img_path).convert("RGB")
    W_orig, H_orig = img.size
    img = img.resize((INPUT_W, INPUT_H), Image.BILINEAR)
    to_tensor = transforms.ToTensor()
    normalize = transforms.Normalize(
        mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225],
    )
    t = normalize(to_tensor(img)).unsqueeze(0).to(DEVICE)
    return t, W_orig, H_orig


def predict_native_xy(
    model: nn.Module, img_t: torch.Tensor, W_orig: int, H_orig: int
) -> tuple[float, float, float]:
    """Returns (x_native, y_native, presence_prob). x/y are in the
    original frame's pixel space — same coordinate system as the
    label's `cursor.x` / `cursor.y`."""
    with torch.no_grad():
        heatmap_logits, presence_logit = model(img_t)
    probs = torch.sigmoid(heatmap_logits)
    n, _, h, w = probs.shape
    flat = probs.view(n, -1)
    argmax = flat.argmax(dim=1)
    y_hm = (argmax // w).item()
    x_hm = (argmax % w).item()
    # scale heatmap → input → original
    x_input = x_hm * (INPUT_W / w)
    y_input = y_hm * (INPUT_H / h)
    x_native = x_input * (W_orig / INPUT_W)
    y_native = y_input * (H_orig / INPUT_H)
    presence = torch.sigmoid(presence_logit).item()
    return x_native, y_native, presence


def load_manifest(path: Path) -> list[dict]:
    rows = []
    with open(path) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def summarize(dists: list[float], label: str):
    if not dists:
        print(f"{label}: no rows")
        return
    a = np.array(dists)
    print(
        f"{label}: n={len(a)}  med={np.median(a):.1f}  mean={a.mean():.1f}  "
        f"p25={np.percentile(a, 25):.1f}  p75={np.percentile(a, 75):.1f}  "
        f"p95={np.percentile(a, 95):.1f}  max={a.max():.1f}  "
        f"<10px={(a < 10).sum()}  <35px={(a < HALLUCINATION_THRESHOLD_PX).sum()}"
    )


def main():
    if not MANIFEST.exists():
        raise FileNotFoundError(
            f"Missing {MANIFEST}. Run train-cursor-v13.py first — "
            "the manifest is written at the start of training."
        )
    rows = load_manifest(MANIFEST)
    print(f"manifest: {MANIFEST} ({len(rows)} rows)")

    print(f"loading {V12_CKPT}")
    v12 = load_model(V12_CKPT)
    print(f"loading {V13_CKPT}")
    v13 = load_model(V13_CKPT)

    out = []
    v12_dists, v13_dists = [], []  # only frames both models emit (production would too)
    buckets = {
        "both_correct": [],       # v12 < 35 AND v13 < 35 (both emit)
        "v13_fixed_hallu": [],    # v12 >= 35 AND v13 < 35 (both emit)
        "v13_regressed": [],      # v12 < 35 AND v13 >= 35 (both emit)
        "both_hallucinate": [],   # v12 >= 35 AND v13 >= 35 (both emit)
        # Abstain cases — production would return null; not a bug.
        "v12_abstain": [],        # v12_pres < threshold; v13 emitted
        "v13_abstain": [],        # v13_pres < threshold; v12 emitted
        "both_abstain": [],       # both < threshold
    }

    # (v12_emits, v13_emits) → bucket for the both-emit-and-far case
    # is picked separately below; this table only covers the routes
    # where at least one model would abstain in production.
    ABSTAIN_ROUTE = {
        (False, False): "both_abstain",
        (False, True):  "v12_abstain",
        (True,  False): "v13_abstain",
    }

    for r in rows:
        gt = r["cursor"]
        if not gt.get("visible"):
            continue  # on-icon manifest is all-positive; defensive
        gt_x, gt_y = gt["x"], gt["y"]
        img_t, W, H = preprocess(r["abs_frame_path"])
        v12_x, v12_y, v12_pres = predict_native_xy(v12, img_t, W, H)
        v13_x, v13_y, v13_pres = predict_native_xy(v13, img_t, W, H)
        # Compute distances once; per-frame row always reports them
        # regardless of routing.
        v12_d = float(np.hypot(v12_x - gt_x, v12_y - gt_y))
        v13_d = float(np.hypot(v13_x - gt_x, v13_y - gt_y))
        v12_emits = v12_pres >= PRESENCE_THRESHOLD
        v13_emits = v13_pres >= PRESENCE_THRESHOLD

        if not (v12_emits and v13_emits):
            row_bucket = ABSTAIN_ROUTE[(v12_emits, v13_emits)]
        else:
            v12_dists.append(v12_d)
            v13_dists.append(v13_d)
            v12_hallu = v12_d >= HALLUCINATION_THRESHOLD_PX
            v13_hallu = v13_d >= HALLUCINATION_THRESHOLD_PX
            row_bucket = (
                "both_correct"    if not v12_hallu and not v13_hallu else
                "v13_fixed_hallu" if v12_hallu     and not v13_hallu else
                "v13_regressed"   if not v12_hallu and v13_hallu     else
                "both_hallucinate"
            )
        buckets[row_bucket].append(r["frame_id"])
        out.append({
            "frame_id": r["frame_id"],
            "gt": [gt_x, gt_y],
            "v12_xy": [round(v12_x, 1), round(v12_y, 1)],
            "v13_xy": [round(v13_x, 1), round(v13_y, 1)],
            "v12_dist": round(v12_d, 1),
            "v13_dist": round(v13_d, 1),
            "v12_pres": round(v12_pres, 3),
            "v13_pres": round(v13_pres, 3),
            "v12_emits": v12_emits,
            "v13_emits": v13_emits,
            "bucket": row_bucket,
        })

    print()
    print("=" * 70)
    summarize(v12_dists, "v12 (both-emit only)")
    summarize(v13_dists, "v13 (both-emit only)")
    print()
    if v12_dists and v13_dists:
        paired_diff = np.array(v13_dists) - np.array(v12_dists)
        print(
            f"paired (v13 - v12): med={np.median(paired_diff):+.1f} "
            f"mean={paired_diff.mean():+.1f}  "
            f"v13_better={(paired_diff < 0).sum()}  "
            f"tied={(paired_diff == 0).sum()}  "
            f"v13_worse={(paired_diff > 0).sum()}"
        )
    else:
        print("paired: no both-emit frames — every frame had at least one model abstaining")
    print()
    print(f"failure buckets (presence>={PRESENCE_THRESHOLD}, hallucination>={HALLUCINATION_THRESHOLD_PX}px):")
    for k, frames in buckets.items():
        print(f"  {k:20s}: {len(frames):3d}")

    # Save per-frame detail
    out_path = ML_DIR / "eval-v12-vs-v13.jsonl"
    with open(out_path, "w") as f:
        for row in out:
            f.write(json.dumps(row) + "\n")
    print(f"\nper-frame detail: {out_path}")

    # Verdict signal
    n_both_emit = len(v12_dists)
    total_frames = len(out)
    n_abstain = (
        len(buckets["v12_abstain"])
        + len(buckets["v13_abstain"])
        + len(buckets["both_abstain"])
    )
    if n_both_emit == 0:
        print(f"\nVERDICT: 0 both-emit frames of {total_frames} (all abstain-routed) — no signal")
        return
    v13_p50 = float(np.median(v13_dists))
    v12_p50 = float(np.median(v12_dists))
    delta = v13_p50 - v12_p50
    fixed = len(buckets["v13_fixed_hallu"])
    regressed = len(buckets["v13_regressed"])
    print(
        f"\nVERDICT — v13 vs v12 on {n_both_emit}/{total_frames} both-emit frames "
        f"({n_abstain} abstain-routed):\n"
        f"  v13 p50 = {v13_p50:.1f}px  (v12 p50 = {v12_p50:.1f}px, "
        f"delta = {delta:+.1f}px)\n"
        f"  v13 fixed {fixed} hallucinations; regressed on {regressed}\n"
        f"  net hallucination delta: {fixed - regressed:+d}\n"
        f"  Small-N caveat: treat single-frame swings as noise."
    )


if __name__ == "__main__":
    main()
