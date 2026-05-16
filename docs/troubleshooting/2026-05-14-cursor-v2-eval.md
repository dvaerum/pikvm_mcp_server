# 2026-05-14 — cursor-v2 evaluation

## TL;DR

Trained cursor-v2 on the combined 538-frame dataset
(478 original verified + 60 new live-capture labels). v2 looks
better on held-out metrics but is **worse on live frames** — the
new training data biased toward cursor-absent examples and the
model collapsed toward "predict no cursor".

## Held-out val (n=107: 67 pos, 40 neg from combined sources)

| | v0 | v1 | v2 |
| --- | --- | --- | --- |
| median dist | 2.8 | 2.8 | 2.8 |
| det @ 0.5 | 100% | 100% | 98.5% |
| **FP @ 0.5** | **100%** | **22.5%** | **7.5%** |

Note: v1's FP rate looked great (6.45%) on the smaller v0-only
val set, but the new val set adds 9 live-capture negatives that
v1 hallucinates on — those drag v1 up to 22.5%. v2 cuts that to
7.5%.

## Live bench (3 targets × 3 trials, cursor-v2.onnx, n=90 frames)

### Bench outcome (screenChanged)
- Settings 0/3, Books 0/3, Files 0/3 = **0/9 screenChanged**
  - v1 same bench had 2/9. Both unreliable as proxies.

### Exhaustive classification of all 90 captured ML predictions

| Category | v1 (n=60) | v2 (n=90) |
|---|---|---|
| CORRECT (≤30 px from visible cursor) | 30 (50%) | 0 (0%) |
| MODEL_FP (conf ≥ 0.5, no cursor)     | 24 (40%) | 11 (12%) |
| NULL_CORRECT (conf<0.5, no cursor)   | 3 (5%)   | 72 (80%) |
| NULL_WRONG (conf<0.5, cursor visible)| 3 (5%)   | 6 (7%)  |

### Caveat (subagent flagged)

The v2 bench had the cursor visible in only ~7 of 90 frames
(vs v1's 17 of 60). The 80% NULL_CORRECT is mostly the model
being silent on a static screen — not earned discrimination.
Of the ~7 cursor-visible frames, **v2 detected 0 of them above
threshold**.

## Root cause

The 60 new training labels were heavily skewed: **43 negative
(cursor absent) + 17 positive (cursor visible)**. v2 over-
learned "when uncertain → predict absent" and now under-fires
on real cursors.

The combined training set is now 538 frames (271 positive +
267 negative — roughly balanced). But the live-capture
contribution was 72% negative, which pulled the model toward
caution. The model has fewer confident FPs but also no
confident detections live.

## What does NOT need redoing

- Data collection workflow: works. PIKVM_ML_CAPTURE_DIR env
  var produces frame + sidecar pairs in the same schema as
  the training set, ready to label and append.
- Held-out eval framework: works. eval-cursor-v2.py compares
  v0/v1/v2 on a shared val set.

## What to do for v3

1. **Capture more cursor-visible frames.** The 17 positive
   live-captures was too few. Run longer benches where the
   cursor stays visible — maybe disable the cursor-fade
   behavior or use cursor-keepalive to keep it bright.
2. **Better balance.** Target ~50/50 pos/neg in the live
   additions, not 28/72.
3. **Keep cursor-v1 as production.** v2 is worse live —
   `DEFAULT_MODEL` in cursor-ml-detect.ts should stay at
   cursor-v1.onnx until v3 demonstrates real lift.

## Recommended next step

NOT re-running training. The next step is data collection:
get more positive live examples. The retrain itself takes
~10 min once data is in place.

## Files

- ml/train-cursor-v2.py
- ml/eval-cursor-v2.py
- ml/eval-cursor-v2-report.txt
- ml/cursor-v2.{pt,onnx} (kept as backup, NOT default)
- data/ml-live-capture/ (60 frames + verified.jsonl)
- data/ml-live-capture-v2/ (90 frames + sidecars, unlabeled)

