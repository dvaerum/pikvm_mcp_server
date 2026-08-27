"""
Diagnose the one CONFIDENT argmax mismatch found in the 135-case INT8
sweep: frame-mid-center-01.jpg @ crop (912,492). How far apart are the
fp32 and int8 predicted PIXEL positions, not just "different heatmap
cell index" — a 1-cell heatmap shift is only ~4px in the real crop
(scale = 96/24), which may or may not matter for click accuracy.
"""
import os
import numpy as np
from PIL import Image
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
CASCADE_CROP = 96
HEATMAP_SIZE = 24
SCALE = CASCADE_CROP / HEATMAP_SIZE  # 4
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]

sess_fp32 = ort.InferenceSession(os.path.join(REPO_ROOT, "ml", "crop-heatmap.onnx"))
sess_int8 = ort.InferenceSession(os.path.join(SCRIPT_DIR, "crop-heatmap.int8.onnx"))


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def run(sess, chw):
    out = sess.run(None, {"crop": chw[np.newaxis]})
    by_name = {o.name: v for o, v in zip(sess.get_outputs(), out)}
    return by_name["heatmap_logits"].ravel(), by_name["presence_logit"].ravel()[0]


def to_pixel(idx):
    peak_y, peak_x = divmod(idx, HEATMAP_SIZE)
    local_x = round(peak_x * SCALE + SCALE / 2)
    local_y = round(peak_y * SCALE + SCALE / 2)
    return local_x, local_y


path = os.path.join(REPO_ROOT, "data", "openloopshape-real", "frame-mid-center-01.jpg")
left, top = 912, 492

img = Image.open(path).convert("RGB")
crop = img.crop((left, top, left + CASCADE_CROP, top + CASCADE_CROP))
arr = np.asarray(crop, dtype=np.float32) / 255.0
chw = np.zeros((3, CASCADE_CROP, CASCADE_CROP), dtype=np.float32)
for c in range(3):
    chw[c] = (arr[:, :, c] - MEAN[c]) / STD[c]

fp32_hm, fp32_pres = run(sess_fp32, chw)
int8_hm, int8_pres = run(sess_int8, chw)

fp32_idx = fp32_hm.argmax()
int8_idx = int8_hm.argmax()
fp32_xy = to_pixel(fp32_idx)
int8_xy = to_pixel(int8_idx)
dist = ((fp32_xy[0] - int8_xy[0]) ** 2 + (fp32_xy[1] - int8_xy[1]) ** 2) ** 0.5

print(f"fp32: idx={fp32_idx} pixel={fp32_xy} confidence={sigmoid(fp32_pres):.4f}")
print(f"int8: idx={int8_idx} pixel={int8_xy} confidence={sigmoid(int8_pres):.4f}")
print(f"pixel distance between predictions: {dist:.2f}px (crop is {CASCADE_CROP}x{CASCADE_CROP}, heatmap cell = {SCALE}px)")

# Also show the top-3 heatmap peaks for fp32 to see if int8's peak was a
# close runner-up (near-tie) rather than a wildly different region.
top3_fp32 = np.argsort(fp32_hm)[-3:][::-1]
print("\nfp32 top-3 peaks (idx, logit, pixel):")
for i in top3_fp32:
    print(f"  idx={i} logit={fp32_hm[i]:.4f} pixel={to_pixel(i)}")
print(f"\nWas int8's chosen peak among fp32's top-3? {'YES' if int8_idx in top3_fp32 else 'NO'}")
