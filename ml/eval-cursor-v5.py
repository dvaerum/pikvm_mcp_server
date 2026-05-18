"""Evaluate cursor-v5 full-frame detector vs v1/v4 on emit-residual frames.

The interesting comparison: v5 has a separate presence head. Does it
correctly reject the frames where v1/v4 tautologically false-positive?
"""
import json
import math
import random
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).parent.parent
EMIT_LABELS = ROOT / "data" / "cursor-training-v0-emit" / "verified.jsonl"
V0_LABELS = ROOT / "data" / "cursor-training-v0" / "verified.jsonl"
V0_BASE = ROOT / "data" / "cursor-training-v0"
V1_ONNX = ROOT / "ml" / "cursor-v1.onnx"
V5_ONNX = ROOT / "ml" / "cursor-v5.onnx"

# v5 input dims (must match training)
V5_INPUT_W, V5_INPUT_H = 768, 480
V5_HEATMAP_W, V5_HEATMAP_H = V5_INPUT_W // 4, V5_INPUT_H // 4
# v1 input dims
V1_CROP = 256
V1_HEATMAP = 64

NORM_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
NORM_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def load_all_rows():
    rows = []
    for src, base in [(V0_LABELS, V0_BASE), (EMIT_LABELS, None)]:
        if not src.exists():
            continue
        with open(src) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                if base:
                    abs_path = str(base / r["frame"])
                else:
                    abs_path = r["abs_frame_path"]
                rows.append({
                    "abs_frame_path": abs_path,
                    "cursor": r["cursor"],
                    "algorithm_label": r.get("algorithm_label"),
                    "_source": "v0" if base else "emit",
                })
    return rows


def sigmoid(x):
    return np.where(x >= 0, 1.0 / (1.0 + np.exp(-x)), np.exp(x) / (1.0 + np.exp(x)))


def preprocess_v5(img):
    """Resize full image to V5_INPUT_W × V5_INPUT_H. Return native dims."""
    W, H = img.size
    img_resized = img.resize((V5_INPUT_W, V5_INPUT_H), Image.BILINEAR)
    arr = np.array(img_resized, dtype=np.float32) / 255.0
    arr = (arr - NORM_MEAN) / NORM_STD
    arr = arr.transpose(2, 0, 1)[np.newaxis, ...].astype(np.float32)
    return arr, W, H


def preprocess_v1(img, hint_x, hint_y):
    W, H = img.size
    crop_left = max(0, hint_x - V1_CROP // 2)
    crop_top = max(0, hint_y - V1_CROP // 2)
    crop_left = min(crop_left, W - V1_CROP)
    crop_top = min(crop_top, H - V1_CROP)
    crop = img.crop((crop_left, crop_top, crop_left + V1_CROP, crop_top + V1_CROP))
    arr = np.array(crop, dtype=np.float32) / 255.0
    arr = (arr - NORM_MEAN) / NORM_STD
    arr = arr.transpose(2, 0, 1)[np.newaxis, ...].astype(np.float32)
    return arr, crop_left, crop_top


def decode_v5(heatmap_logits, presence_logit, native_w, native_h):
    """v5 outputs: heatmap_logits (1,1,120,192), presence_logit (1,1)."""
    presence = float(sigmoid(presence_logit).flatten()[0])
    probs = sigmoid(heatmap_logits[0, 0])  # (120, 192)
    idx = int(probs.argmax())
    y_hm = idx // V5_HEATMAP_W
    x_hm = idx % V5_HEATMAP_W
    peak = float(probs.flatten()[idx])
    # Scale heatmap coords → native coords
    x_native = (x_hm / V5_HEATMAP_W) * native_w
    y_native = (y_hm / V5_HEATMAP_H) * native_h
    return x_native, y_native, presence, peak


def decode_v1(heatmap_logits, crop_left, crop_top):
    probs = sigmoid(heatmap_logits[0, 0])
    idx = int(probs.argmax())
    y_hm = idx // V1_HEATMAP
    x_hm = idx % V1_HEATMAP
    peak = float(probs.flatten()[idx])
    scale = V1_CROP / V1_HEATMAP
    x = crop_left + x_hm * scale + scale / 2
    y = crop_top + y_hm * scale + scale / 2
    return x, y, peak


def main():
    sess_v1 = ort.InferenceSession(str(V1_ONNX), providers=["CPUExecutionProvider"])
    sess_v5 = ort.InferenceSession(str(V5_ONNX), providers=["CPUExecutionProvider"])

    # Reproduce v5's train/val split (seed 1337, val_frac 0.2, stratified).
    rows = load_all_rows()
    rng = random.Random(1337)
    pos = [r for r in rows if r["cursor"]["visible"]]
    neg = [r for r in rows if not r["cursor"]["visible"]]
    rng.shuffle(pos)
    rng.shuffle(neg)
    val_pos = int(len(pos) * 0.2)
    val_neg = int(len(neg) * 0.2)
    val_rows = pos[:val_pos] + neg[:val_neg]

    # Split val by source
    val_emit = [r for r in val_rows if r["_source"] == "emit"]
    val_v0 = [r for r in val_rows if r["_source"] == "v0"]
    print(f"Held-out: {len(val_v0)} v0 + {len(val_emit)} emit = {len(val_rows)} total")

    def eval_subset(rows, label):
        print(f"\n=== {label} (n={len(rows)}) ===")
        v1_pos_err = []
        v1_neg_peaks = []
        v5_pos_err = []
        v5_pos_presence = []
        v5_neg_presence = []
        for r in rows:
            try:
                img = Image.open(r["abs_frame_path"]).convert("RGB")
            except Exception:
                continue
            truth = r["cursor"]
            algo = r.get("algorithm_label") or {"x": 800, "y": 500}

            # v5 (full-frame, no hint needed)
            t5, W, H = preprocess_v5(img)
            hm5, pres5 = sess_v5.run(None, {"frame": t5})
            v5_x, v5_y, v5_presence, _ = decode_v5(hm5, pres5, W, H)

            # v1 (cropped around algorithm hint)
            if algo["x"] is not None and algo["y"] is not None:
                t1, cl, ct = preprocess_v1(img, algo["x"], algo["y"])
                hm1 = sess_v1.run(None, {"frame": t1})[0]
                v1_x, v1_y, v1_peak = decode_v1(hm1, cl, ct)
            else:
                v1_x, v1_y, v1_peak = None, None, None

            if truth["visible"]:
                tx, ty = truth["x"], truth["y"]
                v5_pos_err.append(math.hypot(v5_x - tx, v5_y - ty))
                v5_pos_presence.append(v5_presence)
                if v1_x is not None:
                    # Only count v1 if truth in v1's crop
                    if 0 <= tx - cl < V1_CROP and 0 <= ty - ct < V1_CROP:
                        v1_pos_err.append(math.hypot(v1_x - tx, v1_y - ty))
            else:
                v5_neg_presence.append(v5_presence)
                if v1_peak is not None:
                    v1_neg_peaks.append(v1_peak)

        def summary(name, errs, p_pres, n_pres):
            if errs:
                s = sorted(errs)
                n = len(errs)
                print(f"  {name} pos error  n={n}  median={s[n//2]:.0f}  p75={s[(3*n)//4]:.0f}  max={s[-1]:.0f} px  mean={sum(errs)/n:.0f}")
                print(f"  {name}              <50px: {sum(1 for e in errs if e < 50)/n*100:.0f}%   <100px: {sum(1 for e in errs if e < 100)/n*100:.0f}%")
            if p_pres:
                det = sum(1 for p in p_pres if p > 0.5) / len(p_pres)
                print(f"  {name} presence>0.5 on n={len(p_pres)} positives: {det*100:.0f}%")
            if n_pres:
                fp = sum(1 for p in n_pres if p > 0.5) / len(n_pres)
                print(f"  {name} presence>0.5 on n={len(n_pres)} negatives (FP): {fp*100:.0f}%")

        summary("v1", v1_pos_err, None, v1_neg_peaks)
        summary("v5", v5_pos_err, v5_pos_presence, v5_neg_presence)

    eval_subset(val_v0, "Held-out v0 frames")
    eval_subset(val_emit, "Held-out emit-residual frames (the hard ones)")


if __name__ == "__main__":
    main()
