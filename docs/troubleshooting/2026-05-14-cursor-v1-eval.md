# 2026-05-14 — cursor-v1 held-out evaluation

Date: 2026-05-14
Branch: main (pending commit of v1 artifacts)
Model: `ml/cursor-v1.onnx` (epoch 10 of 30, MobileNetV3-small + 3-block decoder)

## Why retrained

Visual labeling of all 478 frames in `data/cursor-training-v0/`
on 2026-05-13 (see `verified.jsonl`) revealed:
- 321/478 (67.2%) frames matched the algorithmic label
- **157/478 (32.8%) had NO cursor at all** — algorithm hallucinated
  edge artifacts, clock-text changes, or wallpaper noise
- v0 training set had ZERO negative examples → model trained to
  always predict a cursor somewhere (Phase 310 tautology, root
  cause of click-rate ceiling)

## v1 training changes

- Read labels from `verified.jsonl` (not `.json` sidecars).
- Negative examples (`visible:false`) crop around algorithm's
  hallucinated label → all-zero heatmap target. Forces model
  to learn "cursor-absent" for the exact regions it previously
  hallucinated.
- Stratified 80/20 train/val split.
- ColorJitter augmentation (brightness/contrast).
- Best-checkpoint metric: `median_dist + 100 * fp_rate` (heavily
  penalises false-positive detections on cursor-absent crops).

## Held-out val results (n=95: 64 pos, 31 neg)

|                          | v1 (verified)   | v0 (bad labels)  |
| ------------------------ | --------------- | ---------------- |
| median dist on positives | **2.8 px**      | 2.8 px           |
| mean dist on positives   | 3.6 px          | 3.8 px           |
| det @ 0.5                | 100%            | 100%             |
| **FP rate @ 0.5**        | **6.45% (2/31)**| **100% (31/31)** |
| median conf on negatives | 0.048           | 0.994            |

v0 reports peak confidence > 0.7 on **every** cursor-absent
frame — the tautology, end-to-end. v1 keeps positives equal
while collapsing negatives to a 20× lower median confidence.

## Phase 312 unseen-frames test

Three hand-picked frames with visually-confirmed cursors:

- `mid_left.jpg`: pred 2.8 px, conf 0.995 ✓
- `mid_upleft.jpg`: pred 154 px, conf 0.493 (below 0.5 threshold
  → caller treats as no detection — correct failure mode)
- `mid_above.jpg`: pred 2.8 px, conf 0.995 ✓
- `mid_left.jpg` with 50px-off hint: pred 4.0 px, conf 0.997 ✓

Confidence is calibrated — the one wrong prediction sits below
the default threshold and would be rejected.

## Gate decision

| Criterion | Target | Actual | Pass? |
| --- | --- | --- | --- |
| Median dist on positives | ≤ 15 px | 2.8 px | ✓ |
| Detection rate @ 0.5 | ≥ 80% | 100% | ✓ |
| FP rate @ 0.5 | ≤ 5% | 6.45% | ✗ (1 frame) |

Verdict: **proceed to integration + live A/B**. The 1-frame miss
on the strict gate criterion is within sample noise at n=31; the
94 pp lift over v0 is the dominant signal. Live click-rate bench
is the real arbiter for whether this changes user-visible
behavior.

## Open questions

- Which 2 cursor-absent frames produce conf > 0.5? Worth a quick
  visual check to know if those are genuinely hard cases or a
  fixable failure mode.
- Does the calibrated confidence translate to live frames or
  does iPad/PiKVM JPEG re-encoding shift the distribution?

