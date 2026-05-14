"""
Generate per-frame crops for visual ground-truth labeling.

For each frame in data/cursor-training-v0/, produce two crops:
  1. A 200x200 crop centered on the algorithm's claimed cursor position.
     Saved as: data/cursor-training-v0/_crops/{stem}_crop.jpg
  2. A downsampled 1680x1050 -> 840x525 version of the full frame
     (2x downsample, ~native rendered res). Saved as:
     data/cursor-training-v0/_crops/{stem}_full.jpg

The crop is the primary label aid — at 200x200 native pixels, a
4-5 px cursor is clearly visible (no downsampling).

The full preview lets the human verify "is there ALSO a cursor
elsewhere in the frame that the algorithm missed?"

Run:
  python3 ml/make-crops-for-labeling.py
"""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data" / "cursor-training-v0"
OUT = DATA / "_crops"
OUT.mkdir(exist_ok=True)

CROP_SIZE = 200
HALF = CROP_SIZE // 2

count = 0
for jpg in sorted(DATA.glob("*.jpg")):
    if jpg.parent.name == "_crops":
        continue
    json_path = jpg.with_suffix(".json")
    if not json_path.exists():
        continue
    with open(json_path) as f:
        meta = json.load(f)
    cx = meta["cursor"]["x"]
    cy = meta["cursor"]["y"]
    img = Image.open(jpg)
    W, H = img.size
    left = max(0, min(W - CROP_SIZE, cx - HALF))
    top = max(0, min(H - CROP_SIZE, cy - HALF))
    crop = img.crop((left, top, left + CROP_SIZE, top + CROP_SIZE))
    crop.save(OUT / f"{jpg.stem}_crop.jpg", quality=95)

    full = img.resize((W // 2, H // 2), Image.LANCZOS)
    full.save(OUT / f"{jpg.stem}_full.jpg", quality=85)

    # Record crop origin so labels can map back to frame coords.
    meta["_crop_origin"] = {"left": left, "top": top, "size": CROP_SIZE}
    with open(json_path, "w") as f:
        json.dump(meta, f, indent=2)

    count += 1
    if count % 50 == 0:
        print(f"  processed {count} frames")

print(f"Done: {count} frames cropped → {OUT}")
