# 2026-05-14 — cursor-v1 final write-up

## Bottom line

**It does not work.** Visually verified live click rate on iPad
is 0/14 correct-element-hits with either v0 (old, bad-labels) or
v1 (retrained on verified ground truth) ML detector. The retrain
fixed the held-out tautology metric (94 pp lift) but did not
translate to user-visible click success on the iPad.

## What was done

### Visual labeling (2026-05-13)
- 478 frames in `data/cursor-training-v0/` hand-classified.
- 321/478 (67.2%) match algorithmic label.
- 157/478 (32.8%) had **no cursor at all** — algorithm
  hallucinated on edge artifacts, clock-text changes, wallpaper
  noise. Original training had **zero negative examples**.

### Retrain (`ml/train-cursor-v1.py`, this session)
- Same MobileNetV3-small architecture.
- Reads `verified.jsonl`, includes 157 cursor-absent crops as
  all-zero heatmap targets.
- Stratified 80/20 train/val split, ColorJitter augmentation,
  best-checkpoint metric = `median_dist + 100 * fp_rate`.
- Best saved at epoch 10.

### Held-out evaluation (n=95: 64 pos, 31 neg)

|                          | v1 (verified)   | v0 (bad labels)  |
| ------------------------ | --------------- | ---------------- |
| median dist on positives | 2.8 px          | 2.8 px           |
| det @ 0.5 on positives   | 100%            | 100%             |
| **FP rate @ 0.5**        | **6.45% (2/31)**| **100% (31/31)** |
| median conf on negatives | 0.048           | 0.994            |

The Phase 310 tautology is real: v0 reports peak conf > 0.7 on
**every** cursor-absent val frame. v1 keeps positives equal while
collapsing negatives 20× lower in confidence.

### Live A/B (`bench-ml-v0-vs-v1.ts`, 3 targets × 8 trials each)

By the bench's screenChanged metric:

|          | v0           | v1           | Δ        |
| -------- | ------------ | ------------ | -------- |
| Settings | 3/8 = 38%    | 5/8 = 63%    | +25 pp   |
| Books    | 2/8 = 25%    | 2/8 = 25%    | 0        |
| Files    | 1/8 = 13%    | 1/8 = 13%    | 0        |
| **All**  | **6/24=25%** | **8/24=33%** | **+8 pp**|

### Visual verification of all 14 "HIT" screenshots

**0/14 correct.** All "hits" were one of:
- Home-screen page swipe (5)
- App Library overlay (3)
- Safari "Cannot Connect" (2)
- Messages "Shared with You" dialog (2)
- Notes "Upgrade Notes" dialog (1)
- Calendar app (1)

Neither variant ever opened Settings, Books, or Files on
this bench.

## What this means

1. **The retrain solved the offline problem.** v1 correctly says
   "no cursor here" for cursor-absent crops. That part works.
2. **The live click bottleneck is downstream of detection.** Even
   if the detector were perfect, the bench would still be near
   0% correct hits — clicks are landing somewhere that
   triggers a screen change but never on the intended icon.
3. **screenChanged is a broken metric** for this task. It looks
   meaningful (it's a measurable lift!) but doesn't correlate
   with correct-element-hits.

## What v0 was doing

v0 reports cursor "found" at the search hint with high
confidence (which is exactly the icon being targeted). The click
loop computes residual ≈ 0 and emits the click immediately at
the target coordinate. Cursor is actually elsewhere; click lands
on whatever the *actual* cursor was over.

v1 correctly reports "no cursor here" → click loop retries → may
eventually move cursor near target. But on this iPad/PiKVM
setup, the cursor still doesn't reliably land on icon centers
even with correct detection.

## Recommendation

**Keep v1 as the new default model** (the change is in
`src/pikvm/cursor-ml-detect.ts`, `DEFAULT_MODEL` =
`ml/cursor-v1.onnx`). The held-out improvement is real and
strictly better than v0; it just doesn't fix the
upstream/downstream issues that dominate the live click rate.

**Do not claim a user-visible improvement** from this retrain.
The bench shows ~25-33% screenChanged on icon-sized iPad
targets, but visual inspection puts the real correct-hit rate
at or near 0% under detect-then-move with maxRetries=3.

## Open question

The visually-verified 0% live correct-hit rate on this bench is
notably worse than memory notes referencing ~50-60% in earlier
phases. Possible explanations to investigate next:
1. The bench's `ipadGoHome` (Cmd+H) may be leaving the iPad in
   App Library or page 2 of home, not the home-screen page
   where the target icons live. If targets are off-screen, no
   click coordinate could land on them.
2. The iPad in this session may be in a different state than
   the memory-snapshot reference benches.
3. Phase 310 tautology compounds with belief.position drift to
   produce reliably wrong landings even when detection
   "succeeds."

None of these require a different ML detector. They require
re-verifying basic bench assumptions before any more
detection-side work.
