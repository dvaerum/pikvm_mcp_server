"""
Compare v1, v2, v3 on the ORIGINAL v0 verified.jsonl (478 entries,
hand-labeled, high quality). If v3 is much worse than v1 here,
the new training data poisoned the model.

Uses the FULL v0 set, not a val split — we want to see overall
behavior, not held-out generalization.

Usage: source .venv/bin/activate && python3 ml/eval-on-v0-only.py
"""
import json
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
    ("cursor-v2", OUT / "cursor-v2.onnx"),
    ("cursor-v3", OUT / "cursor-v3.onnx"),
]

CROP_SIZE = 256
HEATMAP = 64
SCALE = CROP_SIZE // HEATMAP
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 3, 1, 1)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 3, 1, 1)


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


def main():
    with open(VERIFIED) as f:
        rows = [json.loads(l) for l in f]
    p = sum(1 for r in rows if r["cursor"]["visible"])
    n = sum(1 for r in rows if not r["cursor"]["visible"])
    print(f"v0 dataset: {len(rows)} ({p} pos / {n} neg)")
    print()

    for name, path in MODELS:
        sess = ort.InferenceSession(str(path))
        dists, pos_confs, neg_confs = [], [], []
        for row in rows:
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
                dists.append(dist)
                pos_confs.append(peak)
            else:
                neg_confs.append(peak)

        median = np.median(dists)
        mean = np.mean(dists)
        det50 = sum(1 for c in pos_confs if c > 0.5) / len(pos_confs)
        fp50 = sum(1 for c in neg_confs if c > 0.5) / len(neg_confs)
        print(f"=== {name} on v0 (n={len(rows)}) ===")
        print(f"  positives: median={median:.1f}px mean={mean:.1f}px det@0.5={det50:.2%}")
        print(f"  negatives: fp@0.5={fp50:.2%} median_conf={np.median(neg_confs):.3f}")
        print()


if __name__ == "__main__":
    main()
