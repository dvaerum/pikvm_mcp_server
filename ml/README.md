# ML cursor detector

Self-supervised CNN that predicts cursor center in iPad screenshots.
Heatmap regression with MobileNetV3-small backbone.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements.txt
```

## Training

Collect data first via TypeScript:

```bash
npx tsx bench-collect-cursor-data.ts 500
```

Then train:

```bash
python3 ml/train-cursor-v0.py
```

Output:
- `ml/cursor-v0.pt` — PyTorch checkpoint (best validation loss)
- `ml/cursor-v0.onnx` — ONNX export for `onnxruntime-node`

## Architecture

- Input: 256×256 RGB crop, ImageNet-normalized
- Backbone: MobileNetV3-small (ImageNet pre-trained, ~1.5M params)
- Decoder: 3× transpose-conv upsample blocks 8×8 → 16×16 → 32×32 → 64×64
- Head: 1×1 conv → 1-channel logits
- Output: 64×64 heatmap, argmax × 4 = cursor pixel in input space

## Loss

Weighted BCE with logits on Gaussian-blob target (σ=2 px in
heatmap space, so ~8 px in input space). Positive-class weight
scaled by ratio of negative to positive pixels.

## Validation metric

Median Euclidean distance from predicted argmax to ground-truth
heatmap peak, in input-pixel space. Target: median ≤ 10 px.

## Runtime integration (TypeScript)

See `src/pikvm/cursor-ml-detect.ts` (to be created in tick 4).
Loads `ml/cursor-v0.onnx` via `onnxruntime-node`, runs inference on
a 256×256 crop around belief.position, returns
`{x, y, confidence}` or null if max heatmap value < threshold.

## Data format

`data/cursor-training-v0/{ts}_{idx}_{A|B}.jpg` — full 1680×1050
frame from PiKVM.

`data/cursor-training-v0/{ts}_{idx}_{A|B}.json` — sidecar:

```json
{
  "frame_path": "data/cursor-training-v0/...jpg",
  "cursor": { "x": 1151, "y": 777 },
  "confidence": "high" | "medium" | "low",
  "source": "wiggle-diff",
  "timestamp": "ISO",
  "diffStats": {
    "cluster1": { "x": ..., "y": ..., "pixels": ... },
    "cluster2": { "x": ..., "y": ..., "pixels": ... },
    "raw_cluster_count": N
  },
  "emit": { "dx": 20, "dy": 20 },
  "ipad_state": "home"
}
```

## Plan & roadmap

See `docs/troubleshooting/2026-05-13-ml-cursor-detector-plan.md`.
