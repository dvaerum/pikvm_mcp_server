"""
Held-out evaluation of cursor-v1.onnx vs cursor-v0.bad-labels.onnx.

Uses the same stratified 80/20 split as training (seed=1337) so the
val set is genuinely held out for cursor-v1. cursor-v0 trained on
the per-frame .json labels, which overlapped with what is now the
v1 val set — its numbers here are not held-out for v0 but are still
informative as a delta.

Reports per model:
  positives (n=64): median dist (px), mean dist, det rate @ 0.3/0.5/0.7
  negatives (n=31): peak conf median/mean, FP rate @ 0.3/0.5/0.7

Writes ml/eval-cursor-v1-report.txt.

Usage:
  source .venv/bin/activate && python3 ml/eval-cursor-v1.py
"""
import json
import random
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data" / "cursor-training-v0"
VERIFIED = DATA_DIR / "verified.jsonl"
OUT = ROOT / "ml"

MODELS = [
    ("cursor-v1", OUT / "cursor-v1.onnx"),
    ("cursor-v0.bad-labels", OUT / "cursor-v0.bad-labels.onnx"),
]

CROP_SIZE = 256
HEATMAP = 64
SCALE = CROP_SIZE // HEATMAP
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 3, 1, 1)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 3, 1, 1)
SEED = 1337
VAL_FRACTION = 0.2
THRESHOLDS = [0.3, 0.5, 0.7]


def stratified_split(rows, val_fraction, seed):
    rng = random.Random(seed)
    pos = [r for r in rows if r["cursor"]["visible"]]
    neg = [r for r in rows if not r["cursor"]["visible"]]
    rng.shuffle(pos)
    rng.shuffle(neg)
    val_pos = int(len(pos) * val_fraction)
    val_neg = int(len(neg) * val_fraction)
    return pos[:val_pos] + neg[:val_neg]


def crop_around(img, cx, cy):
    W, H = img.size
    left = max(0, min(W - CROP_SIZE, cx - CROP_SIZE // 2))
    top = max(0, min(H - CROP_SIZE, cy - CROP_SIZE // 2))
    return img.crop((left, top, left + CROP_SIZE, top + CROP_SIZE)), left, top


def predict(sess, img_crop):
    arr = np.array(img_crop, dtype=np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)[None, ...]
    arr = (arr - MEAN) / STD
    logits = sess.run(None, {"frame": arr.astype(np.float32)})[0]
    prob = 1.0 / (1.0 + np.exp(-logits))
    flat = prob[0, 0].flatten()
    idx = int(np.argmax(flat))
    peak = float(flat[idx])
    py = (idx // HEATMAP) * SCALE + SCALE // 2
    px = (idx % HEATMAP) * SCALE + SCALE // 2
    return px, py, peak


def evaluate(model_path: Path, val_rows: list):
    sess = ort.InferenceSession(str(model_path))
    pos_dists = []
    pos_confs = []
    neg_confs = []
    for row in val_rows:
        img = Image.open(DATA_DIR / row["frame"]).convert("RGB")
        visible = row["cursor"]["visible"]
        if visible:
            cx, cy = row["cursor"]["x"], row["cursor"]["y"]
        else:
            cx, cy = row["algorithm_label"]["x"], row["algorithm_label"]["y"]
        crop, left, top = crop_around(img, cx, cy)
        px, py, peak = predict(sess, crop)
        if visible:
            pred_x = px + left
            pred_y = py + top
            dist = ((pred_x - row["cursor"]["x"]) ** 2 +
                    (pred_y - row["cursor"]["y"]) ** 2) ** 0.5
            pos_dists.append(dist)
            pos_confs.append(peak)
        else:
            neg_confs.append(peak)
    return pos_dists, pos_confs, neg_confs


def fmt(model_name, pos_dists, pos_confs, neg_confs):
    lines = [f"=== {model_name} ==="]
    lines.append(
        f"  positives n={len(pos_dists)}  "
        f"median_dist={np.median(pos_dists):.1f}px  "
        f"mean_dist={np.mean(pos_dists):.1f}px"
    )
    for t in THRESHOLDS:
        det = sum(1 for c in pos_confs if c > t) / max(1, len(pos_confs))
        lines.append(f"    det@{t:.1f} = {det:.2%}")
    lines.append(
        f"  negatives n={len(neg_confs)}  "
        f"median_conf={np.median(neg_confs):.3f}  "
        f"mean_conf={np.mean(neg_confs):.3f}"
    )
    for t in THRESHOLDS:
        fp = sum(1 for c in neg_confs if c > t) / max(1, len(neg_confs))
        lines.append(f"    fp@{t:.1f}  = {fp:.2%}")
    return "\n".join(lines)


def main():
    rows = [json.loads(l) for l in open(VERIFIED)]
    val_rows = stratified_split(rows, VAL_FRACTION, SEED)
    pos_n = sum(1 for r in val_rows if r["cursor"]["visible"])
    neg_n = sum(1 for r in val_rows if not r["cursor"]["visible"])
    print(f"Held-out val: {len(val_rows)} ({pos_n} pos / {neg_n} neg)")
    print()

    out_lines = [f"Held-out val: {len(val_rows)} ({pos_n} pos / {neg_n} neg)\n"]
    for name, path in MODELS:
        if not path.exists():
            block = f"=== {name} ===\n  MISSING: {path}"
        else:
            pd, pc, nc = evaluate(path, val_rows)
            block = fmt(name, pd, pc, nc)
        print(block + "\n")
        out_lines.append(block + "\n")

    report = "\n".join(out_lines)
    (OUT / "eval-cursor-v1-report.txt").write_text(report)
    print(f"Saved report → {OUT / 'eval-cursor-v1-report.txt'}")


if __name__ == "__main__":
    main()
