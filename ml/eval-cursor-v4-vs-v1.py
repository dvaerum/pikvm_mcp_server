"""Compare cursor-v4 against cursor-v1 on consensus-labeled emit-residual frames.

Loads BOTH models, runs them on every consensus-clean sample, and reports
per-model:
  - position error vs visual ground truth (median, p25, p75, max)
  - FP rate on cursor-absent frames (peak confidence > 0.5)
  - detection rate on cursor-present frames

This is the audit that v1 should never have passed but did because it
was evaluated on training-distribution frames only.
"""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image
import math

ROOT = Path(__file__).parent.parent
EMIT_LABELS = ROOT / "data" / "cursor-training-v0-emit" / "verified.jsonl"
V1_ONNX = ROOT / "ml" / "cursor-v1.onnx"
V4_ONNX = ROOT / "ml" / "cursor-v4.onnx"

CROP_SIZE = 256
HEATMAP_SIZE = 64
HEATMAP_SCALE = CROP_SIZE / HEATMAP_SIZE  # = 4

NORM_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
NORM_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def load_labels():
    rows = []
    with open(EMIT_LABELS) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def preprocess(img, cx, cy):
    """Crop CROP_SIZE around (cx,cy), return tensor + crop offset."""
    W, H = img.size
    crop_left = max(0, cx - CROP_SIZE // 2)
    crop_top = max(0, cy - CROP_SIZE // 2)
    crop_left = min(crop_left, W - CROP_SIZE)
    crop_top = min(crop_top, H - CROP_SIZE)
    crop = img.crop((crop_left, crop_top, crop_left + CROP_SIZE, crop_top + CROP_SIZE))
    arr = np.array(crop, dtype=np.float32) / 255.0  # HWC
    arr = (arr - NORM_MEAN) / NORM_STD
    arr = arr.transpose(2, 0, 1)  # CHW
    arr = arr[np.newaxis, ...]  # NCHW
    return arr.astype(np.float32), crop_left, crop_top


def decode_peak(heatmap_logits):
    """heatmap_logits shape: (1, 1, 64, 64). Return (x_frame, y_frame, peak_conf)."""
    probs = 1.0 / (1.0 + np.exp(-heatmap_logits))
    flat = probs.reshape(-1)
    idx = int(flat.argmax())
    y = idx // HEATMAP_SIZE
    x = idx % HEATMAP_SIZE
    peak = float(flat[idx])
    return x * HEATMAP_SCALE, y * HEATMAP_SCALE, peak


def main():
    if not V4_ONNX.exists():
        print(f"V4 not found at {V4_ONNX}; training not complete?")
        return
    print(f"Loading models...")
    sess_v1 = ort.InferenceSession(str(V1_ONNX), providers=["CPUExecutionProvider"])
    sess_v4 = ort.InferenceSession(str(V4_ONNX), providers=["CPUExecutionProvider"])

    rows = load_labels()
    print(f"Loaded {len(rows)} consensus-labeled emit-residual samples")

    v1_pos_errs = []
    v4_pos_errs = []
    v1_neg_peaks = []
    v4_neg_peaks = []
    v1_pos_peaks = []
    v4_pos_peaks = []

    # Track per-sample comparisons
    samples = []

    for row in rows:
        img_path = row["abs_frame_path"]
        algo = row["algorithm_label"]
        truth = row["cursor"]
        try:
            img = Image.open(img_path).convert("RGB")
        except Exception as e:
            print(f"  skip (missing): {img_path}")
            continue

        # Crop around algorithm_label (same convention as training)
        algo_cx, algo_cy = algo["x"], algo["y"]
        tensor, crop_left, crop_top = preprocess(img, algo_cx, algo_cy)

        out_v1 = sess_v1.run(None, {"frame": tensor})[0]
        out_v4 = sess_v4.run(None, {"frame": tensor})[0]

        v1_x_local, v1_y_local, v1_peak = decode_peak(out_v1)
        v4_x_local, v4_y_local, v4_peak = decode_peak(out_v4)

        v1_x = crop_left + v1_x_local
        v1_y = crop_top + v1_y_local
        v4_x = crop_left + v4_x_local
        v4_y = crop_top + v4_y_local

        if truth["visible"]:
            tx, ty = truth["x"], truth["y"]
            # Only count if cursor is within the crop (training contract)
            if 0 <= tx - crop_left < CROP_SIZE and 0 <= ty - crop_top < CROP_SIZE:
                v1_err = math.hypot(v1_x - tx, v1_y - ty)
                v4_err = math.hypot(v4_x - tx, v4_y - ty)
                v1_pos_errs.append(v1_err)
                v4_pos_errs.append(v4_err)
                v1_pos_peaks.append(v1_peak)
                v4_pos_peaks.append(v4_peak)
                samples.append({
                    "abs_frame_path": img_path,
                    "truth": [tx, ty],
                    "v1": [v1_x, v1_y, v1_peak, v1_err],
                    "v4": [v4_x, v4_y, v4_peak, v4_err],
                    "kind": "positive",
                })
        else:
            v1_neg_peaks.append(v1_peak)
            v4_neg_peaks.append(v4_peak)
            samples.append({
                "abs_frame_path": img_path,
                "truth": None,
                "v1": [v1_x, v1_y, v1_peak, None],
                "v4": [v4_x, v4_y, v4_peak, None],
                "kind": "negative",
            })

    def summary(name, errs, peaks_pos, peaks_neg):
        n = len(errs)
        if n:
            errs_sorted = sorted(errs)
            print(f"  {name} positive errors (n={n}):")
            print(f"    median={errs_sorted[n//2]:.1f}px  p75={errs_sorted[(3*n)//4]:.1f}px  max={errs_sorted[-1]:.1f}px")
            print(f"    mean={sum(errs)/n:.1f}px")
            print(f"    under 25px: {sum(1 for e in errs if e < 25)/n*100:.0f}%")
            print(f"    under 50px: {sum(1 for e in errs if e < 50)/n*100:.0f}%")
        if peaks_pos:
            det = sum(1 for p in peaks_pos if p > 0.5) / len(peaks_pos)
            print(f"  {name} detection rate (peak>0.5) on positives: {det*100:.0f}%")
        if peaks_neg:
            fp = sum(1 for p in peaks_neg if p > 0.5) / len(peaks_neg)
            print(f"  {name} FP rate (peak>0.5) on negatives: {fp*100:.0f}%")

    print()
    print("=== v1 ===")
    summary("v1", v1_pos_errs, v1_pos_peaks, v1_neg_peaks)
    print()
    print("=== v4 ===")
    summary("v4", v4_pos_errs, v4_pos_peaks, v4_neg_peaks)

    # Save full report
    out = ROOT / "data" / "cursor-v4-vs-v1-report.json"
    with open(out, "w") as f:
        json.dump({
            "n": len(samples),
            "v1": {
                "pos_errs": v1_pos_errs,
                "neg_peaks": v1_neg_peaks,
                "pos_peaks": v1_pos_peaks,
            },
            "v4": {
                "pos_errs": v4_pos_errs,
                "neg_peaks": v4_neg_peaks,
                "pos_peaks": v4_pos_peaks,
            },
            "samples": samples,
        }, f, indent=2)
    print(f"\nReport: {out}")


if __name__ == "__main__":
    main()
