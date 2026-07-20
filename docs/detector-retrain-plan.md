# Detector retrain plan — kill the home-screen-widget false positives (cursor-v14)

Started 2026-07-20. Goal: fix the last ~1–2% click-miss tail. The emit/movement
model is SOLVED (curve-one-shot, ~98–99%, N=80-validated) — DO NOT touch it.

## The problem (VERIFIED with getCursor ground truth, not hypothesis)
The residual misses are cursor-v13 START-detection FALSE-POSITIVES on home-screen
WIDGETS. Ground truth: in the instrumented bench, V8 reported the cursor at
(1110,297) = the MAPS widget, presence 0.83, while the PRE frame showed the real
cursor on the Books icon (~757,837). The emit was then computed from the wrong
start → cursor sent to the bottom → miss. Both instrumented-bench misses had the
identical FP at the Maps widget. All 4 simple fixes REFUTED: presence gate (FP
presence 0.83→0.983 OVERLAPS real 0.974–1.000), color (map's tan land reads ~25%
orange, fragile), reset-on-retry (regresses to 58%), probe-verify (dead-ends on
persistent FP).

## Root cause (hypothesis, high-confidence, to confirm)
cursor-v13's training SOURCES (ml/train-cursor-v13.py:49) are all from May 2026
(orange-*, presence-diverse, absent-targeted, synthetic, on-icon). They likely do
NOT include the CURRENT home screen with these specific widgets (Maps map tile,
analog clock, calendar, weather). So the model never learned "Maps widget ≠
cursor" → FPs on it at high confidence. CONFIRM by: run cursor-v13 on current
home-screen frames (no cursor) and check it FPs on the widgets.

## The fix — retrain/fine-tune to cursor-v14 with current-home-screen data
Training format (v13): full PiKVM frame + `{cursor:{visible,x,y}}`. visible →
gaussian heatmap + presence 1.0; absent → zeros + presence 0.0. MobileNetV3
backbone, heatmap + presence heads.

DATA to add (the whole point):
- HARD-NEGATIVES: current home-screen frames with NO cursor (cursor faded/absent)
  → presence 0, showing the Maps/clock/calendar/weather widgets as background.
  Collect on the REAL home screen (no getCursor needed for absent frames). Vary
  clock time / map state for robustness.
- POSITIVES: current home-screen frames with the cursor at KNOWN positions (via
  iPadCollector showScene(home-image) + getCursor ground truth, as in the click
  benches), INCLUDING cursor over/near the widgets (teach cursor-over-widget vs
  widget-alone).
Keep a held-out set (never trained on) for eval.

APPROACH options: (A) fine-tune cursor-v13.pt on [new data + a sample of old
positives to avoid forgetting] → cursor-v14 (faster, lower-risk); (B) full retrain
per train-cursor-v13.py with the new sources added. Start with (A).

## Validation (CRITICAL — offline gains must translate to LIVE, like prior fails)
Prior retrains (v2/v3, v12.1) showed OFFLINE lifts that did NOT translate to live
click-rate. So v14 is only real if:
1. OFFLINE: v14 does NOT FP on the widgets (run on current-home no-cursor frames,
   presence must be low) AND does not regress general cursor detection (~11px vs
   getCursor on a held-out positive set).
2. LIVE: the N=80 click bench (scratch/click-bench80.ts, maxRetries=3) improves
   beyond the ±10pp noise floor — specifically the Maps/Settings/Books widget-FP
   misses vanish. Target >99% app-open.
Detector residual is NOT ground truth. No verdicts from small samples.

## Progress log
- **2026-07-20 (cycle 1):** health OK (real home screen). Surveyed ml/ pipeline
  (train-cursor-v13.py, export-v13-onnx.py, manifest format). Root-caused: v13
  training data is all pre-current-home-screen → never learned the widgets as
  negatives. Wrote this plan. NEXT: (1) confirm v13 FPs on current-home no-cursor
  frames (run v13 on a few, check widget presence); (2) build the data-collection
  harness (absent home frames + getCursor-labeled positives on the current home
  screen).
