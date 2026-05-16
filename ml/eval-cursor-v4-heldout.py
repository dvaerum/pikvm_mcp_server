"""Held-out evaluation of v4 vs v1.

The training script splits emit-residual rows 80/20 train/val with seed
1337. Run the same split and evaluate ONLY on the val subset — those
are samples v4 has NOT seen during training, so the comparison to v1
is fair (v1 hasn't seen any emit-residual data).
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
V4_ONNX = ROOT / "ml" / "cursor-v4.onnx"

CROP_SIZE = 256
HEATMAP_SIZE = 64
HEATMAP_SCALE = CROP_SIZE / HEATMAP_SIZE  # = 4
SEED = 1337  # MUST match train-cursor-v4.py
VAL_FRACTION = 0.2

NORM_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
NORM_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def load_all_rows():
    rows = []
    if V0_LABELS.exists():
        with open(V0_LABELS) as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    rows.append({
                        "abs_frame_path": str(V0_BASE / r["frame"]),
                        "cursor": r["cursor"],
                        "algorithm_label": r["algorithm_label"],
                        "_source": "v0",
                    })
    if EMIT_LABELS.exists():
        with open(EMIT_LABELS) as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    rows.append({
                        "abs_frame_path": r["abs_frame_path"],
                        "cursor": r["cursor"],
                        "algorithm_label": r["algorithm_label"],
                        "_source": "emit",
                    })
    return rows


def stratified_split(rows):
    """Reproduce the same split as train-cursor-v4.py."""
    rng = random.Random(SEED)
    pos = [r for r in rows if r["cursor"]["visible"]]
    neg = [r for r in rows if not r["cursor"]["visible"]]
    rng.shuffle(pos)
    rng.shuffle(neg)
    val_pos_n = int(len(pos) * VAL_FRACTION)
    val_neg_n = int(len(neg) * VAL_FRACTION)
    val = pos[:val_pos_n] + neg[:val_neg_n]
    return val


def preprocess(img, cx, cy):
    W, H = img.size
    crop_left = max(0, cx - CROP_SIZE // 2)
    crop_top = max(0, cy - CROP_SIZE // 2)
    crop_left = min(crop_left, W - CROP_SIZE)
    crop_top = min(crop_top, H - CROP_SIZE)
    crop = img.crop((crop_left, crop_top, crop_left + CROP_SIZE, crop_top + CROP_SIZE))
    arr = np.array(crop, dtype=np.float32) / 255.0
    arr = (arr - NORM_MEAN) / NORM_STD
    arr = arr.transpose(2, 0, 1)
    arr = arr[np.newaxis, ...]
    return arr.astype(np.float32), crop_left, crop_top


def sigmoid(x):
    # Numerically stable
    return np.where(x >= 0, 1.0 / (1.0 + np.exp(-x)), np.exp(x) / (1.0 + np.exp(x)))


def decode_peak(heatmap_logits):
    probs = sigmoid(heatmap_logits)
    flat = probs.reshape(-1)
    idx = int(flat.argmax())
    y = idx // HEATMAP_SIZE
    x = idx % HEATMAP_SIZE
    peak = float(flat[idx])
    return x * HEATMAP_SCALE, y * HEATMAP_SCALE, peak


def eval_model(sess, val_rows, label):
    pos_errs = []
    pos_peaks = []
    neg_peaks = []
    for row in val_rows:
        try:
            img = Image.open(row["abs_frame_path"]).convert("RGB")
        except Exception:
            continue
        algo = row["algorithm_label"]
        if algo["x"] is None:
            continue
        tensor, crop_left, crop_top = preprocess(img, algo["x"], algo["y"])
        out = sess.run(None, {"frame": tensor})[0]
        x_local, y_local, peak = decode_peak(out)
        px = crop_left + x_local
        py = crop_top + y_local

        truth = row["cursor"]
        if truth["visible"]:
            tx, ty = truth["x"], truth["y"]
            if 0 <= tx - crop_left < CROP_SIZE and 0 <= ty - crop_top < CROP_SIZE:
                pos_errs.append(math.hypot(px - tx, py - ty))
                pos_peaks.append(peak)
        else:
            neg_peaks.append(peak)

    n = len(pos_errs)
    print(f"  {label}:")
    if n:
        s = sorted(pos_errs)
        print(f"    positives n={n}  median={s[n//2]:.1f}  p75={s[(3*n)//4]:.1f}  max={s[-1]:.1f}  mean={sum(s)/n:.1f} px")
        print(f"    under 25px: {sum(1 for e in pos_errs if e < 25)/n*100:.0f}%   under 50px: {sum(1 for e in pos_errs if e < 50)/n*100:.0f}%")
        det = sum(1 for p in pos_peaks if p > 0.5) / len(pos_peaks)
        print(f"    detection rate (peak>0.5): {det*100:.0f}%")
    if neg_peaks:
        fp = sum(1 for p in neg_peaks if p > 0.5) / len(neg_peaks)
        print(f"    FP rate (peak>0.5) on n={len(neg_peaks)} negatives: {fp*100:.0f}%")
    return pos_errs, pos_peaks, neg_peaks


def main():
    rows = load_all_rows()
    val_rows = stratified_split(rows)
    # Separate by source for finer comparison
    val_emit = [r for r in val_rows if r["_source"] == "emit"]
    val_v0 = [r for r in val_rows if r["_source"] == "v0"]
    print(f"Held-out validation set:")
    print(f"  {len(val_v0)} from v0 source")
    print(f"  {len(val_emit)} from emit-residual source")
    print(f"  total {len(val_rows)}")

    sess_v1 = ort.InferenceSession(str(V1_ONNX), providers=["CPUExecutionProvider"])
    sess_v4 = ort.InferenceSession(str(V4_ONNX), providers=["CPUExecutionProvider"])

    print()
    print("=== Held-out subset: emit-residual frames ===")
    print("(production-like distribution — neither v1 nor v4 saw THESE specific frames)")
    eval_model(sess_v1, val_emit, "v1")
    eval_model(sess_v4, val_emit, "v4")

    print()
    print("=== Held-out subset: v0 frames ===")
    print("(original training distribution — neither v1 nor v4 saw THESE specific frames)")
    eval_model(sess_v1, val_v0, "v1")
    eval_model(sess_v4, val_v0, "v4")

    print()
    print("=== Full held-out (combined) ===")
    eval_model(sess_v1, val_rows, "v1")
    eval_model(sess_v4, val_rows, "v4")


if __name__ == "__main__":
    main()
