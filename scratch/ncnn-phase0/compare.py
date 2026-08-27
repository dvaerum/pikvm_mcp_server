"""
Numerical fidelity comparison: onnxruntime (the real production path,
matching cursor-ml-detect.ts's runCascade exactly) vs the pnnx-converted
ncnn model, on a REAL captured iPad-rig frame (not synthetic data).

Preprocessing replicates runCascade()'s exact steps (cursor-ml-detect.ts):
  - crop CASCADE_CROP=96x96 from a fixed, in-bounds region of the real frame
  - per-channel: (pixel/255 - MEAN[c]) / STD[c], ImageNet stats
  - NCHW float32, batch size 1 (N=1 is enough to prove numerical fidelity;
    the cascade's batching over many crop centers is an unrelated batching
    concern, not a per-crop numerical one)
"""
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

FRAME_PATH = os.path.join(REPO_ROOT, "data", "openloopshape-real", "frame-mid-center-01.jpg")

img = Image.open(FRAME_PATH).convert("RGB")
W, H = img.size
print(f"real frame: {FRAME_PATH} ({W}x{H})")

# Center crop (same clamp logic as runCascade's per-center crop math) —
# picking the frame's actual center gives a representative real 96x96
# real-content crop, same idea as one entry in the cascade's grid.
left = max(0, min(W - CASCADE_CROP, W // 2 - CASCADE_CROP // 2))
top = max(0, min(H - CASCADE_CROP, H // 2 - CASCADE_CROP // 2))
crop = img.crop((left, top, left + CASCADE_CROP, top + CASCADE_CROP))
arr = np.asarray(crop, dtype=np.float32) / 255.0  # HWC, RGB, [0,1]

chw = np.zeros((3, CASCADE_CROP, CASCADE_CROP), dtype=np.float32)
for c in range(3):
    chw[c] = (arr[:, :, c] - MEAN[c]) / STD[c]
input_nchw = chw[np.newaxis, :, :, :]  # [1,3,96,96]

# ---- onnxruntime baseline (matches cursor-ml-detect.ts's runCascade) ----
sess = ort.InferenceSession(os.path.join(REPO_ROOT, "ml", "crop-heatmap.onnx"))
print("onnxruntime input names:", [i.name for i in sess.get_inputs()])
print("onnxruntime output names:", [o.name for o in sess.get_outputs()])
ort_out = sess.run(None, {"crop": input_nchw})
ort_by_name = {o.name: v for o, v in zip(sess.get_outputs(), ort_out)}
ort_heatmap = ort_by_name["heatmap_logits"]  # [1,1,24,24]
ort_presence = ort_by_name["presence_logit"]  # [1]

# ---- ncnn (pnnx-converted) ----
net = ncnn.Net()
net.load_param(os.path.join(SCRIPT_DIR, "crop_heatmap.ncnn.param"))
net.load_model(os.path.join(SCRIPT_DIR, "crop_heatmap.ncnn.bin"))

ex = net.create_extractor()
# NOTE: ncnn.Mat(numpy_array) (the "Buffer" constructor overload) infers
# shape correctly but does NOT actually copy the data in this binding
# version — round-trips to uninitialized garbage. Verified with a
# controlled random-array test before trusting any model output. The
# robust pattern: construct an empty Mat with explicit dims, then assign
# through the writable .numpy() view.
mat_in = ncnn.Mat(CASCADE_CROP, CASCADE_CROP, 3)
np.array(mat_in, copy=False)[:] = chw
ex.input("in0", mat_in)
_, mat_out0 = ex.extract("out0")  # heatmap branch
_, mat_out1 = ex.extract("out1")  # presence branch

ncnn_heatmap = np.array(mat_out0).reshape(1, 1, 24, 24)
ncnn_presence = np.array(mat_out1).reshape(1)

# ---- compare ----
def compare(name, a, b):
    a = a.astype(np.float64).ravel()
    b = b.astype(np.float64).ravel()
    abs_diff = np.abs(a - b)
    print(f"\n{name}: shape a={a.shape} b={b.shape}")
    print(f"  onnxruntime range: [{a.min():.6f}, {a.max():.6f}]")
    print(f"  ncnn        range: [{b.min():.6f}, {b.max():.6f}]")
    print(f"  max abs diff: {abs_diff.max():.6e}")
    print(f"  mean abs diff: {abs_diff.mean():.6e}")
    # argmax location match matters more than raw logit closeness for
    # this model (argmax of the heatmap IS the prediction) — compare that too.
    if a.size > 1:
        print(f"  argmax match: onnx={a.argmax()} ncnn={b.argmax()} {'MATCH' if a.argmax()==b.argmax() else 'MISMATCH'}")

compare("heatmap_logits", ort_heatmap, ncnn_heatmap)
compare("presence_logit", ort_presence, ncnn_presence)

# sigmoid(presence) — the actual gate value runCascade thresholds against
def sigmoid(x): return 1 / (1 + np.exp(-x))
print(f"\npresence confidence: onnx={sigmoid(ort_presence[0]):.6f} ncnn={sigmoid(ncnn_presence[0]):.6f}")
