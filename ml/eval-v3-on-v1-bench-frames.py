"""
Run cursor-v3 on the EXACT 60 frames that v1 was tested on
(data/ml-live-capture/). Compare per-frame to v1's predictions
(saved as the sidecar ml_prediction at capture time).

For each frame:
- Read the JSON sidecar: hint (where v1 was queried), ml_prediction
  (what v1 said).
- Read the JPG.
- Run v3 with same hint.
- Compare v3 vs v1 prediction.
- Apply visible/agreement from verified.jsonl (the ground-truth
  labels).

Result tells us: on the SAME frames, with the SAME hints, is v3
better or worse than v1?

Usage: source .venv/bin/activate && python3 ml/eval-v3-on-v1-bench-frames.py
"""
import json
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).parent.parent
LIVE_DIR = ROOT / "data" / "ml-live-capture"
VERIFIED = LIVE_DIR / "verified.jsonl"

V3_PATH = ROOT / "ml" / "cursor-v3.onnx"

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
    # Load labels keyed by frame basename
    labels = {}
    with open(VERIFIED) as f:
        for line in f:
            row = json.loads(line)
            labels[row["frame"]] = row

    sess = ort.InferenceSession(str(V3_PATH))
    print(f"=== cursor-v3 on the {len(labels)} ml-live-capture frames ===")
    print()

    v3_correct_among_visible = 0
    v3_fp_among_absent = 0
    n_visible = 0
    n_absent = 0
    v3_dists = []

    for frame_name, label in labels.items():
        sidecar = json.loads((LIVE_DIR / frame_name.replace('.jpg', '.json')).read_text())
        hint = sidecar["hint"]
        v1_pred = sidecar["ml_prediction"]

        img = Image.open(LIVE_DIR / frame_name).convert("RGB")
        crop, left, top = crop_around(img, hint["x"], hint["y"])
        v3_x, v3_y, v3_conf = predict(sess, crop)
        v3_pred = {"x": v3_x + left, "y": v3_y + top, "confidence": v3_conf}

        visible = label["cursor"]["visible"]
        if visible:
            n_visible += 1
            true_x, true_y = label["cursor"]["x"], label["cursor"]["y"]
            v1_dist = ((v1_pred["x"] - true_x) ** 2 + (v1_pred["y"] - true_y) ** 2) ** 0.5
            v3_dist = ((v3_pred["x"] - true_x) ** 2 + (v3_pred["y"] - true_y) ** 2) ** 0.5
            v3_dists.append(v3_dist)
            if v3_dist <= 30 and v3_conf > 0.5:
                v3_correct_among_visible += 1
        else:
            n_absent += 1
            if v3_conf > 0.5:
                v3_fp_among_absent += 1

    print(f"Visible cursors: {n_visible}")
    print(f"  v3 CORRECT (≤30px AND conf > 0.5): {v3_correct_among_visible}/{n_visible} = {v3_correct_among_visible/n_visible:.0%}")
    if v3_dists:
        print(f"  v3 median dist (all visible): {np.median(v3_dists):.1f}px")
    print()
    print(f"Cursor absent: {n_absent}")
    print(f"  v3 FP (conf > 0.5): {v3_fp_among_absent}/{n_absent} = {v3_fp_among_absent/n_absent:.0%}")


if __name__ == "__main__":
    main()
