"""Compare 3 raters against verified.jsonl labels used to train cursor-v1.

For each pilot frame:
- consensus visible: did 3 raters mostly agree the cursor is visible?
- consensus position: where do they say it is?
- verified visible: what does verified.jsonl say?
- verified position: where does verified.jsonl say?
- agreement: do they match?
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"

AGREE_PX = 25


def load_jsonl(p):
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


def is_visible(label):
    """Return True if rater said visible, False if not, 'unsure' otherwise."""
    if not isinstance(label, dict):
        return "unsure"
    v = label.get("visible")
    if v is True:
        return True
    if v is False:
        return False
    return "unsure"


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def main():
    A = {r["pilot_idx"]: r for r in load_jsonl(DATA / "detector-pilot-rater-A.jsonl")}
    B = {r["pilot_idx"]: r for r in load_jsonl(DATA / "detector-pilot-rater-B.jsonl")}
    C = {r["pilot_idx"]: r for r in load_jsonl(DATA / "detector-pilot-rater-C.jsonl")}
    pilot = {r["pilot_idx"]: r for r in load_jsonl(DATA / "detector-pilot-frames.jsonl")}

    # Stats
    visibility_match_3of3 = 0     # all 3 raters AND verified agree
    visibility_match_2of3 = 0      # 2/3 raters agree with verified
    visibility_disagree = 0
    visibility_mixed = 0           # raters split

    pos_close = 0   # raters agree pos within ~AGREE_PX of verified position
    pos_far = 0     # raters and verified disagree on position by > 50 px
    pos_no_consensus = 0
    pos_disagrees_with_verified = 0

    disagreements = []

    for idx in sorted(pilot.keys()):
        p = pilot[idx]
        verified_visible = p["_verified_visible"]
        verified_x = p["_verified_x"]
        verified_y = p["_verified_y"]

        a, b, c = A.get(idx, {}), B.get(idx, {}), C.get(idx, {})
        rv = [is_visible(a), is_visible(b), is_visible(c)]
        n_true = sum(1 for v in rv if v is True)
        n_false = sum(1 for v in rv if v is False)
        n_unsure = sum(1 for v in rv if v == "unsure")

        if n_true >= 2:
            consensus_visible = True
        elif n_false >= 2:
            consensus_visible = False
        else:
            consensus_visible = "split"

        # Visibility match
        if consensus_visible == "split":
            visibility_mixed += 1
            vis_status = "rater_split"
        elif consensus_visible == verified_visible:
            if n_true == 3 or n_false == 3:
                visibility_match_3of3 += 1
                vis_status = "match_3of3"
            else:
                visibility_match_2of3 += 1
                vis_status = "match_2of3"
        else:
            visibility_disagree += 1
            vis_status = "DISAGREE"

        # Position check (only when consensus says visible)
        pos_status = "n/a"
        delta_to_verified = None
        consensus_pos = None
        if consensus_visible is True:
            pts = [p2 for p2 in [visible_xy(a), visible_xy(b), visible_xy(c)] if p2]
            if len(pts) >= 2:
                # Check raters agree among themselves
                rater_agree_pairs = 0
                if dist(pts[0], pts[1]) <= AGREE_PX: rater_agree_pairs += 1
                if len(pts) == 3:
                    if dist(pts[0], pts[2]) <= AGREE_PX: rater_agree_pairs += 1
                    if dist(pts[1], pts[2]) <= AGREE_PX: rater_agree_pairs += 1
                if rater_agree_pairs >= 1:
                    consensus_pos = (
                        sum(p2[0] for p2 in pts) / len(pts),
                        sum(p2[1] for p2 in pts) / len(pts),
                    )
                    if verified_visible and verified_x is not None and verified_y is not None:
                        delta_to_verified = dist(consensus_pos, (verified_x, verified_y))
                        if delta_to_verified < 25:
                            pos_close += 1
                            pos_status = f"close ({delta_to_verified:.0f}px)"
                        elif delta_to_verified < 50:
                            pos_close += 1
                            pos_status = f"med ({delta_to_verified:.0f}px)"
                        else:
                            pos_far += 1
                            pos_status = f"FAR ({delta_to_verified:.0f}px)"
                    else:
                        pos_disagrees_with_verified += 1
                        pos_status = "verified_invisible_but_raters_see_cursor"
                else:
                    pos_no_consensus += 1
                    pos_status = "rater_pos_disagree"
            else:
                pos_no_consensus += 1
                pos_status = "lt_2_raters_with_pos"

        if vis_status == "DISAGREE" or (pos_status not in ("n/a",) and "FAR" in pos_status) or "verified_invisible" in pos_status:
            disagreements.append({
                "pilot_idx": idx,
                "frame": p["frame"],
                "vis": vis_status,
                "pos": pos_status,
                "verified_visible": verified_visible,
                "verified_pos": [verified_x, verified_y] if verified_visible else None,
                "consensus_visible": consensus_visible,
                "consensus_pos": list(consensus_pos) if consensus_pos else None,
                "rater_visible": rv,
                "verified_notes": p.get("_verified_notes", ""),
            })

    n = len(pilot)
    print(f"=== Visibility agreement (n={n}) ===")
    print(f"  match (3/3 + verified):    {visibility_match_3of3}")
    print(f"  match (2/3 + verified):    {visibility_match_2of3}")
    print(f"  raters disagree w/ each other: {visibility_mixed}")
    print(f"  raters DISAGREE w/ verified:   {visibility_disagree}")
    print(f"  total match rate:          {(visibility_match_3of3 + visibility_match_2of3)/n*100:.0f}%")
    print()
    print(f"=== Position agreement (n_visible_consensus={pos_close+pos_far+pos_no_consensus+pos_disagrees_with_verified}) ===")
    print(f"  close (<50px to verified): {pos_close}")
    print(f"  FAR (>=50px to verified):  {pos_far}")
    print(f"  rater pos disagree:        {pos_no_consensus}")
    print(f"  verified invisible/null but raters see cursor: {pos_disagrees_with_verified}")
    print()

    if disagreements:
        print(f"=== {len(disagreements)} disagreement cases ===")
        for d in disagreements:
            print(f"  idx={d['pilot_idx']:2d}  vis={d['vis']:<12}  pos={d['pos']}")
            print(f"    frame: {d['frame']}")
            print(f"    verified: visible={d['verified_visible']} pos={d['verified_pos']}")
            print(f"    consensus: visible={d['consensus_visible']} pos={d['consensus_pos']}")
            print(f"    raters: {d['rater_visible']}")
            if d['verified_notes']:
                print(f"    verified_notes: {d['verified_notes']}")
            print()

    # Write full report
    (DATA / "detector-audit-report.json").write_text(json.dumps({
        "n": n,
        "visibility": {
            "match_3of3": visibility_match_3of3,
            "match_2of3": visibility_match_2of3,
            "mixed": visibility_mixed,
            "disagree": visibility_disagree,
        },
        "position": {
            "close": pos_close,
            "far": pos_far,
            "no_consensus": pos_no_consensus,
            "verified_invisible_but_raters_see": pos_disagrees_with_verified,
        },
        "disagreements": disagreements,
    }, indent=2))
    print(f"Full report: data/detector-audit-report.json")


if __name__ == "__main__":
    main()
