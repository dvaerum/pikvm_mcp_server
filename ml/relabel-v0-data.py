"""
Re-derive cursor labels in data/cursor-training-v0/ using emit-
projection direction. The TypeScript harness used X-only comparison
to determine before/after which mislabels Y-axis rate-limited cases.

For each pair (A, B) with same iteration index:
  emit_dir = normalize(emit.dx, emit.dy)
  c1, c2 = diffStats.cluster1, diffStats.cluster2
  projection_2to1 = (c1.x - c2.x) * emit_dir.x + (c1.y - c2.y) * emit_dir.y
  If projection > 0 → c1 is AFTER, c2 is BEFORE
  Else            → c1 is BEFORE, c2 is AFTER

Update the .json sidecar in-place with corrected cursor xy.

Run:
  python3 ml/relabel-v0-data.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data" / "cursor-training-v0"

if not DATA_DIR.is_dir():
    print(f"No data dir: {DATA_DIR}")
    sys.exit(1)

# Group files by iteration index (the part between timestamp and _A/_B)
pairs = {}
for json_path in sorted(DATA_DIR.glob("*.json")):
    if json_path.name == "index.json":
        continue
    name = json_path.stem  # e.g. 2026-05-13_05-34-08_0042_A
    if name.endswith("_A"):
        key = name[:-2]
        pairs.setdefault(key, {})["A"] = json_path
    elif name.endswith("_B"):
        key = name[:-2]
        pairs.setdefault(key, {})["B"] = json_path

fixed = 0
unchanged = 0
problem = 0
for key, ab in pairs.items():
    if "A" not in ab or "B" not in ab:
        problem += 1
        continue
    with open(ab["A"]) as f:
        a = json.load(f)
    with open(ab["B"]) as f:
        b = json.load(f)

    emit = a["emit"]
    mag = (emit["dx"] ** 2 + emit["dy"] ** 2) ** 0.5
    if mag < 1e-6:
        problem += 1
        continue
    edx, edy = emit["dx"] / mag, emit["dy"] / mag

    c1 = a["diffStats"]["cluster1"]
    c2 = a["diffStats"]["cluster2"]
    if not c1 or not c2:
        problem += 1
        continue

    # Projection of (c2 - c1) onto emit direction:
    proj = (c2["x"] - c1["x"]) * edx + (c2["y"] - c1["y"]) * edy
    # proj > 0 → c2 in emit direction from c1 → c2 is AFTER (post-emit)
    if proj > 0:
        before, after = c1, c2
    else:
        before, after = c2, c1

    a_should = {"x": before["x"], "y": before["y"]}
    b_should = {"x": after["x"], "y": after["y"]}

    a_changed = a["cursor"]["x"] != a_should["x"] or a["cursor"]["y"] != a_should["y"]
    b_changed = b["cursor"]["x"] != b_should["x"] or b["cursor"]["y"] != b_should["y"]

    if abs(proj) < 5:
        # Ambiguous projection → mark low-confidence
        if a.get("confidence") != "low":
            a["confidence"] = "low"
            b["confidence"] = "low"
            a_changed = b_changed = True
            fixed += 1
            continue
    if a_changed or b_changed:
        a["cursor"] = a_should
        b["cursor"] = b_should
        a["source"] = "wiggle-diff-relabeled-by-projection"
        b["source"] = "wiggle-diff-relabeled-by-projection"
        with open(ab["A"], "w") as f:
            json.dump(a, f, indent=2)
        with open(ab["B"], "w") as f:
            json.dump(b, f, indent=2)
        fixed += 1
    else:
        unchanged += 1

print(f"Pairs processed: {len(pairs)}")
print(f"Fixed (relabeled or marked low-conf): {fixed}")
print(f"Unchanged: {unchanged}")
print(f"Problems (missing pair / bad data): {problem}")
