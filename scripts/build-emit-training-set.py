"""Convert consensus-labeled emit-residual frames into the verified.jsonl
format used by the cursor detector trainer.

Inputs:
  - pilot-frames.jsonl + pilot-rater-{A,B,C}.jsonl (batch 1, n=30)
  - emit-pilot-batch2A-frames.jsonl + emit-pilot-batch2A-rater-{A,B,C}.jsonl (n=30)
  - emit-pilot-batch2B-frames.jsonl + emit-pilot-batch2B-rater-{A,B,C}.jsonl (n=30)

For each pair, accept the rater consensus if at least 2/3 raters agree
within 25 px on cursor presence/position. Otherwise drop the sample
(noisy label not worth training on).

Each accepted pair yields TWO training samples (pre + post).

Output: data/cursor-training-v0-emit/verified.jsonl in this format:
  {
    "abs_frame_path": "/abs/path/to/pre.jpg",
    "cursor": {"visible": true, "x": 540, "y": 65},
    "algorithm_label": {"x": 537, "y": 60},
  }
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"
OUT_DIR = DATA / "cursor-training-v0-emit"
AGREE_PX = 25


def load_jsonl(p):
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def visible_xy(label):
    if not isinstance(label, dict):
        return None
    v = label.get("visible")
    if v is True:
        x = label.get("x")
        y = label.get("y")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            return (float(x), float(y))
    return None


def is_clearly_invisible(label):
    """Return True if rater explicitly said cursor not visible."""
    if not isinstance(label, dict):
        return False
    return label.get("visible") is False


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def consensus_label(rater_labels):
    """Given list of 3 rater labels, return:
      - {"visible": True, "x": float, "y": float} if 2+ agree on position
      - {"visible": False} if 2+ agree on not visible
      - None if no consensus
    """
    pts = [visible_xy(l) for l in rater_labels]
    visible_pts = [p for p in pts if p is not None]
    invisible_count = sum(1 for l in rater_labels if is_clearly_invisible(l))

    # 2+ raters agreeing on not visible
    if invisible_count >= 2 and len(visible_pts) <= 1:
        return {"visible": False}

    # 2+ raters agreeing on position
    if len(visible_pts) >= 2:
        # Find any pair that agrees
        for i in range(len(visible_pts)):
            for j in range(i + 1, len(visible_pts)):
                if dist(visible_pts[i], visible_pts[j]) <= AGREE_PX:
                    if len(visible_pts) == 3 and dist(visible_pts[i], visible_pts[j]) <= AGREE_PX:
                        # Average all visible points if 3/3 agree
                        if all(
                            dist(visible_pts[a], visible_pts[b]) <= AGREE_PX
                            for a in range(3) for b in range(a + 1, 3)
                        ):
                            mean_x = sum(p[0] for p in visible_pts) / 3
                            mean_y = sum(p[1] for p in visible_pts) / 3
                            return {"visible": True, "x": int(round(mean_x)), "y": int(round(mean_y))}
                    mean_x = (visible_pts[i][0] + visible_pts[j][0]) / 2
                    mean_y = (visible_pts[i][1] + visible_pts[j][1]) / 2
                    return {"visible": True, "x": int(round(mean_x)), "y": int(round(mean_y))}

    return None


def process_batch(frames_path, raterA_path, raterB_path, raterC_path, pair_key_pre="pre", pair_key_post="post"):
    """Build training rows from one batch.

    The batch1 pilot file uses 'pre' and 'post' keys in rater output;
    same convention used for batch2A/2B. If your batch has different
    structure, adjust pair_key_pre/post.
    """
    frames = {r["pilot_idx"]: r for r in load_jsonl(frames_path)}
    A = {r["pilot_idx"]: r for r in load_jsonl(raterA_path)}
    B = {r["pilot_idx"]: r for r in load_jsonl(raterB_path)}
    C = {r["pilot_idx"]: r for r in load_jsonl(raterC_path)}

    rows = []
    accepted_pairs = 0
    rejected_pairs = 0

    for idx in sorted(frames.keys()):
        f = frames[idx]
        # Detector hint (algorithm_label) for both pre and post
        algo_pre = {
            "x": f.get("_detector_pre_x") or f.get("detector_pre_x"),
            "y": f.get("_detector_pre_y") or f.get("detector_pre_y"),
        }
        algo_post = {
            "x": f.get("_detector_post_x") or f.get("detector_post_x"),
            "y": f.get("_detector_post_y") or f.get("detector_post_y"),
        }

        a, b, c = A.get(idx, {}), B.get(idx, {}), C.get(idx, {})

        # Pre frame
        pre_consensus = consensus_label([
            a.get(pair_key_pre), b.get(pair_key_pre), c.get(pair_key_pre)
        ])
        # Post frame
        post_consensus = consensus_label([
            a.get(pair_key_post), b.get(pair_key_post), c.get(pair_key_post)
        ])

        pre_jpg = f.get("pre_jpg")
        post_jpg = f.get("post_jpg")

        if pre_consensus and pre_jpg and algo_pre["x"] is not None:
            rows.append({
                "abs_frame_path": str((ROOT / pre_jpg).resolve()),
                "cursor": pre_consensus,
                "algorithm_label": algo_pre,
                "_source_batch": frames_path.stem,
                "_source_idx": idx,
                "_role": "pre",
            })
            accepted_pairs += 0.5
        else:
            rejected_pairs += 0.5

        if post_consensus and post_jpg and algo_post["x"] is not None:
            rows.append({
                "abs_frame_path": str((ROOT / post_jpg).resolve()),
                "cursor": post_consensus,
                "algorithm_label": algo_post,
                "_source_batch": frames_path.stem,
                "_source_idx": idx,
                "_role": "post",
            })
            accepted_pairs += 0.5
        else:
            rejected_pairs += 0.5

    return rows, accepted_pairs, rejected_pairs


def main():
    OUT_DIR.mkdir(exist_ok=True, parents=True)
    all_rows = []

    batches = [
        ("pilot-frames.jsonl", "pilot-rater-A.jsonl", "pilot-rater-B.jsonl", "pilot-rater-C.jsonl"),
        ("emit-pilot-batch2A-frames.jsonl", "emit-pilot-batch2A-rater-A.jsonl", "emit-pilot-batch2A-rater-B.jsonl", "emit-pilot-batch2A-rater-C.jsonl"),
        ("emit-pilot-batch2B-frames.jsonl", "emit-pilot-batch2B-rater-A.jsonl", "emit-pilot-batch2B-rater-B.jsonl", "emit-pilot-batch2B-rater-C.jsonl"),
    ]

    for frames_name, A_name, B_name, C_name in batches:
        frames_path = DATA / frames_name
        if not frames_path.exists():
            print(f"  skipping (missing): {frames_name}")
            continue
        rows, accepted, rejected = process_batch(
            frames_path, DATA / A_name, DATA / B_name, DATA / C_name
        )
        all_rows.extend(rows)
        print(f"  {frames_name}: +{int(accepted)} training rows (rejected {int(rejected)})")

    # Stats
    n_visible = sum(1 for r in all_rows if r["cursor"]["visible"])
    n_invisible = sum(1 for r in all_rows if not r["cursor"]["visible"])
    print()
    print(f"=== Total training rows from emit-residuals: {len(all_rows)} ===")
    print(f"  visible: {n_visible}")
    print(f"  not visible: {n_invisible}")

    out_path = OUT_DIR / "verified.jsonl"
    with open(out_path, "w") as f:
        for r in all_rows:
            f.write(json.dumps(r) + "\n")
    print(f"  wrote {out_path}")


if __name__ == "__main__":
    main()
