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

## Root cause (CONFIRMED offline — reproducible, not a hypothesis)
cursor-v13's training SOURCES (ml/train-cursor-v13.py:49) are all from May 2026
(orange-*, presence-diverse, absent-targeted, synthetic, on-icon) — they do NOT
include the current home screen's widgets, so the model never learned "Maps widget
≠ cursor". CONFIRMED (scratch/v13-fp-check.ts): run on 4 NO-CURSOR current-home
frames (hc13/15/17/18.jpg), cursor-v13 detects a "cursor" at (1110,297) = the MAPS
WIDGET on ALL 4, presence **0.87–0.99**, heatmapPeak **0.999**. Deterministic on
static frames (the live intermittence is just clock/map animation shifting whether
the FP or the real cursor wins). The 0.999 heatmapPeak is WHY the presence gate
failed — the model is extremely confident the map tile is a cursor.
FAST OFFLINE EVAL LOOP now available: a good cursor-v14 must return NULL / low
presence on these no-cursor home frames.

## The fix — ROBUSTNESS BY DESIGN (NOT per-screen). See memory
## feedback_detector_must_generalize_any_screen (user directive, VERY important).
A detector that needs the exact failing screen in its training set is fragile
whack-a-mole — it'll FP on the NEXT novel background. The cursor is a FIXED, KNOWN
sprite (orange arrow); the task is "find THIS sprite against ANY background". So
train it composited onto MAXIMALLY DIVERSE backgrounds so it generalizes.

Training format (v13): full PiKVM frame + `{cursor:{visible,x,y}}`. visible →
gaussian heatmap + presence 1.0; absent → zeros + presence 0.0. MobileNetV3
backbone, heatmap + presence heads.

STRATEGY (robust, screen-agnostic):
- SYNTHETIC COMPOSITING: extract the EXACT cursor sprite (with its alpha/border/
  anti-aliasing) and paste it at known positions onto a huge diversity of
  backgrounds — real iPad app screenshots, maps, photos, textures, widget crops,
  gradients, noise. Label = paste position. This teaches the cursor's INVARIANT
  appearance vs ~infinite backgrounds. (v13 HAD synthetic data but still FPs, so
  this must be done RIGHT: realistic blend, far more/harder background diversity.)
- HARD backgrounds especially: map tiles, clock faces, calendar grids, colorful
  app UIs — the cursor-like-feature sources. As BACKGROUNDS (negatives), not as
  "the current home screen to memorize".
- Keep the model's real-cursor positives (existing corpora) so it still nails the
  real cursor (~11px).

PROVE GENERALIZATION (the key test, not memorization): HOLD OUT the current home
screen's Maps widget entirely from training, then eval — v14 must NOT FP on it. If
it stays clean on a background it never saw, it truly generalized. (If it only
works after adding that widget, that's whack-a-mole and REJECTED.)

APPROACH: fine-tune cursor-v13.pt on [diverse-background synthetic + existing real
positives] → cursor-v14. NOTE: this needs the cursor sprite (extract from a
ground-truth frame) + a background corpus. Bigger than a quick data-collect —
scope it deliberately.

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
  (train-cursor-v13.py, export-v13-onnx.py, manifest format). CONFIRMED root cause
  OFFLINE (v13-fp-check.ts): v13 FPs on the Maps widget (1110,297) in 4/4 no-cursor
  home frames, presence 0.87–0.99, heatmapPeak 0.999 — reproducible, deterministic.
  Fast offline eval loop established. NEXT: build the data-collection harness —
  (a) many current-home NO-CURSOR frames as hard-negatives (vary clock/map state;
  cursor faded/off), (b) current-home cursor-POSITIVE frames via showScene(home)+
  getCursor at known positions incl. over widgets. Then fine-tune v13→v14, verify
  offline (no widget FP + no positive regression), then LIVE N=80 click bench.
