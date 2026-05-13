"""
Test the trained ONNX cursor detector on UNSEEN Phase 312 frames.
The Phase 312 frames have ground-truth cursor positions (visually
verified in tick that produced them).
"""
import sys
import json
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).parent.parent
MODEL = ROOT / "ml" / "cursor-v0.onnx"

# Phase 312 frames with visually-confirmed cursors
TEST_FRAMES = [
    {"path": "data/phase312-acceptance/2026-05-13_04-58-34/mid_left.jpg",
     "cursor_gt": (1007, 777)},
    {"path": "data/phase312-acceptance/2026-05-13_04-58-34/mid_upleft.jpg",
     "cursor_gt": (1026, 653)},
    {"path": "data/phase312-acceptance/2026-05-13_04-58-34/mid_above.jpg",
     "cursor_gt": (1150, 633)},
]

session = ort.InferenceSession(str(MODEL))
print(f"Model: {MODEL}")
print(f"Inputs: {[i.name + ':' + str(i.shape) for i in session.get_inputs()]}")
print(f"Outputs: {[o.name + ':' + str(o.shape) for o in session.get_outputs()]}")

CROP_SIZE = 256
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 3, 1, 1)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 3, 1, 1)

for tf in TEST_FRAMES:
    img_path = ROOT / tf["path"]
    cx, cy = tf["cursor_gt"]

    img = Image.open(img_path).convert("RGB")
    # Crop 256x256 centered on cursor (best case: hint = ground truth)
    crop_left = max(0, cx - CROP_SIZE // 2)
    crop_top = max(0, cy - CROP_SIZE // 2)
    crop_left = min(crop_left, img.width - CROP_SIZE)
    crop_top = min(crop_top, img.height - CROP_SIZE)
    img_crop = img.crop((crop_left, crop_top, crop_left + CROP_SIZE, crop_top + CROP_SIZE))
    arr = np.array(img_crop, dtype=np.float32) / 255.0  # HWC, [0, 1]
    arr = arr.transpose(2, 0, 1)[None, ...]  # NCHW
    arr = (arr - MEAN) / STD

    logits = session.run(None, {"frame": arr.astype(np.float32)})[0]  # (1, 1, 64, 64)
    prob = 1.0 / (1.0 + np.exp(-logits))
    flat = prob[0, 0].flatten()
    peak_idx = int(np.argmax(flat))
    peak_y = peak_idx // 64
    peak_x = peak_idx % 64
    peak_conf = float(flat[peak_idx])

    # Heatmap is 64x64 → input space 256x256 (×4 scale)
    pred_local_x = peak_x * 4 + 2  # +2 to center within 4-px cell
    pred_local_y = peak_y * 4 + 2
    # Map back to full-frame coords
    pred_x = pred_local_x + crop_left
    pred_y = pred_local_y + crop_top

    dist = ((pred_x - cx) ** 2 + (pred_y - cy) ** 2) ** 0.5
    print(f"\n{Path(tf['path']).name}")
    print(f"  GT cursor: ({cx}, {cy})")
    print(f"  Pred:      ({pred_x}, {pred_y}) conf={peak_conf:.3f}")
    print(f"  Dist:      {dist:.1f} px")

# Try with offset crop (simulate hint that's off by 50 px)
print("\n=== Offset crop test (hint 50 px off-target) ===")
tf = TEST_FRAMES[0]
img = Image.open(ROOT / tf["path"]).convert("RGB")
cx, cy = tf["cursor_gt"]
hint_x = cx + 50
hint_y = cy - 30
crop_left = max(0, hint_x - CROP_SIZE // 2)
crop_top = max(0, hint_y - CROP_SIZE // 2)
crop_left = min(crop_left, img.width - CROP_SIZE)
crop_top = min(crop_top, img.height - CROP_SIZE)
img_crop = img.crop((crop_left, crop_top, crop_left + CROP_SIZE, crop_top + CROP_SIZE))
arr = np.array(img_crop, dtype=np.float32) / 255.0
arr = arr.transpose(2, 0, 1)[None, ...]
arr = (arr - MEAN) / STD
logits = session.run(None, {"frame": arr.astype(np.float32)})[0]
prob = 1.0 / (1.0 + np.exp(-logits))
flat = prob[0, 0].flatten()
peak_idx = int(np.argmax(flat))
peak_conf = float(flat[peak_idx])
pred_x = (peak_idx % 64) * 4 + 2 + crop_left
pred_y = (peak_idx // 64) * 4 + 2 + crop_top
dist = ((pred_x - cx) ** 2 + (pred_y - cy) ** 2) ** 0.5
print(f"  hint=({hint_x},{hint_y}) GT=({cx},{cy}) pred=({pred_x},{pred_y}) dist={dist:.1f}px conf={peak_conf:.3f}")
