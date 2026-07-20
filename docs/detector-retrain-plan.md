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
- **2026-07-20 (cycle 6):** trained v14 run-1, ran the ONNX hold-out GATE on the
  epoch-0 checkpoint (production-faithful cubic; scratch/v14-holdout-eval.ts) — the
  single most informative probe so far. RESULTS (evidence):
  - v13 baseline (bug reproduced): all 4 home frames peak **0.999 ON the Maps widget
    (1110,297)**, pres 0.87–0.99; Books frame peaks on the map, **hm@cursor=0.0002 =
    total MISS**. Exactly the documented failure.
  - v14 epoch-0: map FP is SHIFTING — hm@widget **0.999→0.70–0.76**, peak moved
    410–542px OFF the widget; Books hm@cursor **0.0002→0.914** (heatmap now finds the
    cursor on the orange icon = false-negative fixed at the position level).
  TWO PROBLEMS EXPOSED (both now addressed):
  1. SELECTION BUG (verified): synth-val SATURATES at 4px/99.9%/0%fp from epoch 0, so
     strict-< froze cursor-v14.pt at an undertrained epoch 0 (books presence 0.20).
     The metric that matters (presence/peak SEPARATION on REAL cursor vs REAL no-cursor
     screens) is not in synth-val. FIX: save latest every epoch + periodic snapshots
     (cursor-v14-ep{NN}.pt); real selection = the ONNX gate + LIVE N=80 (ungameable).
  2. TWO DISTINCT FP MECHANISMS needing TWO data fixes: (a) the HEATMAP still peaks
     ~0.88–0.92 at a *different* no-cursor home feature (~760,700) — the FP RELOCATED,
     didn't vanish; peak does NOT yet separate no-cursor home (0.92) from the real
     Books cursor (0.96). Heatmap FP is fixed only by cursor-on-hard-bg POSITIVES
     (heatmap loss is presence-masked → negatives give it no gradient). (b) the
     PRESENCE head over-fires: at epoch 2, as it learned to fire on the real cursor
     (books pres 0.24→0.85), home-FP jumped 0/4→3/4. Presence FP is fixed by more
     cursor-free NEGATIVES. ROOT ENABLER: v13's corpora are ~all positives, so
     negatives were only 435/12575 = **3.5%** of training — almost no pressure to ever
     say "no cursor here". FIX: rebalanced synth-v14 to **50/50 at 4000 frames** (1955
     hard positives + 2045 hard negatives, up from 1121/379) → negatives now 2101/15075
     = **14%**, hard positives ~1955. Retrain launched (run-2). NEXT: watch the gate on
     converged run-2 — want peak AND presence to SEPARATE real-cursor from home. If the
     single-stage still can't separate (home features stay cursor-like), that's the
     evidence the CASCADE (crop-verifier) is needed, not more single-stage data.
  NOT-YET-REFUTED, do not over-claim: the map-FP shift is real but the FP relocated to
  another home feature — v14 is NOT proven robust until a converged model separates on
  the gate AND the LIVE N=80 improves (offline shifts have failed to translate before).
- **2026-07-20 (cycle 5):** WROTE + LAUNCHED the v14 training (ml/train-cursor-v14.py).
  DESIGN DECISION (best-practice, memory feedback_decisions_best_practice_long_term):
  v14 = v13's EXACT recipe (same MobileNetV3 net, LR=1e-3, 40 epochs, cosine, same
  synth-val + combined-metric selection, ImageNet-pretrained start) with the ONLY
  change being +synth-v14 as a training source — so any behavior change is
  attributable to the DATA, not a recipe tweak. Trained FROM SCRATCH (not fine-tune
  from v13.pt) deliberately: v13's map→cursor FP is a strongly-learned bias (0.999);
  a fresh fit on [v13 corpora + robustness data] avoids the "fine-tune failed to
  unlearn the bias" risk and is cleaner to reason about. KEY INSIGHT on WHY synth-v14
  fixes the heatmap FP: the heatmap loss is masked by presence (negatives train only
  the presence head), so cursor-free negatives alone would NOT fix the heatmap peak
  on the map. It's the synth-v14 POSITIVES (1121 cursor-on-map/orange/colorful-bg
  frames) that fix it — each shows the model a hard texture with the cursor at ONE
  spot and target-zero everywhere else on that texture, directly teaching "map tile
  → 0 except the real sprite". Data loaded clean: 12575 train (12140 pos/435 neg),
  synth-val 5000, on-icon held-out 34. GENERALIZATION GATE built (clean hold-out,
  NOT used for selection): scratch/v14-holdout-eval.ts runs BOTH v13 & v14 (ONNX,
  production-faithful cubic resize) on (a) HOME-FP = hc13/15/17/18 no-cursor home
  frames — v14 must NOT peak on the Maps widget (~1110,297); (b) BOOKS-POS = the
  exact frame v13 missed (cursor on Books @757,846, v13 hm 0.0012) — v14 must detect
  near it. Also wrote ml/export-v14-onnx.py. Training runs in bg (scratch/v14-train.log,
  Monitor armed). NEXT: when it finishes → export ONNX → run the hold-out gate →
  if home-FP gone AND books detected AND synth-val not regressed → wire v14 into the
  detector → LIVE N=80. If home-FP persists on the best-synth-val epoch: add MORE/
  harder negatives + more cursor-on-hard-bg positives (data fix, NOT epoch-cherry-pick).
- **2026-07-20 (cycle 4):** health OK (went home off the leftover white iPadCollector
  scene; looked — real home screen). CAPTURED 15 REAL cursor-free app-interior
  backgrounds (scratch/capture-bg-real.ts → data/bg-real/): launched each app via
  devicectl WITHOUT moving the mouse (cursor stays faded → cursor-free), screenshot.
  Verified diverse + cursor-free by contact sheet (scratch/bg-sheet.jpg): incl. the
  KEY FP textures — Maps app (full colorful map + orange star + buttons), Clock
  world-map, TV posters, Books covers, App Store/Settings colorful icons. Wired the
  compositor (ml/composite-cursor.py: pick_bg = 60% real + 40% procedural) so these
  real textures are both cursor-FREE negatives ("map ≠ cursor") AND positive
  backgrounds ("cursor over a map is still detectable"). Verified compositing on
  real bgs (scratch/synth-real-sheet.jpg: cursor correctly placed on Books/AppStore/
  Notes UIs). GENERATED 1500-frame set (data/synth-v14: 1121 pos, 379 neg, 172MB).
  NEXT: (1) look at train-cursor-v13.py to write the FINE-TUNE (v13.pt → v14) that
  mixes synth-v14 + existing v13 real-cursor positives (avoid forgetting real
  cursors); (2) export ONNX; (3) OFFLINE eval — v14 must NOT FP on the held-out
  home frames (hc13/15/17/18) AND detect the Books-cursor frame; (4) LIVE N=80.
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
