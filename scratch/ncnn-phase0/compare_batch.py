"""
Broader fidelity sweep: multiple real frames × multiple crop positions
(center, and 4 off-center positions), replicating a range of what
runCascade's actual grid-of-crops would feed the model in production.
"""
import glob
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

FRAMES = sorted(glob.glob(os.path.join(REPO_ROOT, "data", "openloopshape-real", "*.jpg"))) + \
         sorted(glob.glob(os.path.join(REPO_ROOT, "data", "bg-real", "*.jpg")))

sess = ort.InferenceSession(os.path.join(REPO_ROOT, "ml", "crop-heatmap.onnx"))

net = ncnn.Net()
net.load_param(os.path.join(SCRIPT_DIR, "crop_heatmap.ncnn.param"))
net.load_model(os.path.join(SCRIPT_DIR, "crop_heatmap.ncnn.bin"))


def preprocess(img, left, top):
    crop = img.crop((left, top, left + CASCADE_CROP, top + CASCADE_CROP))
    arr = np.asarray(crop, dtype=np.float32) / 255.0
    chw = np.zeros((3, CASCADE_CROP, CASCADE_CROP), dtype=np.float32)
    for c in range(3):
        chw[c] = (arr[:, :, c] - MEAN[c]) / STD[c]
    return chw


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


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


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
        (W // 2 - CASCADE_CROP // 2, H // 2 - CASCADE_CROP // 2),           # center
        (0, 0),                                                              # top-left corner
        (max(0, W - CASCADE_CROP), 0),                                       # top-right corner
        (0, max(0, H - CASCADE_CROP)),                                       # bottom-left corner
        (max(0, W - CASCADE_CROP), max(0, H - CASCADE_CROP)),                # bottom-right corner
    ]
    for (left, top) in positions:
        left = max(0, min(W - CASCADE_CROP, left))
        top = max(0, min(H - CASCADE_CROP, top))
        chw = preprocess(img, left, top)

        onnx_hm, onnx_pres = run_onnx(chw)
        ncnn_hm, ncnn_pres = run_ncnn(chw)

        diff = np.abs(onnx_hm - ncnn_hm)
        max_diffs.append(diff.max())
        n_cases += 1
        onnx_confident = sigmoid(onnx_pres) >= 0.5
        if onnx_hm.argmax() != ncnn_hm.argmax():
            argmax_mismatches += 1
            if onnx_confident:
                argmax_mismatches_when_confident += 1
                print(f"  CONFIDENT argmax mismatch: {frame_path} @ ({left},{top}) "
                      f"onnx_conf={sigmoid(onnx_pres):.4f} onnx_peak={onnx_hm.max():.4f} "
                      f"2nd_peak={np.sort(onnx_hm)[-2]:.4f}")
        if onnx_confident:
            n_confident += 1
        ncnn_decision = sigmoid(ncnn_pres) >= 0.5
        if onnx_confident != ncnn_decision:
            decision_mismatches += 1

max_diffs = np.array(max_diffs)
print(f"\ncases tested: {n_cases} (frames={len(FRAMES)} x 5 crop positions each)")
print(f"heatmap max-abs-diff across all cases: min={max_diffs.min():.6e} max={max_diffs.max():.6e} mean={max_diffs.mean():.6e}")
print(f"argmax (predicted peak location) mismatches, ALL cases: {argmax_mismatches}/{n_cases}")
print(f"  ...of which onnx was CONFIDENT (>=0.5 presence) about: {argmax_mismatches_when_confident}/{n_confident} confident cases")
print(f"presence decision (>=0.5 threshold) mismatches: {decision_mismatches}/{n_cases}")
