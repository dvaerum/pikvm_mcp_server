"""
Fidelity comparison restricted to crops CENTERED on the real, ground-truth
cursor position (from openloopshape-real/analysis.json) — this is where
the model is actually meant to fire confidently, unlike the previous
sweep's mostly-background/no-cursor crops.
"""
import json
import os
import numpy as np
from PIL import Image
import onnxruntime as ort
import ncnn

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))

CASCADE_CROP = 96
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]
DATA_DIR = os.path.join(REPO_ROOT, "data", "openloopshape-real")

with open(f"{DATA_DIR}/analysis.json") as f:
    analysis = json.load(f)

sess = ort.InferenceSession(os.path.join(REPO_ROOT, "ml", "crop-heatmap.onnx"))
net = ncnn.Net()
net.load_param(os.path.join(SCRIPT_DIR, "crop_heatmap.ncnn.param"))
net.load_model(os.path.join(SCRIPT_DIR, "crop_heatmap.ncnn.bin"))


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def run_onnx(chw):
    out = sess.run(None, {"crop": chw[np.newaxis]})
    by_name = {o.name: v for o, v in zip(sess.get_outputs(), out)}
    return by_name["heatmap_logits"].ravel(), by_name["presence_logit"].ravel()[0]


def run_ncnn(chw):
    ex = net.create_extractor()
    mat_in = ncnn.Mat(CASCADE_CROP, CASCADE_CROP, 3)
    np.array(mat_in, copy=False)[:] = chw
    ex.input("in0", mat_in)
    _, out0 = ex.extract("out0")
    _, out1 = ex.extract("out1")
    return np.array(out0).ravel(), np.array(out1).ravel()[0]


max_diffs = []
argmax_mismatches = 0
decision_mismatches = 0
n = 0
n_confident = 0

for entry in analysis["results"]:
    path = f"{DATA_DIR}/{entry['file']}"
    gt = entry["gt"]
    img = Image.open(path).convert("RGB")
    W, H = img.size
    half = CASCADE_CROP // 2
    left = max(0, min(W - CASCADE_CROP, gt["x"] - half))
    top = max(0, min(H - CASCADE_CROP, gt["y"] - half))

    crop = img.crop((left, top, left + CASCADE_CROP, top + CASCADE_CROP))
    arr = np.asarray(crop, dtype=np.float32) / 255.0
    chw = np.zeros((3, CASCADE_CROP, CASCADE_CROP), dtype=np.float32)
    for c in range(3):
        chw[c] = (arr[:, :, c] - MEAN[c]) / STD[c]

    onnx_hm, onnx_pres = run_onnx(chw)
    ncnn_hm, ncnn_pres = run_ncnn(chw)

    diff = np.abs(onnx_hm - ncnn_hm)
    max_diffs.append(diff.max())
    n += 1
    onnx_confident = sigmoid(onnx_pres) >= 0.5
    ncnn_confident = sigmoid(ncnn_pres) >= 0.5
    if onnx_confident:
        n_confident += 1
    if onnx_confident != ncnn_confident:
        decision_mismatches += 1
    mismatch = onnx_hm.argmax() != ncnn_hm.argmax()
    if mismatch:
        argmax_mismatches += 1
    tag = "CONFIDENT" if onnx_confident else "low-conf"
    print(f"{entry['file']}: onnx_conf={sigmoid(onnx_pres):.4f} [{tag}] "
          f"argmax {'MATCH' if not mismatch else 'MISMATCH'} maxdiff={diff.max():.2e}")

max_diffs = np.array(max_diffs)
print(f"\n{n} ground-truth-centered crops, {n_confident} were confident (>=0.5) per onnx")
print(f"heatmap max-abs-diff: min={max_diffs.min():.6e} max={max_diffs.max():.6e} mean={max_diffs.mean():.6e}")
print(f"argmax mismatches: {argmax_mismatches}/{n}")
print(f"presence decision mismatches: {decision_mismatches}/{n}")
