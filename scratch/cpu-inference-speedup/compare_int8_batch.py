"""
Broader INT8-vs-fp32 correctness sweep: same 135-case grid (27 real frames
x 5 crop positions, mostly background/no-cursor content) used for the
ncnn Phase 0 fidelity check, applied here to INT8 quantization instead.
"""
import glob
import os
import numpy as np
from PIL import Image
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
CASCADE_CROP = 96
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]

FRAMES = sorted(glob.glob(os.path.join(REPO_ROOT, "data", "openloopshape-real", "*.jpg"))) + \
         sorted(glob.glob(os.path.join(REPO_ROOT, "data", "bg-real", "*.jpg")))

sess_fp32 = ort.InferenceSession(os.path.join(REPO_ROOT, "ml", "crop-heatmap.onnx"))
sess_int8 = ort.InferenceSession(os.path.join(SCRIPT_DIR, "crop-heatmap.int8.onnx"))


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def preprocess(img, left, top):
    crop = img.crop((left, top, left + CASCADE_CROP, top + CASCADE_CROP))
    arr = np.asarray(crop, dtype=np.float32) / 255.0
    chw = np.zeros((3, CASCADE_CROP, CASCADE_CROP), dtype=np.float32)
    for c in range(3):
        chw[c] = (arr[:, :, c] - MEAN[c]) / STD[c]
    return chw


def run(sess, chw):
    out = sess.run(None, {"crop": chw[np.newaxis]})
    by_name = {o.name: v for o, v in zip(sess.get_outputs(), out)}
    return by_name["heatmap_logits"].ravel(), by_name["presence_logit"].ravel()[0]


max_diffs = []
argmax_mismatches = 0
argmax_mismatches_when_confident = 0
decision_mismatches = 0
n_cases = 0
n_confident = 0

for frame_path in FRAMES:
    img = Image.open(frame_path).convert("RGB")
    W, H = img.size
    positions = [
        (W // 2 - CASCADE_CROP // 2, H // 2 - CASCADE_CROP // 2),
        (0, 0),
        (max(0, W - CASCADE_CROP), 0),
        (0, max(0, H - CASCADE_CROP)),
        (max(0, W - CASCADE_CROP), max(0, H - CASCADE_CROP)),
    ]
    for (left, top) in positions:
        left = max(0, min(W - CASCADE_CROP, left))
        top = max(0, min(H - CASCADE_CROP, top))
        chw = preprocess(img, left, top)

        fp32_hm, fp32_pres = run(sess_fp32, chw)
        int8_hm, int8_pres = run(sess_int8, chw)

        diff = np.abs(fp32_hm - int8_hm)
        max_diffs.append(diff.max())
        n_cases += 1
        fp32_confident = sigmoid(fp32_pres) >= 0.5
        int8_confident = sigmoid(int8_pres) >= 0.5
        if fp32_confident:
            n_confident += 1
        mismatch = fp32_hm.argmax() != int8_hm.argmax()
        if mismatch:
            argmax_mismatches += 1
            if fp32_confident:
                argmax_mismatches_when_confident += 1
                print(f"  CONFIDENT argmax mismatch: {frame_path} @ ({left},{top}) "
                      f"fp32_conf={sigmoid(fp32_pres):.4f}")
        if fp32_confident != int8_confident:
            decision_mismatches += 1
            print(f"  DECISION mismatch: {frame_path} @ ({left},{top}) "
                  f"fp32_conf={sigmoid(fp32_pres):.4f} int8_conf={sigmoid(int8_pres):.4f}")

max_diffs = np.array(max_diffs)
print(f"\ncases tested: {n_cases} (frames={len(FRAMES)} x 5 crop positions each)")
print(f"heatmap max-abs-diff: min={max_diffs.min():.4f} max={max_diffs.max():.4f} mean={max_diffs.mean():.4f}")
print(f"argmax mismatches, ALL cases: {argmax_mismatches}/{n_cases}")
print(f"  ...of which fp32 was CONFIDENT (>=0.5) about: {argmax_mismatches_when_confident}/{n_confident} confident cases")
print(f"presence decision mismatches: {decision_mismatches}/{n_cases}")
