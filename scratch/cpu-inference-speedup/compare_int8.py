"""
Correctness check: fp32 baseline (ml/crop-heatmap.onnx) vs dynamic INT8
quantized (crop-heatmap.int8.onnx), on the same 12 real ground-truth-
centered crops used throughout this session's Phase 0 ncnn spike.
Same methodology: argmax + presence-decision match, not just "it runs."
"""
import json
import os
import numpy as np
from PIL import Image
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
DATA_DIR = os.path.join(REPO_ROOT, "data", "openloopshape-real")
CASCADE_CROP = 96
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]

with open(os.path.join(DATA_DIR, "manifest.jsonl")) as f:
    manifest = [json.loads(line) for line in f if line.strip()]

sess_fp32 = ort.InferenceSession(os.path.join(REPO_ROOT, "ml", "crop-heatmap.onnx"))
sess_int8 = ort.InferenceSession(os.path.join(SCRIPT_DIR, "crop-heatmap.int8.onnx"))


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def run(sess, chw):
    out = sess.run(None, {"crop": chw[np.newaxis]})
    by_name = {o.name: v for o, v in zip(sess.get_outputs(), out)}
    return by_name["heatmap_logits"].ravel(), by_name["presence_logit"].ravel()[0]


argmax_mismatches = 0
decision_mismatches = 0
max_diffs = []

for entry in manifest:
    path = f"{DATA_DIR}/{entry['file']}"
    img = Image.open(path).convert("RGB")
    W, H = img.size
    half = CASCADE_CROP // 2
    left = max(0, min(W - CASCADE_CROP, entry["gt_x"] - half))
    top = max(0, min(H - CASCADE_CROP, entry["gt_y"] - half))
    crop = img.crop((left, top, left + CASCADE_CROP, top + CASCADE_CROP))
    arr = np.asarray(crop, dtype=np.float32) / 255.0
    chw = np.zeros((3, CASCADE_CROP, CASCADE_CROP), dtype=np.float32)
    for c in range(3):
        chw[c] = (arr[:, :, c] - MEAN[c]) / STD[c]

    fp32_hm, fp32_pres = run(sess_fp32, chw)
    int8_hm, int8_pres = run(sess_int8, chw)

    diff = np.abs(fp32_hm - int8_hm)
    max_diffs.append(diff.max())
    fp32_confident = sigmoid(fp32_pres) >= 0.5
    int8_confident = sigmoid(int8_pres) >= 0.5
    mismatch = fp32_hm.argmax() != int8_hm.argmax()
    if mismatch:
        argmax_mismatches += 1
    if fp32_confident != int8_confident:
        decision_mismatches += 1
    print(f"{entry['file']}: fp32_conf={sigmoid(fp32_pres):.4f} int8_conf={sigmoid(int8_pres):.4f} "
          f"argmax {'MATCH' if not mismatch else 'MISMATCH'} maxdiff={diff.max():.4f}")

max_diffs = np.array(max_diffs)
print(f"\n{len(manifest)} ground-truth-centered crops")
print(f"heatmap max-abs-diff: min={max_diffs.min():.4f} max={max_diffs.max():.4f} mean={max_diffs.mean():.4f}")
print(f"argmax mismatches: {argmax_mismatches}/{len(manifest)}")
print(f"presence decision mismatches: {decision_mismatches}/{len(manifest)}")

fp32_size = os.path.getsize(os.path.join(REPO_ROOT, "ml", "crop-heatmap.onnx"))
int8_size = os.path.getsize(os.path.join(SCRIPT_DIR, "crop-heatmap.int8.onnx"))
print(f"\nmodel size: fp32={fp32_size} bytes, int8={int8_size} bytes ({fp32_size/int8_size:.2f}x smaller)")
