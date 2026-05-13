# ML cursor pointer detector — plan & pre-work

**Date:** 2026-05-13
**Status:** Pre-work. User directed pivot from heuristic detector
to ML-based primary tracker. Heuristic stays as fallback.

## Goal

Replace `cursor-shape-detect.ts` as the primary cursor detector
with a learned model. Heuristic detector stays as fallback when
ML confidence is low or model is unavailable.

Target performance: ≥90% detection within 30 px when cursor is
visible in the frame (vs heuristic's ~60% visually-verified).

## Why ML

The heuristic detector at v0.5.236 has hit diminishing returns:
- 6 layered penalties (sizeFit, asymmetry, chroma, aspect, co-
  linearity, bright-bg, radial-density, minScore)
- Detection-correct on saved-frame replays
- Live click rate stuck at ~10-15% genuine

Failure modes that ML can address:
1. **Cluster merging**: cursor pixels merge with adjacent icon edges
   into 200+ px clusters; heuristic kills by sizeFit. ML can learn
   to localize the cursor center even within a larger cluster.
2. **Pointer-effect snap variant**: light-gray cursor over light
   icon — low contrast, heuristic struggles. ML can learn the
   shape signature regardless of brightness.
3. **iPad-specific cursor rendering**: dotted/filled/snap variants
   — heuristic needs per-variant code paths; ML generalizes.

## Architecture options (research)

**A. CenterNet-style heatmap regression** — RECOMMENDED
- Input: RGB frame (cropped to ROI or downsampled full-frame)
- Output: 1-channel heatmap, peak = cursor center, value =
  confidence
- Training: Gaussian-blob target around cursor pixel, weighted
  BCE/MSE loss
- Inference: argmax + threshold
- Architecture: small CNN backbone + upsampling decoder
- Compact: ~1-5M params
- Pros: handles small objects well, single-class, fast inference
- Cons: needs heatmap-resolution decoder

**B. Patch-based classifier**
- Slide a small window across the frame, classify each window as
  cursor/no-cursor
- Pros: very simple, easy to debug
- Cons: slow inference, many false positives in sliding window

**C. YOLO-tiny / SSD**
- Predict bounding box + class
- Pros: well-studied for object detection
- Cons: overkill for single-class; small-object branch often
  poorly tuned; bbox is overkill (we only need centerpoint)

**D. Transformer-based (DETR, ViT)**
- Pros: SOTA on detection benchmarks
- Cons: data-hungry, slow inference, overkill

**Decision: start with A (CenterNet heatmap).** Smallest viable
model with good small-object performance.

## Model architecture (v0)

```
Input: RGB 256×256 crop (around belief.position; whole-frame if
no hint)

Backbone: MobileNetV3-small (ImageNet pre-trained, ~1.5M params)
  → spatial features at 8×8 (32×downsample)

Decoder: 3× upsample + conv blocks → 64×64 heatmap (4×downsample
  from input)

Head: 1×1 conv → 1 channel (cursor probability)

Output: 64×64 heatmap, argmax × 4 = cursor pixel in input
```

Inference at 256×256: ~10-30 ms on CPU (Apple Silicon). Good.

For full-frame inference (1680×1050): tile into overlapping
256×256 crops, take per-crop heatmap, merge. ~6 crops at 30 ms
= 180 ms. Acceptable but slower.

**Production strategy:** use the belief-position hint to crop a
single 256×256 region around the predicted cursor. Falls back to
heuristic for cursor-absent / hint-far cases.

## Training data — self-supervised labeling

Per cursor wiggle (Phase 187 keepalive pattern):
1. Take frame A (cursor at unknown position P)
2. Emit small displacement Δ (e.g. +20, +20)
3. Take frame B (cursor at P+Δ' where Δ' = Δ × ratio, rate-limited)
4. Compute diff = abs(A - B), threshold
5. The diff has TWO bright regions: cursor at P (vanished) and
   cursor at P+Δ' (appeared). The cluster centroids give us labels
   for BOTH frames.
6. Save (frame_A, P) and (frame_B, P+Δ') as training pairs

Plus negatives:
- Cursor outside frame: capture frame with cursor at clamp edge
  (slam-corner) then return cursor — label = "no cursor visible"
  for some frames where it's hidden by UI

Target dataset size:
- v0: ~500 pairs (small, prove the pipeline works)
- v1: ~5000 pairs (production-ready)
- v2+: 50000+ (with active learning loop)

## Training infrastructure (Python)

Need:
- Python 3.10+, PyTorch 2.0+
- torchvision (MobileNetV3 backbone)
- onnx, onnxruntime (export)
- albumentations (augmentation)

Pre-existing in environment? Need to check. If not, set up via:
- nix shell with python + pytorch (clean, reproducible)
- OR pip install in a venv

## Runtime inference (TypeScript)

Use `onnxruntime-node` (npm package). Already battle-tested.

New file: `src/pikvm/cursor-ml-detect.ts`
- Load ONNX model lazily on first call
- Inference: `findCursorByML(rgb, width, height, hint?)` →
  `{x, y, confidence} | null`
- Confidence threshold ~0.5 (sigmoid)
- Fallback to `findCursorByShape` if confidence below threshold

Bundle model in `data/models/cursor-v0.onnx` (small enough to
commit, <5MB).

## Iterative roadmap

**Tick 1 (this tick):** Pre-work + data collection v0
- Update memory ✓ (in progress)
- Write plan document ✓
- Build `bench-collect-cursor-data.ts` self-supervised harness
- Run small collection (50-100 frames) to validate pipeline
- Commit & push

**Tick 2:** Scale data collection
- Run extended collection (500-1000 frames)
- Inspect collected data visually for label quality
- Filter bad labels (motion-diff noise, cursor invisible)
- Document dataset stats

**Tick 3:** Set up training environment
- Python venv / nix shell with pytorch + onnx
- Implement model architecture
- Train v0 on initial dataset
- Validation hold-out

**Tick 4:** ONNX export + TypeScript integration
- Export trained model
- Implement cursor-ml-detect.ts
- Unit tests on saved frames
- Compare ML vs heuristic on Phase 312 / Phase 308 saved frames

**Tick 5+:** Production integration & iteration
- Wire ML as primary in move-to.ts
- Heuristic as fallback
- Live bench at v0.5.250 (or wherever)
- Active learning: collect frames where ML confidence is low,
  re-label, re-train

## Open research questions

1. **Crop resolution vs full-frame**: 256×256 around hint is fast
   but requires accurate hint. Hint coming from cursor-belief
   may drift. Investigate: tile + merge for full-frame? Or
   accept hint-dependence?

2. **Negative examples**: how to label "no cursor in frame"
   robustly? Currently no clean way to verify cursor is truly
   absent (it could be off-screen, faded, or just hidden by UI).

3. **Cursor variants**: standard arrow, snap (dot), insertion
   beam, hover effects. Need data from each. v0 can focus on
   standard arrow.

4. **Generalization across iPads**: model trained on this
   PiKVM01-iPad may not work on other iPads with different
   wallpapers / iPadOS versions. Re-train per deployment or
   collect cross-iPad data?

## Next concrete action

Build `bench-collect-cursor-data.ts` and start collecting.
