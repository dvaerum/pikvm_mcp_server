"""Compare 3 rater outputs against detector for the pilot frames.

Output: data/pilot-consensus-report.json with per-frame consensus
status, agreement metrics, and detector-vs-consensus delta.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"

AGREE_PX = 25  # raters agree if within this distance


def load_jsonl(p):
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def visible_xy(label):
    """Return (x, y) if rater says visible at a specific point, else None."""
    if not isinstance(label, dict):
        return None
    v = label.get("visible")
    if v is True:
        x = label.get("x")
        y = label.get("y")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            return (float(x), float(y))
    return None


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def consensus(points):
    """Given list of (x,y) or None, return consensus position if
    at least 2 raters agree (within AGREE_PX), preferring 3/3.
    Returns (x, y, agreement_count) or (None, None, count_of_visible).
    """
    visible = [p for p in points if p is not None]
    n_visible = len(visible)
    # Try all-three agreement first
    if n_visible == 3:
        if all(dist(visible[i], visible[j]) <= AGREE_PX for i in range(3) for j in range(i+1,3)):
            mean = (
                sum(p[0] for p in visible) / 3,
                sum(p[1] for p in visible) / 3,
            )
            return mean, 3
    # Try 2/3 agreement
    if n_visible >= 2:
        for i in range(len(visible)):
            for j in range(i+1, len(visible)):
                if dist(visible[i], visible[j]) <= AGREE_PX:
                    mean = (
                        (visible[i][0] + visible[j][0]) / 2,
                        (visible[i][1] + visible[j][1]) / 2,
                    )
                    return mean, 2
    return None, n_visible


def main():
    A = {r["pilot_idx"]: r for r in load_jsonl(DATA / "pilot-rater-A.jsonl")}
    B = {r["pilot_idx"]: r for r in load_jsonl(DATA / "pilot-rater-B.jsonl")}
    C = {r["pilot_idx"]: r for r in load_jsonl(DATA / "pilot-rater-C.jsonl")}
    pilot = {r["pilot_idx"]: r for r in load_jsonl(DATA / "pilot-frames.jsonl")}

    out = []
    # Stats
    pre_3of3 = 0
    pre_2of3 = 0
    pre_no_consensus = 0
    pre_all_invisible = 0
    post_3of3 = 0
    post_2of3 = 0
    post_no_consensus = 0
    post_all_invisible = 0

    # Detector-vs-consensus deltas (only on samples where BOTH pre and post have 3/3 or 2/3 consensus)
    deltas = []

    for idx in sorted(pilot.keys()):
        p = pilot[idx]
        a, b, c = A.get(idx, {}), B.get(idx, {}), C.get(idx, {})

        pre_pts = [visible_xy(a.get("pre")), visible_xy(b.get("pre")), visible_xy(c.get("pre"))]
        post_pts = [visible_xy(a.get("pre")), visible_xy(b.get("post")), visible_xy(c.get("post"))]
        # Fix: post should use 'post' not 'pre' from rater a
        post_pts = [visible_xy(a.get("post")), visible_xy(b.get("post")), visible_xy(c.get("post"))]

        pre_cons, pre_agree = consensus(pre_pts)
        post_cons, post_agree = consensus(post_pts)

        # Pre stats
        if pre_cons is not None and pre_agree == 3:
            pre_3of3 += 1
        elif pre_cons is not None and pre_agree == 2:
            pre_2of3 += 1
        elif pre_agree == 0:
            pre_all_invisible += 1
        else:
            pre_no_consensus += 1

        # Post stats
        if post_cons is not None and post_agree == 3:
            post_3of3 += 1
        elif post_cons is not None and post_agree == 2:
            post_2of3 += 1
        elif post_agree == 0:
            post_all_invisible += 1
        else:
            post_no_consensus += 1

        # Detector labels
        det_pre = (p["detector_pre_x"], p["detector_pre_y"]) if p.get("detector_pre_x") is not None else None
        det_post = (p["detector_post_x"], p["detector_post_y"]) if p.get("detector_post_x") is not None else None
        det_dx = p.get("detector_observed_dx")
        det_dy = p.get("detector_observed_dy")

        sample = {
            "pilot_idx": idx,
            "pre_jpg": p["pre_jpg"],
            "post_jpg": p["post_jpg"],
            "emit": p["emit"],
            "consensus_pre": list(pre_cons) if pre_cons else None,
            "consensus_pre_agreement": pre_agree,
            "consensus_post": list(post_cons) if post_cons else None,
            "consensus_post_agreement": post_agree,
            "detector_pre": list(det_pre) if det_pre else None,
            "detector_post": list(det_post) if det_post else None,
            "detector_observed_dx": det_dx,
            "detector_observed_dy": det_dy,
            "rater_A_pre": a.get("pre"),
            "rater_A_post": a.get("post"),
            "rater_B_pre": b.get("pre"),
            "rater_B_post": b.get("post"),
            "rater_C_pre": c.get("pre"),
            "rater_C_post": c.get("post"),
        }

        # Per-frame deltas
        if pre_cons and det_pre:
            sample["pre_detector_consensus_delta"] = dist(pre_cons, det_pre)
        if post_cons and det_post:
            sample["post_detector_consensus_delta"] = dist(post_cons, det_post)

        # Observed displacement delta (the thing we'd train on)
        if pre_cons and post_cons and det_dx is not None and det_dy is not None:
            cons_dx = post_cons[0] - pre_cons[0]
            cons_dy = post_cons[1] - pre_cons[1]
            displacement_delta = math.hypot(cons_dx - det_dx, cons_dy - det_dy)
            sample["consensus_dx"] = cons_dx
            sample["consensus_dy"] = cons_dy
            sample["displacement_delta_px"] = displacement_delta
            deltas.append({
                "pilot_idx": idx,
                "delta_px": displacement_delta,
                "pre_agree": pre_agree,
                "post_agree": post_agree,
                "magnitude": p.get("magnitude"),
            })

        out.append(sample)

    report = {
        "agree_threshold_px": AGREE_PX,
        "n_samples": len(out),
        "pre_stats": {
            "3of3_agreement": pre_3of3,
            "2of3_agreement": pre_2of3,
            "no_consensus": pre_no_consensus,
            "all_invisible": pre_all_invisible,
        },
        "post_stats": {
            "3of3_agreement": post_3of3,
            "2of3_agreement": post_2of3,
            "no_consensus": post_no_consensus,
            "all_invisible": post_all_invisible,
        },
        "samples_with_displacement_delta": len(deltas),
        "displacement_delta_summary": None,
        "samples": out,
    }

    if deltas:
        sorted_deltas = sorted(d["delta_px"] for d in deltas)
        n = len(sorted_deltas)
        report["displacement_delta_summary"] = {
            "n": n,
            "min": sorted_deltas[0],
            "p25": sorted_deltas[n // 4],
            "median": sorted_deltas[n // 2],
            "p75": sorted_deltas[(3 * n) // 4],
            "max": sorted_deltas[-1],
            "fraction_under_20px": sum(1 for d in sorted_deltas if d < 20) / n,
            "fraction_under_50px": sum(1 for d in sorted_deltas if d < 50) / n,
            "fraction_over_50px": sum(1 for d in sorted_deltas if d >= 50) / n,
            "fraction_over_100px": sum(1 for d in sorted_deltas if d >= 100) / n,
        }

    out_path = DATA / "pilot-consensus-report.json"
    out_path.write_text(json.dumps(report, indent=2))

    print(f"Wrote {out_path}")
    print()
    print(f"=== PRE (n={len(out)}) ===")
    print(f"  3/3 agreement: {pre_3of3}")
    print(f"  2/3 agreement: {pre_2of3}")
    print(f"  no consensus:  {pre_no_consensus}")
    print(f"  all invisible: {pre_all_invisible}")
    print()
    print(f"=== POST (n={len(out)}) ===")
    print(f"  3/3 agreement: {post_3of3}")
    print(f"  2/3 agreement: {post_2of3}")
    print(f"  no consensus:  {post_no_consensus}")
    print(f"  all invisible: {post_all_invisible}")
    print()
    if deltas:
        s = report["displacement_delta_summary"]
        print(f"=== DETECTOR vs CONSENSUS DISPLACEMENT DELTA (n={s['n']}) ===")
        print(f"  min:    {s['min']:.1f} px")
        print(f"  p25:    {s['p25']:.1f} px")
        print(f"  median: {s['median']:.1f} px")
        print(f"  p75:    {s['p75']:.1f} px")
        print(f"  max:    {s['max']:.1f} px")
        print(f"  fraction < 20 px:   {s['fraction_under_20px']*100:.0f}%")
        print(f"  fraction < 50 px:   {s['fraction_under_50px']*100:.0f}%")
        print(f"  fraction >= 50 px:  {s['fraction_over_50px']*100:.0f}%")
        print(f"  fraction >= 100 px: {s['fraction_over_100px']*100:.0f}%")


if __name__ == "__main__":
    main()
