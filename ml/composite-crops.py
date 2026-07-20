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


def _arrow_glyph(d, cx, cy, sz, col):
    """A DIRECTIONAL arrow/triangle NOT matching the cursor sprite — nav arrows
    (Maps' white-up-arrow-in-blue-circle), compass arrows, play buttons. The live
    bench FP'd on the Maps APP ICON's nav arrow (docs cycle 14): the verifier keyed
    on 'arrow shape' loosely. These teach it the cursor is a SPECIFIC pointer
    (orange, up-left, tailed), not any arrow. Random direction (incl. up/down/right
    and up-RIGHT — deliberately spanning orientations away from the sprite) + a plain
    triangle shape (no pointer tail), so the real cursor sprite stays distinct."""
    import math as _m
    ang = random.uniform(0, 2 * _m.pi)
    h = sz * random.uniform(0.3, 0.5)
    w = h * random.uniform(0.5, 0.9)
    # tip + two base corners of a plain isosceles triangle, rotated by ang
    def rot(px, py):
        return (cx + px * _m.cos(ang) - py * _m.sin(ang), cy + px * _m.sin(ang) + py * _m.cos(ang))
    pts = [rot(h / 2, 0), rot(-h / 2, -w / 2), rot(-h / 2, w / 2)]
    d.polygon(pts, fill=col)


def _glyph(d, x0, y0, sz):
    """A light symbol on a button (fork/lines/cross/dot/ARROW) — like the Maps
    widget's white-on-orange buttons AND the Maps app icon's nav arrow the verifier
    FP'd on."""
    g = (random.randint(220, 255),) * 3
    k = random.random()
    cx, cy = x0 + sz // 2, y0 + sz // 2
    if k < 0.3:  # vertical bars (fork-ish)
        for j in range(random.randint(2, 4)):
            gx = x0 + sz // 4 + j * sz // 8
            d.line([gx, y0 + sz // 4, gx, y0 + 3 * sz // 4], fill=g, width=max(2, sz // 20))
    elif k < 0.5:  # cross / plus
        d.line([cx, y0 + sz // 5, cx, y0 + 4 * sz // 5], fill=g, width=max(2, sz // 16))
        d.line([x0 + sz // 5, cy, x0 + 4 * sz // 5, cy], fill=g, width=max(2, sz // 16))
    elif k < 0.65:  # ring
        r = sz // 4
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=g, width=max(2, sz // 20))
    elif k < 0.8:  # dot
        r = sz // 6
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=g)
    else:  # nav ARROW (Maps-icon style) — white or coloured directional triangle
        _arrow_glyph(d, cx, cy, sz, g if random.random() < 0.6 else rand_color())


def icon_crop():
    """Procedural HARD negatives: a DIVERSE mix of UI elements at RANDOM positions/
    sizes (incl. partially off the crop edge) with NO arrow. Diversity matters —
    v2 had only rounded-RECTS so the verifier FP'd 0.75 on a round ORANGE BUTTON with
    a white fork glyph (Maps widget, docs cycle 11). Now: rounded rects, CIRCLES/
    buttons, buttons-with-GLYPHS, thin lines (roads/map), and markers — so the
    verifier must key on the ARROW SHAPE, not 'a coloured UI element'. Random position
    (not centered) keeps it shape-not-position (cycle 10)."""
    base = Image.new("RGBA", (CROP, CROP), rand_color() + (255,))
    d = ImageDraw.Draw(base)
    for _ in range(random.randint(1, 3)):
        sz = random.randint(30, 96)
        cx, cy = random.randint(0, CROP), random.randint(0, CROP)
        x0, y0 = cx - sz // 2, cy - sz // 2
        col = warm_color() if random.random() < 0.5 else rand_color()
        kind = random.random()
        if kind < 0.4:  # rounded-rect app icon
            d.rounded_rectangle([x0, y0, x0 + sz, y0 + sz], radius=random.randint(6, 24), fill=col + (255,))
            if random.random() < 0.4:
                _glyph(d, x0, y0, sz)
        elif kind < 0.75:  # circular button (+ often a glyph)
            d.ellipse([x0, y0, x0 + sz, y0 + sz], fill=col + (255,))
            if random.random() < 0.6:
                _glyph(d, x0, y0, sz)
        else:  # thin lines (roads/map) + markers
            for _ in range(random.randint(2, 6)):
                a = (random.randint(0, CROP), random.randint(0, CROP))
                b = (a[0] + random.randint(-CROP, CROP), a[1] + random.randint(-CROP, CROP))
                d.line([a, b], fill=(random.randint(180, 255),) * 3, width=random.randint(1, 4))
            mx, my, r = random.randint(0, CROP), random.randint(0, CROP), random.randint(4, 12)
            d.ellipse([mx - r, my - r, mx + r, my + r], fill=warm_color() + (255,))
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


def map_crop():
    """MAP-TERRAIN negative: green/teal land + blue water blobs + thin roads — the
    live Maps-widget content the verifier FP'd 0.99 on (docs cycle 14, a green/blue
    water shape read as cursor-like). The animated map is a real background class;
    the cursor is ORANGE and never green/blue, so this + reduced colour-jitter lets
    the verifier reject map terrain by colour AND shape."""
    land = (random.randint(90, 150), random.randint(150, 200), random.randint(120, 170))
    a = np.ones((CROP, CROP, 3), np.uint8) * np.array(land, np.uint8)
    img = Image.fromarray(a); d = ImageDraw.Draw(img)
    for _ in range(random.randint(1, 4)):  # water bodies (blue, irregular)
        x, y, r = random.randint(0, CROP), random.randint(0, CROP), random.randint(20, 70)
        d.ellipse([x - r, y - r, x + int(r * random.uniform(0.5, 1.5)), y + r],
                  fill=(random.randint(40, 110), random.randint(90, 150), random.randint(150, 210)))
    for _ in range(random.randint(3, 10)):  # roads
        x0, y0 = random.randint(0, CROP), random.randint(0, CROP)
        d.line([x0, y0, x0 + random.randint(-CROP, CROP), y0 + random.randint(-CROP, CROP)],
               fill=(random.randint(210, 245),) * 3, width=random.randint(1, 3))
    return img.convert("RGBA")


def neg_bg():
    r = random.random()
    if r < 0.22:
        return smooth_crop()        # plain/gradient wallpaper-like (no arrow)
    if r < 0.40:
        return map_crop()           # map terrain (green/blue land+water+roads)
    if _REAL and r < 0.62:
        return real_crop()          # real app-icon-laden crops (incl. the Maps app)
    if r < 0.85:
        return icon_crop()          # procedural hard orange-icon/button/arrow negatives
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
            # Tip (hot-point) lands ANYWHERE in the crop — wide jitter (±38, tip in
            # ~[10,86] of 96) so the HEATMAP detector learns to localise the cursor
            # off-center too (translation-equivariant → the grid works at any stride;
            # a binary classifier trained only near-center collapsed off-center 0.68→0).
            tx = random.randint(10, CROP - 10)
            ty = random.randint(10, CROP - 10)
            px = tx - hx; py = ty - hy
            bg.alpha_composite(spr, (px, py))
            # label kept for the legacy binary trainer; cursor = tip target for the heatmap.
            row = {"frame_id": f"frames/crop-{i:06d}.jpg", "label": 1,
                   "cursor": {"visible": True, "x": tx, "y": ty}}
        else:
            bg = neg_bg().copy()
            row = {"frame_id": f"frames/crop-{i:06d}.jpg", "label": 0, "cursor": {"visible": False}}
        bg.convert("RGB").save(OUT / row["frame_id"], quality=90)
        row["abs_frame_path"] = str(OUT / row["frame_id"])
        rows.append(row)
    with open(OUT / "manifest.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    pos = sum(r["label"] for r in rows)
    print(f"wrote {n} crops ({pos} pos / {n - pos} neg, heatmap-tip targets) -> {OUT}/manifest.jsonl")


if __name__ == "__main__":
    main()
