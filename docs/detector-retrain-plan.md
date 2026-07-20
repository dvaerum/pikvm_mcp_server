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

## Heatmap diagnostic (2026-07-20, heatmap-diag.ts) — TWO failure modes, verified
Ran cursor-v13 and read the full heatmap (192×120, sigmoid) at specific locations:
- Frame: cursor REALLY on Books icon (757,846), V8 FP'd on Maps. heatmap @ real
  cursor = **0.0012** (essentially zero — model MISSES it); heatmap @ Maps widget
  = **0.9991**; top-5 peaks ALL on the Maps widget. → double failure.
- Frame: cursor on CLEAN blue wallpaper (620,432, verified by eye). heatmap @ real
  cursor = **0.9993** (detected great); heatmap @ Maps = **0.0001** (no FP).
CONCLUSION (verified, not hypothesis): (1) RECOGNITION/false-negative — the model
detects the cursor brilliantly on clean bg (0.9993) but MISSES it on hard/similar-
color backgrounds like the orange Books icon (0.0012). (2) FALSE-POSITIVE is
INTERMITTENT — the Maps widget scores 0.9991 in one frame, 0.0001 in another,
because the LIVE map content animates; some map states have a cursor-like feature.
This is why live misses are intermittent. BOTH are the same root problem: the model
was trained on too-clean a background distribution → not robust. Fix = diverse-
background compositing (cursor on hard bg as positives + maps/textures as
negatives). "Detection solved ~11px" holds only on clean surfaces.

## Progress log
- **2026-07-20 (cycle 3):** built the compositing pipeline (ml/composite-cursor.py,
  runs on .venv/bin/python which has numpy+torch). Cleaned the sprite alpha
  (matting left faint margin noise → zeroed alpha<55) → trims to a tight 31×38px
  cursor, hot-point (2,8) at the arrow tip. Composites the sprite at random
  pos/scale onto procedural backgrounds (gradient/noise/checker/colorful-blobs-incl-
  orange/map-like) → data/synth-v14/{frames,manifest.jsonl} in v13 format (75%
  positives + 25% cursor-free negatives). VERIFIED (check-synth.ts + contact
  sheet): cursor composites cleanly at the labeled position; v13 detects it at
  4–5px on easy backgrounds (p=1.00) and MISSES it on hard ones = the training
  signal we want. HONEST CONCERN: procedural bg is diverse but ARTIFICIAL, and v13
  already had synthetic data and didn't generalize — so procedural ALONE likely
  won't transfer. NEXT (priority): capture REAL cursor-free backgrounds (Maps app,
  App Store, Photos, Files, Settings interiors — the map/orange-button textures
  that actually FP), composite onto those too; weight the bg mix toward realistic +
  the FP-triggering textures; then combine with existing v13 real-cursor positives
  and fine-tune v13→v14; eval on held-out home frames.
- **2026-07-20 (cycle 2):** corrected strategy to robustness-by-design (user
  directive — memory feedback_detector_must_generalize_any_screen; loop prompt
  updated). Heatmap diag (above): verified TWO failures — FN on hard bg (0.0012 on
  Books) + intermittent map FP (0.999). EXTRACTED the exact cursor sprite via
  2-background alpha matting (extract-cursor-sprite.ts): showScene solid black +
  white, solve alpha/color per px → ml/cursor-sprite.png (180×180 RGBA, cursor
  centered on the getCursor label point, 725 opaque px). Verified clean by eye
  (orange arrow, transparent bg). This is the foundation for compositing. NEXT:
  (1) assemble a DIVERSE background corpus (app screenshots, maps, photos,
  textures, gradients, noise, hard/busy regions); (2) build the compositing script
  (paste sprite at random pos/scale onto random bg → frame + label; the getCursor
  point = sprite center); (3) generate a large synthetic set; (4) fine-tune
  v13→v14 with a HOLD-OUT (Maps widget excluded) to PROVE generalization.
- **2026-07-20 (cycle 1):** health OK (real home screen). Surveyed ml/ pipeline
  (train-cursor-v13.py, export-v13-onnx.py, manifest format). CONFIRMED root cause
  OFFLINE (v13-fp-check.ts): v13 FPs on the Maps widget (1110,297) in 4/4 no-cursor
  home frames, presence 0.87–0.99, heatmapPeak 0.999 — reproducible, deterministic.
  Fast offline eval loop established. NEXT: build the data-collection harness —
  (a) many current-home NO-CURSOR frames as hard-negatives (vary clock/map state;
  cursor faded/off), (b) current-home cursor-POSITIVE frames via showScene(home)+
  getCursor at known positions incl. over widgets. Then fine-tune v13→v14, verify
  offline (no widget FP + no positive regression), then LIVE N=80 click bench.
