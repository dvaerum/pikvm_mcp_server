"""
Held-out evaluation: v0 vs v1 vs v2 on the combined val set
(stratified split from data/cursor-training-v0 + data/ml-live-capture,
seed=1337, same as train-cursor-v2.py).

The split is the SAME for all three models so the comparison is
apples-to-apples on a single held-out set.

Usage:
  source .venv/bin/activate && python3 ml/eval-cursor-v2.py
"""
import json
import random
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).parent.parent

DATA_SOURCES = [
    (
        ROOT / "data" / "cursor-training-v0",
        ROOT / "data" / "cursor-training-v0" / "verified.jsonl",
    ),
    (
        ROOT / "data" / "ml-live-capture",
        ROOT / "data" / "ml-live-capture" / "verified.jsonl",
    ),
]

OUT = ROOT / "ml"
MODELS = [
    ("cursor-v2",            OUT / "cursor-v2.onnx"),
    ("cursor-v1",            OUT / "cursor-v1.onnx"),
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


def load_verified() -> list:
    rows = []
    for data_dir, jsonl_path in DATA_SOURCES:
        if not jsonl_path.exists():
            continue
        with open(jsonl_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                row["_source_dir"] = str(data_dir)
                rows.append(row)
    return rows


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
        src_dir = Path(row["_source_dir"])
        img = Image.open(src_dir / row["frame"]).convert("RGB")
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


def fmt(model_name, pd, pc, nc):
    lines = [f"=== {model_name} ==="]
    lines.append(
        f"  positives n={len(pd)}  median={np.median(pd):.1f}px  "
        f"mean={np.mean(pd):.1f}px"
    )
    for t in THRESHOLDS:
        det = sum(1 for c in pc if c > t) / max(1, len(pc))
        lines.append(f"    det@{t:.1f} = {det:.2%}")
    lines.append(
        f"  negatives n={len(nc)}  median_conf={np.median(nc):.3f}  "
        f"mean_conf={np.mean(nc):.3f}"
    )
    for t in THRESHOLDS:
        fp = sum(1 for c in nc if c > t) / max(1, len(nc))
        lines.append(f"    fp@{t:.1f}  = {fp:.2%}")
    return "\n".join(lines)


def main():
    rows = load_verified()
    val = stratified_split(rows, VAL_FRACTION, SEED)
    p = sum(1 for r in val if r["cursor"]["visible"])
    n = sum(1 for r in val if not r["cursor"]["visible"])
    print(f"Held-out val: {len(val)} ({p} pos / {n} neg)")
    print()
    out_lines = [f"Held-out val: {len(val)} ({p} pos / {n} neg)\n"]
    for name, path in MODELS:
        if not path.exists():
            block = f"=== {name} ===\n  MISSING: {path}"
        else:
            pd, pc, nc = evaluate(path, val)
            block = fmt(name, pd, pc, nc)
        print(block + "\n")
        out_lines.append(block + "\n")
    report = "\n".join(out_lines)
    (OUT / "eval-cursor-v2-report.txt").write_text(report)
    print(f"Saved → {OUT / 'eval-cursor-v2-report.txt'}")


if __name__ == "__main__":
    main()
