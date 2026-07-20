#!/usr/bin/env python3
"""
Crop-verifier training data for the CASCADE (docs/detector-retrain-plan.md cycle 7).

The single-stage full-frame detector cannot separate the cursor from orange app
icons — at 192x120 heatmap the arrow is ~3-4px (keys on color, not shape). The
cascade fixes this: a PROPOSER (v14 heatmap) yields top-K candidate locations, and
this VERIFIER looks at a high-res ~96px crop around each candidate and answers "is
there actually a cursor ARROW here?" — where the arrow is ~40% of the crop and its
SHAPE is separable from a book/app icon.

This script emits 96x96 crops (v13-manifest-ish format with a binary `label`):
  POSITIVE (label 1): the exact cursor sprite pasted, crop centered on the arrow
    with jitter (±22px, matching the proposer's ~11-27px peak error) so the
    verifier is robust to the arrow being off-center within the crop.
  NEGATIVE (label 0): a crop of a background with NO arrow — INCLUDING hard,
    icon-like crops (warm/colorful rounded-rect "app icons", map textures, and
    random crops of REAL app screenshots which are full of real icons). This is
    what teaches "orange blob != arrow".

ROBUSTNESS BY DESIGN + hold-out: the current home screen (Books icon, Maps widget)
is NEVER a training background — the verifier must REJECT the held-out Books-icon
crop to prove it generalizes (not memorizes). Backgrounds: data/bg-real (Maps app,
App Store, Settings, ... interiors) + procedural.

Output: data/synth-crops/{frames/*.jpg, manifest.jsonl}.
"""
import glob as _glob
import json
import random
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "synth-crops"
FRAMES = OUT / "frames"
FRAMES.mkdir(parents=True, exist_ok=True)
CROP = 96
SPRITE_CENTER = (90, 90)


def load_sprite():
    im = Image.open(ROOT / "ml" / "cursor-sprite.png").convert("RGBA")
    a = np.array(im).astype(np.int32)
    a[:, :, 3] = np.where(a[:, :, 3] < 55, 0, a[:, :, 3])
    im = Image.fromarray(a.astype(np.uint8), "RGBA")
    ys, xs = np.where(a[:, :, 3] > 10)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    trimmed = im.crop((x0, y0, x1, y1))
    hot = (SPRITE_CENTER[0] - x0, SPRITE_CENTER[1] - y0)
    return trimmed, hot


def rand_color():
    return tuple(random.randint(0, 255) for _ in range(3))


def warm_color():
    return (random.randint(200, 255), random.randint(90, 190), random.randint(0, 80))


_REAL_PATHS = sorted(_glob.glob(str(ROOT / "data" / "bg-real" / "*.jpg")))
_REAL = [np.array(Image.open(p).convert("RGB")) for p in _REAL_PATHS]


def real_crop():
    """Random CROP-sized region of a real app screenshot (full of real icons)."""
    img = _REAL[random.randrange(len(_REAL))]
    h, w = img.shape[:2]
    x = random.randint(0, w - CROP); y = random.randint(0, h - CROP)
    return Image.fromarray(img[y:y + CROP, x:x + CROP]).convert("RGBA")


def icon_crop():
    """Procedural HARD negative: warm/colorful rounded-rect 'app icons' at RANDOM
    positions/sizes — INCLUDING partially off the crop edge. Position is randomized
    (not centered) on purpose: v1 centered the icon, so the verifier learned the
    spurious rule "off-center orange = cursor, centered orange = not" and FP'd on the
    Books-icon EDGE at (690,819) v=0.96 (docs cycle 10). Now an orange blob at ANY
    offset is a NEGATIVE, forcing the verifier to key on the ARROW SHAPE, not the
    icon's position — positives put the arrow over these same off-center icons."""
    base = Image.new("RGBA", (CROP, CROP), rand_color() + (255,))
    d = ImageDraw.Draw(base)
    for _ in range(random.randint(1, 2)):
        sz = random.randint(40, 96)
        cx, cy = random.randint(0, CROP), random.randint(0, CROP)  # center may sit at/over an edge
        x0, y0 = cx - sz // 2, cy - sz // 2
        col = warm_color() if random.random() < 0.55 else rand_color()
        d.rounded_rectangle([x0, y0, x0 + sz, y0 + sz], radius=random.randint(8, 24), fill=col + (255,))
        for _ in range(random.randint(0, 2)):  # inner glyph marks
            gx, gy, r = random.randint(x0, x0 + sz), random.randint(y0, y0 + sz), random.randint(5, 16)
            d.ellipse([gx - r, gy - r, gx + r, gy + r], fill=rand_color() + (255,))
    return base


def noise_crop():
    base = np.random.randint(0, 255, (CROP // 4, CROP // 4, 3), np.uint8)
    return Image.fromarray(np.array(Image.fromarray(base).resize((CROP, CROP)))).convert("RGBA")


def smooth_crop():
    """SMOOTH/plain wallpaper-like crop (gradient or near-solid, any hue incl. the
    blue/dark wallpaper tones). Added because the real cursor lives on plain
    wallpaper too (clean-cursor @620,432); without smooth backgrounds the verifier
    overfit to busy crops and REJECTED the arrow-on-wallpaper (0.04). Robustness by
    design = ANY background, smooth included — not the exact wallpaper (per-screen)."""
    if random.random() < 0.6:
        c0 = np.array(rand_color(), float); c1 = np.array(rand_color(), float)
        t = (np.linspace(0, 1, CROP)[None, :, None] if random.random() < 0.5
             else np.linspace(0, 1, CROP)[:, None, None])
        arr = (c0 * (1 - t) + c1 * t).astype(np.uint8) * np.ones((CROP, CROP, 3), np.uint8)
    else:
        arr = np.ones((CROP, CROP, 3), np.uint8) * np.array(rand_color(), np.uint8)
        arr = np.clip(arr.astype(int) + np.random.randint(-8, 8, (CROP, CROP, 3)), 0, 255).astype(np.uint8)
    return Image.fromarray(arr).convert("RGBA")


def neg_bg():
    r = random.random()
    if r < 0.25:
        return smooth_crop()        # plain/gradient wallpaper-like (no arrow)
    if _REAL and r < 0.55:
        return real_crop()          # real app-icon-laden crops
    if r < 0.85:
        return icon_crop()          # procedural hard orange-icon negatives
    return noise_crop()


def pos_bg():
    # positives get diverse (often hard) backgrounds too, so the arrow must be
    # detected OVER icon/map textures, not just clean fields.
    return neg_bg()


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    random.seed(2); np.random.seed(2)
    sprite, hot = load_sprite()
    print(f"trimmed sprite {sprite.size}, hot-point {hot}")
    rows = []
    for i in range(n):
        positive = random.random() < 0.5
        if positive:
            bg = pos_bg().copy()
            scale = random.uniform(0.85, 1.15)
            sw, sh = int(sprite.width * scale), int(sprite.height * scale)
            spr = sprite.resize((sw, sh))
            hx, hy = int(hot[0] * scale), int(hot[1] * scale)
            # crop is centered on the arrow hot-point + jitter (proposer error)
            jx, jy = random.randint(-22, 22), random.randint(-22, 22)
            # place hot-point at (CROP/2 - jx, CROP/2 - jy) within the crop
            px = CROP // 2 - jx - hx; py = CROP // 2 - jy - hy
            bg.alpha_composite(spr, (px, py))
            label = 1
        else:
            bg = neg_bg().copy()
            label = 0
        fid = f"frames/crop-{i:06d}.jpg"
        bg.convert("RGB").save(OUT / fid, quality=90)
        rows.append({"frame_id": fid, "abs_frame_path": str(OUT / fid), "label": label})
    with open(OUT / "manifest.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    pos = sum(r["label"] for r in rows)
    print(f"wrote {n} crops ({pos} pos / {n - pos} neg) -> {OUT}/manifest.jsonl")


if __name__ == "__main__":
    main()
