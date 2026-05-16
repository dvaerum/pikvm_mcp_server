"""
Compute inter-rater agreement on the 60 ml-live-capture frames and
produce consensus.jsonl. For each frame:
- 3/3 agree on visible:true → consensus visible:true, position = median of (x,y)
- 3/3 agree on visible:false → consensus visible:false
- 2/3 agree → consensus = majority, mark agree_count=2
- All disagree → mark AMBIGUOUS (won't happen with only 2 categories,
  but track 1/3 visible scenarios)

Output:
- data/consensus-labels/consensus.jsonl
- agreement statistics to stdout

Then re-run v1 and v3 on the consensus labels.
"""
import json
import statistics
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).parent.parent
LIVE_DIR = ROOT / "data" / "ml-live-capture"
LABELS_DIR = ROOT / "data" / "consensus-labels"
CONSENSUS_PATH = LABELS_DIR / "consensus.jsonl"


def load_rater(name: str) -> dict:
    rows = {}
    with open(LABELS_DIR / f"rater-{name}.jsonl") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            rows[r["frame"]] = r
    return rows


def main():
    raters = {n: load_rater(n) for n in ["A", "B", "C"]}
    frames = sorted(raters["A"].keys())
    assert all(set(raters[n].keys()) == set(frames) for n in raters)
    print(f"Frames: {len(frames)}")

    # Per-frame agreement
    consensus = []
    agreement_counts = Counter()
    rater_match_vs_consensus = {n: 0 for n in raters}
    pos_disagreement = []  # frames where raters agree on visible:true but positions differ

    for frame in frames:
        votes = [raters[n][frame]["visible"] for n in ["A", "B", "C"]]
        n_visible = sum(votes)
        if n_visible == 3:
            xs = [raters[n][frame]["x"] for n in ["A", "B", "C"]]
            ys = [raters[n][frame]["y"] for n in ["A", "B", "C"]]
            cx, cy = int(statistics.median(xs)), int(statistics.median(ys))
            # Position disagreement = max distance between any pair
            max_pair = max(
                ((xs[i] - xs[j])**2 + (ys[i] - ys[j])**2)**0.5
                for i in range(3) for j in range(i+1, 3)
            )
            pos_disagreement.append(max_pair)
            consensus.append({
                "frame": frame, "visible": True,
                "x": cx, "y": cy, "agreement": "3/3", "pos_spread": int(max_pair),
            })
            agreement_counts["3/3 visible"] += 1
        elif n_visible == 0:
            consensus.append({
                "frame": frame, "visible": False, "agreement": "3/3",
            })
            agreement_counts["3/3 absent"] += 1
        elif n_visible == 2:
            # Majority visible, but use the 2 agreeing positions
            agreeing = [n for n in ["A", "B", "C"] if raters[n][frame]["visible"]]
            xs = [raters[n][frame]["x"] for n in agreeing]
            ys = [raters[n][frame]["y"] for n in agreeing]
            cx, cy = int(statistics.median(xs)), int(statistics.median(ys))
            max_pair = ((xs[0] - xs[1])**2 + (ys[0] - ys[1])**2)**0.5
            pos_disagreement.append(max_pair)
            consensus.append({
                "frame": frame, "visible": True,
                "x": cx, "y": cy, "agreement": "2/3", "pos_spread": int(max_pair),
            })
            agreement_counts["2/3 visible"] += 1
        elif n_visible == 1:
            # Majority absent
            consensus.append({
                "frame": frame, "visible": False, "agreement": "2/3",
            })
            agreement_counts["2/3 absent"] += 1

    # Save consensus
    with open(CONSENSUS_PATH, "w") as f:
        for c in consensus:
            f.write(json.dumps(c) + "\n")

    # Per-rater match to consensus
    for n in ["A", "B", "C"]:
        match = 0
        for c in consensus:
            r = raters[n][c["frame"]]
            if r["visible"] == c["visible"]:
                match += 1
        rater_match_vs_consensus[n] = match

    print()
    print("=== Agreement stats ===")
    for k, v in agreement_counts.items():
        print(f"  {k}: {v}")
    full_agreement = agreement_counts["3/3 visible"] + agreement_counts["3/3 absent"]
    partial = agreement_counts["2/3 visible"] + agreement_counts["2/3 absent"]
    print(f"  Full (3/3): {full_agreement}/{len(frames)} = {full_agreement/len(frames):.0%}")
    print(f"  Partial (2/3): {partial}/{len(frames)} = {partial/len(frames):.0%}")
    print()
    print("=== Position spread on visible-consensus frames ===")
    if pos_disagreement:
        print(f"  n={len(pos_disagreement)}")
        print(f"  median spread: {statistics.median(pos_disagreement):.0f}px")
        print(f"  max spread: {max(pos_disagreement):.0f}px")
        print(f"  spread > 30 px (significant): {sum(1 for d in pos_disagreement if d > 30)}")
    print()
    print("=== Per-rater match to consensus ===")
    for n, m in rater_match_vs_consensus.items():
        print(f"  Rater {n}: {m}/{len(frames)} = {m/len(frames):.0%}")
    print()
    print(f"Saved consensus → {CONSENSUS_PATH}")
    return consensus


if __name__ == "__main__":
    consensus = main()

    # Now re-eval v1 and v3 on the consensus labels
    print()
    print("=" * 50)
    print("Re-evaluating v1 and v3 on CONSENSUS labels")
    print("=" * 50)

    CROP_SIZE = 256
    HEATMAP = 64
    SCALE = CROP_SIZE // HEATMAP
    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 3, 1, 1)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 3, 1, 1)

    def crop_at_hint(img, hx, hy):
        W, H = img.size
        left = max(0, min(W - CROP_SIZE, hx - CROP_SIZE // 2))
        top = max(0, min(H - CROP_SIZE, hy - CROP_SIZE // 2))
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

    for model_name, model_file in [("cursor-v1", "cursor-v1.onnx"), ("cursor-v3", "cursor-v3.onnx")]:
        sess = ort.InferenceSession(str(ROOT / "ml" / model_file))
        n_vis = 0
        n_abs = 0
        correct = 0
        close = 0
        wrong = 0
        fp = 0
        null_correct = 0
        null_wrong = 0
        for c in consensus:
            # Load hint from the original sidecar
            sidecar = json.loads(
                (LIVE_DIR / c["frame"].replace(".jpg", ".json")).read_text()
            )
            hint = sidecar["hint"]
            img = Image.open(LIVE_DIR / c["frame"]).convert("RGB")
            crop, left, top = crop_at_hint(img, hint["x"], hint["y"])
            px, py, conf = predict(sess, crop)
            pred_x = px + left
            pred_y = py + top

            if c["visible"]:
                n_vis += 1
                true_x, true_y = c["x"], c["y"]
                dist = ((pred_x - true_x)**2 + (pred_y - true_y)**2)**0.5
                if conf > 0.5:
                    if dist <= 30:
                        correct += 1
                    elif dist <= 100:
                        close += 1
                    else:
                        wrong += 1
                else:
                    null_wrong += 1
            else:
                n_abs += 1
                if conf > 0.5:
                    fp += 1
                else:
                    null_correct += 1

        print()
        print(f"=== {model_name} on consensus (n={len(consensus)}: {n_vis} vis, {n_abs} abs) ===")
        print(f"  Visible (n={n_vis}):")
        print(f"    CORRECT (≤30px, conf>0.5):   {correct} ({correct/n_vis:.0%})")
        print(f"    CLOSE (30-100px, conf>0.5):  {close} ({close/n_vis:.0%})")
        print(f"    WRONG (>100px, conf>0.5):    {wrong} ({wrong/n_vis:.0%})")
        print(f"    NULL_WRONG (conf<=0.5):      {null_wrong} ({null_wrong/n_vis:.0%})")
        print(f"  Absent (n={n_abs}):")
        print(f"    FP (conf>0.5):              {fp} ({fp/n_abs:.0%})")
        print(f"    NULL_CORRECT (conf<=0.5):   {null_correct} ({null_correct/n_abs:.0%})")
