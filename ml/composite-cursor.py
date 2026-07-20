#!/usr/bin/env python3
"""
Diverse-background cursor compositing for the robust cursor-v14 retrain.

Root problem (verified via heatmap): v13 keys on "orange/colorful blob" and map
texture -> false-positives on the Maps widget's orange buttons/terrain (0.999),
and MISSES the real cursor on busy/same-color backgrounds (0.003 on the Books
icon). Fix: paste the EXACT cursor sprite onto MAXIMALLY DIVERSE backgrounds
(incl. hard/colorful/orange/map-like ones) so the model learns the arrow SHAPE
against any background, and generate cursor-FREE hard backgrounds as negatives.

Sprite: ml/cursor-sprite.png (RGBA, extracted via 2-bg matting; the getCursor
label point = the sprite's original center (90,90)).

Backgrounds this pass are PROCEDURAL (unlimited, cursor-free, incl. the failure
triggers). Real cursor-free app/map screenshots get added next cycle. The current
home screen (Maps widget) is HELD OUT — never a training background.

Output: data/synth-v14/frames/*.jpg + manifest.jsonl (v13 format:
{frame_id, abs_frame_path, cursor:{visible,x,y}}). Positives (cursor pasted) +
negatives (cursor-free hard backgrounds, presence 0).
"""
import json, math, random, sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "synth-v14"
FRAMES = OUT / "frames"
FRAMES.mkdir(parents=True, exist_ok=True)
FW, FH = 1920, 1080
SPRITE_CENTER = (90, 90)  # getCursor label point in the 180x180 extracted sprite

def load_sprite():
    im = Image.open(ROOT / "ml" / "cursor-sprite.png").convert("RGBA")
    a = np.array(im).astype(np.int32)
    # Clean matting noise: the 2-bg matting left faint alpha (~10-40) in the
    # margins from JPEG/solid-scene imperfection. Zero alpha below 55 so the
    # sprite is JUST the cursor (its anti-aliased edges are alpha 60-255).
    a[:, :, 3] = np.where(a[:, :, 3] < 55, 0, a[:, :, 3])
    im = Image.fromarray(a.astype(np.uint8), "RGBA")
    ys, xs = np.where(a[:, :, 3] > 10)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    trimmed = im.crop((x0, y0, x1, y1))
    hot = (SPRITE_CENTER[0] - x0, SPRITE_CENTER[1] - y0)  # label point within trimmed sprite
    return trimmed, hot

def rand_color():
    return tuple(random.randint(0, 255) for _ in range(3))

def warm_color():  # orange/amber family — the FP trigger
    return (random.randint(200, 255), random.randint(90, 190), random.randint(0, 80))

def bg_gradient(w, h):
    c0, c1 = np.array(rand_color(), float), np.array(rand_color(), float)
    if random.random() < 0.5:
        t = np.linspace(0, 1, w)[None, :, None]
    else:
        t = np.linspace(0, 1, h)[:, None, None]
    return (c0 * (1 - t) + c1 * t).astype(np.uint8) * np.ones((h, w, 3), np.uint8)

def bg_noise(w, h):
    base = np.random.randint(0, 255, (h // 8, w // 8, 3), np.uint8)
    return np.array(Image.fromarray(base).resize((w, h)))

def bg_checker(w, h):
    c0, c1 = rand_color(), rand_color(); cell = random.randint(20, 120)
    a = np.zeros((h, w, 3), np.uint8)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            a[y:y+cell, x:x+cell] = c0 if ((x//cell + y//cell) % 2 == 0) else c1
    return a

def bg_blobs(w, h):  # colorful UI-button-like blobs, some WARM/orange
    a = np.array(Image.fromarray(np.array(rand_color(), np.uint8)[None, None] * np.ones((h, w, 3), np.uint8)))
    img = Image.fromarray(a); from PIL import ImageDraw; d = ImageDraw.Draw(img)
    for _ in range(random.randint(8, 30)):
        cx, cy, r = random.randint(0, w), random.randint(0, h), random.randint(15, 90)
        col = warm_color() if random.random() < 0.4 else rand_color()
        if random.random() < 0.5:
            d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=col)
        else:
            d.rounded_rectangle([cx-r, cy-r, cx+r, cy+r], radius=r//3, fill=col)
    return np.array(img)

def bg_maplike(w, h):  # green/blue patches + thin road lines (approx the Maps widget)
    from PIL import ImageDraw
    img = Image.fromarray(np.array((random.randint(120,170), random.randint(150,200), random.randint(120,170)), np.uint8)[None,None]*np.ones((h,w,3),np.uint8))
    d = ImageDraw.Draw(img)
    for _ in range(random.randint(3, 8)):  # water/land patches
        x, y, r = random.randint(0, w), random.randint(0, h), random.randint(60, 300)
        d.ellipse([x-r, y-r, x+int(r*1.6), y+r], fill=(random.randint(90,140), random.randint(150,200), random.randint(180,230)))
    for _ in range(random.randint(10, 30)):  # roads
        x0, y0 = random.randint(0, w), random.randint(0, h)
        d.line([x0, y0, x0+random.randint(-300,300), y0+random.randint(-300,300)], fill=(240,240,240), width=random.randint(1,4))
    return np.array(img)

BGS = [bg_gradient, bg_noise, bg_checker, bg_blobs, bg_blobs, bg_maplike, bg_maplike]

import glob as _glob
_REAL_PATHS = sorted(_glob.glob(str(ROOT / "data" / "bg-real" / "*.jpg")))
_REAL = [np.array(Image.open(p).convert("RGB").resize((FW, FH))) for p in _REAL_PATHS]

def pick_bg(w, h):
    # Prefer REAL cursor-free app backgrounds (incl. the Maps/clock/TV textures
    # that actually FP); mix in procedural for extra diversity. This teaches the
    # model that these real textures are NOT the cursor (as negatives) AND that a
    # cursor over them IS still detectable (as positives).
    if _REAL and random.random() < 0.6:
        return _REAL[random.randrange(len(_REAL))].copy()
    return random.choice(BGS)(w, h)

def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    random.seed(1); np.random.seed(1)
    sprite, hot = load_sprite()
    print(f"trimmed sprite {sprite.size}, hot-point {hot}")
    rows = []
    for i in range(n):
        bg = Image.fromarray(pick_bg(FW, FH)).convert("RGBA")
        visible = random.random() < 0.75  # 75% positives, 25% cursor-free negatives
        if visible:
            scale = random.uniform(0.85, 1.15)
            sw, sh = int(sprite.width * scale), int(sprite.height * scale)
            spr = sprite.resize((sw, sh))
            hx, hy = int(hot[0] * scale), int(hot[1] * scale)
            # paste so the hot-point lands at (lx,ly)
            lx = random.randint(30, FW - 30); ly = random.randint(30, FH - 30)
            px, py = lx - hx, ly - hy
            bg.alpha_composite(spr, (px, py))
            cursor = {"visible": True, "x": lx, "y": ly}
        else:
            cursor = {"visible": False}
        fid = f"frames/synth-{i:05d}.jpg"
        bg.convert("RGB").save(OUT / fid, quality=88)
        rows.append({"source": "synth-v14", "frame_id": fid, "abs_frame_path": str(OUT / fid), "cursor": cursor})
    with open(OUT / "manifest.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    vis = sum(1 for r in rows if r["cursor"]["visible"])
    print(f"wrote {n} frames ({vis} positives, {n-vis} negatives) -> {OUT}/manifest.jsonl")

if __name__ == "__main__":
    main()
