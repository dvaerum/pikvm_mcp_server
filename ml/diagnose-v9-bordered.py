"""
Diagnose why cursor-v9-bordered.pt fails to learn position despite good labels.

Checks (in order):
  1. Label position distribution: where do the 700 labels land in screen space?
     If they cluster in <50% of the screen, the model has never seen the rest.
  2. Raw predicted heatmap shape on a sample: flat (no signal) vs peaked-but-wrong.
  3. Train vs val performance: is the model just overfitting, or doesn't even
     learn the training set?
  4. Per-source breakdown: do some collect rounds work better than others?

Writes diagnostic outputs to ml/diag-v9-bordered/.
"""
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torchvision.models import mobilenet_v3_small
from torchvision import transforms
from PIL import Image

ROOT = Path(__file__).parent.parent
OUT = ROOT / "ml" / "diag-v9-bordered"
OUT.mkdir(exist_ok=True)
PT = ROOT / "ml" / "cursor-v9-bordered.pt"

INPUT_W, INPUT_H = 768, 480
HEATMAP_W, HEATMAP_H = INPUT_W // 4, INPUT_H // 4

SOURCES = {
    "bordered-r1": ROOT / "data" / "cursor-collect-2026-05-27T19-00-08",
    "bordered-r2": ROOT / "data" / "cursor-collect-2026-05-27T19-29-10",
    "bordered-r3": ROOT / "data" / "cursor-collect-2026-05-27T19-32-25",
}


def load_labels():
    """Return list of (source, frame, abs_path, x_native, y_native, visible)."""
    rows = []
    for name, d in SOURCES.items():
        p = d / "human-verified.jsonl"
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                c = r.get("cursor")
                if not c:
                    continue
                visible = bool(c.get("visible"))
                if not visible:
                    rows.append((name, r["frame"], str(d / r["frame"]), None, None, False))
                    continue
                rows.append((name, r["frame"], str(d / r["frame"]), c["x"], c["y"], True))
    return rows


def report_label_distribution(rows):
    """Diagnostic 1: position distribution."""
    visible = [r for r in rows if r[5]]
    xs = [r[3] for r in visible]
    ys = [r[4] for r in visible]
    print(f"\n=== Label distribution ({len(visible)} visible / {len(rows)} total) ===")
    print(f"X range: {min(xs)}–{max(xs)} (frame width 1920)")
    print(f"Y range: {min(ys)}–{max(ys)} (frame height 1080)")
    # Quadrant counts
    quad = Counter()
    for x, y in zip(xs, ys):
        qx = "L" if x < 960 else "R"
        qy = "T" if y < 540 else "B"
        quad[qx + qy] += 1
    print(f"Quadrants: {dict(quad)}")
    # Bin into 4x4 grid
    bins = Counter()
    for x, y in zip(xs, ys):
        bx = min(3, int(x / 480))
        by = min(3, int(y / 270))
        bins[(bx, by)] += 1
    print(f"4x4 grid (X bin, Y bin → count):")
    for by in range(4):
        row = []
        for bx in range(4):
            row.append(f"{bins.get((bx,by), 0):4d}")
        print("  " + " ".join(row))
    # Per-source distribution
    print(f"\nPer-source:")
    by_source = defaultdict(list)
    for r in visible:
        by_source[r[0]].append((r[3], r[4]))
    for src, pts in by_source.items():
        xs_s = [p[0] for p in pts]
        ys_s = [p[1] for p in pts]
        print(f"  {src}: n={len(pts)} X=[{min(xs_s)}-{max(xs_s)}] Y=[{min(ys_s)}-{max(ys_s)}]")


class CursorFullFrameNet(nn.Module):
    def __init__(self):
        super().__init__()
        b = mobilenet_v3_small(weights=None)
        self.backbone = b.features
        self.up1 = nn.Sequential(nn.ConvTranspose2d(576, 128, 4, 2, 1), nn.ReLU(inplace=True))
        self.up2 = nn.Sequential(nn.ConvTranspose2d(128, 64, 4, 2, 1), nn.ReLU(inplace=True))
        self.up3 = nn.Sequential(nn.ConvTranspose2d(64, 32, 4, 2, 1), nn.ReLU(inplace=True))
        self.position_head = nn.Conv2d(32, 1, 1)
        self.presence_head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(576, 1))

    def forward(self, x):
        feats = self.backbone(x)
        p = self.up3(self.up2(self.up1(feats)))
        return self.position_head(p), self.presence_head(feats)


def predict_one(model, jpg_path, device):
    img = Image.open(jpg_path).convert("RGB")
    W, H = img.size
    img_r = img.resize((INPUT_W, INPUT_H), Image.BILINEAR)
    tt = transforms.ToTensor()
    nz = transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
    t = nz(tt(img_r)).unsqueeze(0).to(device)
    with torch.no_grad():
        heatmap_logits, presence_logit = model(t)
    heat = torch.sigmoid(heatmap_logits[0, 0]).cpu().numpy()  # (HEATMAP_H, HEATMAP_W)
    presence = float(torch.sigmoid(presence_logit).flatten()[0].cpu().item())
    # Decode peak
    idx = int(heat.argmax())
    py = idx // HEATMAP_W
    px = idx % HEATMAP_W
    peak_val = float(heat.flat[idx])
    return heat, presence, (px, py, peak_val, W, H)


def report_predictions(rows):
    """Diagnostic 2 & 3: run model on a sample of train and the eyeball set."""
    if torch.backends.mps.is_available():
        device = torch.device("mps")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")
    print(f"\n=== Inference diagnostics (device={device}) ===")
    model = CursorFullFrameNet().to(device)
    model.load_state_dict(torch.load(PT, map_location=device, weights_only=True))
    model.eval()

    # Sample 8 visible training frames (random-ish across rows)
    visible = [r for r in rows if r[5]]
    np.random.seed(42)
    sample_idx = np.random.choice(len(visible), size=min(8, len(visible)), replace=False)
    print(f"\nSample of {len(sample_idx)} training frames:")
    print(f"{'frame':<40} {'label':<14} {'pred (native)':<16} {'heat_peak':<10} {'heat_mean':<10}")
    for i in sample_idx:
        src, frame, path, lx, ly, _ = visible[i]
        heat, presence, (px_hm, py_hm, peak_v, W, H) = predict_one(model, path, device)
        # Convert heatmap pixel → native (using input→heatmap scale + native:input)
        px_input = px_hm * (INPUT_W / HEATMAP_W)
        py_input = py_hm * (INPUT_H / HEATMAP_H)
        px_native = px_input * (W / INPUT_W)
        py_native = py_input * (H / INPUT_H)
        dist = math.hypot(px_native - lx, py_native - ly)
        heat_mean = float(heat.mean())
        print(f"{src+'/'+frame:<40} ({lx:4d},{ly:4d}) ({px_native:6.0f},{py_native:6.0f}) {peak_v:.4f}    {heat_mean:.4f}   d={dist:.0f}px")

    # Eyeball set
    eyeball_dir = ROOT / "data" / "eyeball-bordered-cursor-2026-05-27T17-33-59"
    print(f"\nEyeball set (NOT in training):")
    print(f"{'frame':<30} {'pred (native)':<20} {'heat_peak':<10} {'heat_mean'}")
    for f in sorted(eyeball_dir.glob("*.jpg")):
        heat, presence, (px_hm, py_hm, peak_v, W, H) = predict_one(model, str(f), device)
        px_input = px_hm * (INPUT_W / HEATMAP_W)
        py_input = py_hm * (INPUT_H / HEATMAP_H)
        px_native = px_input * (W / INPUT_W)
        py_native = py_input * (H / INPUT_H)
        heat_mean = float(heat.mean())
        print(f"{f.name:<30} ({px_native:6.0f},{py_native:6.0f})    {peak_v:.4f}    {heat_mean:.4f}")


def main():
    rows = load_labels()
    print(f"Loaded {len(rows)} rows")
    report_label_distribution(rows)
    report_predictions(rows)


if __name__ == "__main__":
    main()
