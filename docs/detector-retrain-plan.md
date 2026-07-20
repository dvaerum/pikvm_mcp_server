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

## NEXT MILESTONE (user-endorsed 2026-07-20): SUB-5px precision for SMALL buttons
The north star is not just opening 80px app icons (100% today) but reliably hitting
SMALL targets — e.g. a ~30px "+" add button. Two capabilities, tracked separately:
- (b) CURSOR PRECISION below the ~11px full-frame floor: add a POSITION-REGRESSION
  head to the cascade's 96px crop-verifier (native resolution → arrow-tip to ~2-4px,
  engineering estimate not yet measured). Reuses the crop model already built for the
  cascade — a build-on, not a restart. This is the endorsed next milestone AFTER the
  current robustness milestone (the cascade) is validated. The emit is already sub-5px
  (micro-step+settle, memory ipad_emit_thresholds), so detection is the sole limiter.
- (c) TARGET LOCALISATION (which pixel IS the "+"): screen/UI-element understanding —
  a SEPARATE track (a vision model reading the screenshot), not cursor detection.
Ladder: (a) robust cursor detection on ANY screen [cascade — validating now] → (b)
sub-5px cursor precision [crop-refiner] → (c) precise target localisation. (a) is the
prerequisite for both. Crawl → walk → run.

## RESEARCH-GROUNDED PIVOT (2026-07-20, cycle 16) — crop CLASSIFIER → crop HEATMAP-DETECTOR
User prompt: stop reinventing, check prior art. Two established results resolve the two
tensions cleanly (sources in the git commit / below):
- OFFSET-SENSITIVITY is inherent to a binary patch CLASSIFIER (fires only when centered:
  measured v6 books-cursor 0.68 centered → 0.00 at 24px, scratch/offset-falloff.ts). The
  standard keypoint-localization fix is a translation-equivariant FULLY-CONVOLUTIONAL HEATMAP
  detector (Gaussian target on the tip) decoded by SOFT-ARGMAX/centroid for sub-pixel accuracy
  (arXiv 2407.11668, 2203.02351). A CNN heatmap fires wherever the cursor is in the crop.
- ORANGE-ON-ORANGE is literally CAMOUFLAGED OBJECT DETECTION (target colour≈background); the
  known answer is EDGE/BOUNDARY cues, not colour (arXiv 2501.00426; MDPI appl-sci 14/6/2494).
  Maps onto the cursor's distinctive BLACK OUTLINE (survives orange-on-orange).
UNIFYING FIX (one model, three problems): replace the binary crop-VERIFIER with a small crop
HEATMAP-DETECTOR — Gaussian target on the cursor tip within the 96px crop, soft-argmax decode.
Solves: (1) offset-robustness → the grid works at any stride (fixes the Books-cursor grid miss,
which was OFFSET not rejection — correcting cycle-15's wrong "0.23 rejected", that was a
diag-script resize artifact; production-faithful gate scratch/verifier-gate.ts shows v6 is 8/8
CENTERED, books-cursor 0.68); (2) sub-pixel precision ~2-4px = the small-button/crop-refiner
goal, folded in; (3) confuser rejection = low peak height on icons/nav-arrows/map. Optionally
add an EDGE channel / edge auxiliary loss for the camouflage case instead of a colour prior
(colour prior REFUTED — whipsaws v4↔v6). NEXT: composite-crops.py emit Gaussian-heatmap targets
(zeros for no-cursor negatives) instead of binary labels; train a small FCN (few 3x3 conv
layers, e.g. 16-16-64-64-1) → per-crop heatmap; grid → pick crop with max peak → soft-argmax
tip. Select on the production-faithful TS gate (verifier-gate.ts), not the PIL gate. Then live.

## HONEST STATE (2026-07-20, cycle 15) — cascade is a promising architecture but NOT a
## validated win; two genuine tensions + a preprocessing bug remain. Do NOT ship as default.
The cascade (full-frame proposer OR grid → 96px crop-verifier) fixes MANY cases (icons,
buttons, off-center, nav-arrows, map terrain — all rejected offline) and the grid source
(runCascade rewritten: dense grid over the iPad region + batched verifier + score-weighted
centroid; PIKVM_ML_CASCADE=1, ~230 crops/110ms) fixes the proposer-recall FN that broke the
live bench. BUT unresolved, verified this cycle:
1. **ORANGE-ON-ORANGE tension (the core hard case).** To reject the green/blue Maps-widget
   TERRAIN (cycle 14 FP) I emphasised the cursor's orange colour (removed saturation jitter +
   added map negatives → v6). That REGRESSED the orange-cursor-on-orange-BOOKS-icon case (the
   ORIGINAL v13 false-negative): v6 verifier scores the real Books-cursor **0.23** in
   production (rejected). A colour-emphasis that rejects the map can't separate an orange
   cursor ON an orange icon. Earlier v4 (no colour emphasis) got books-cursor 1.00 but FP'd on
   map terrain. This trade is the crux and is NOT yet solved — likely needs (a) far more
   cursor-ON-orange-icon AND cursor-ON-map positives so the verifier learns the specific
   pointer shape regardless of colour overlap, NOT a global colour prior.
2. **TRAIN-GATE vs PRODUCTION preprocessing MISMATCH (real bug).** The Python selection gate
   (PIL decode) reports books-cursor 0.68 while production (sharp/ONNX) reports 0.23 for the
   SAME crop+model. So model SELECTION optimised a signal that doesn't match production. FIX:
   the verifier's selection gate must use the SAME preprocessing as production (sharp) — e.g.
   a TS gate, or match PIL↔sharp decode. Until then, gate numbers are not trustworthy for
   production.
3. **Precision trade:** grid+centroid detects clean-cursor ~47px off (vs proposer's ~9px).
   Fine for icons, not for the small-button goal — the crop-REFINER (position head) is the fix.
REFUTED / dead-ends (do not retry): global orange-colour prior (breaks orange-on-orange);
proposer-peak-only candidates (recall gap); trusting the Python gate for production selection.
NEXT (future session): fix gate/production preprocessing parity FIRST (so selection is real),
then resolve the colour-vs-shape tension with richer cursor-on-hard-icon positives (not a
colour prior), re-validate offline with the GRID cascade on ALL cases (incl. Books-cursor),
then LIVE. The grid runCascade + v6 are committed but OPT-IN (default path unchanged).

## Progress log
- **2026-07-20 (cycle 14): LIVE BENCH = 94% (75/80) — NOT a win; live testing caught
  a real gap the offline 6/6 missed. The cascade is NOT yet validated live.** Honest
  result (this is the "offline didn't translate" pattern the guardrails warn about):
  trials 1-9 = 72/72 (100%), trial 10 collapsed to 3/8 — a CLUSTER of 5 consecutive
  "cursor not verified" (resid=null) misses. LOOKED at the MISS frame: the cursor was
  clearly VISIBLE on the Maps APP ICON (~1162,570), yet the cascade returned null; once
  stuck there, every subsequent target failed (couldn't re-detect → no move).
  DIAGNOSED precisely (scratch/diag-miss-frame.ts): verifier score AT the cursor =
  1.000 but the PROPOSER (v14) proposed NO peak within 60px of it — the weak proposer's
  RECALL failed, so the good verifier never scored the right crop. Tried a GRID+batched
  verifier to decouple from the proposer (scratch/test-grid-verifier.ts: 234 crops in
  111ms, fast enough) — it FOUND the cursor BUT also exposed a VERIFIER FP: on the 4
  NO-CURSOR home frames a grid crop at (1138,538) scores 0.998-1.00. LOOKED
  (scratch/mapsicon-compare.png): that is the MAPS APP ICON's built-in WHITE NAVIGATION
  ARROW in a blue circle — the verifier keyed on "arrow shape" loosely and fires on the
  icon's own arrow, cursor or not. So my earlier "verifier=1.00 at cursor" was partly
  firing on the icon glyph. Two real defects: (1) proposer recall (misses cursor on the
  Maps icon); (2) verifier FPs on the Maps-icon nav-arrow. TWO-PART FIX (principled, not
  per-screen): (a) add DIRECTIONAL-ARROW negatives to the verifier (nav arrows/compass/
  play-buttons at random orientations+colours, plain triangles w/o the cursor's pointer
  tail) so it learns the cursor's SPECIFIC shape (orange, up-left, tailed) vs any arrow
  — composite-crops.py _arrow_glyph; positives already put the cursor OVER these icons so
  cursor-on-Maps-icon stays positive; added Maps-icon REJECT gate points. (b) switch the
  cascade candidate source from proposer-peaks to a GRID over the iPad region + batched
  verifier (fixes recall). Retraining v5. NEXT: offline test grid+v5 → null on no-cursor
  home (incl. Maps icon) AND detect cursor-on-Maps-icon → wire grid into runCascade →
  RE-RUN the live bench. REFUTED so far: cascade with proposer-peak candidates alone
  (recall gap); loose-arrow verifier (FPs on nav-arrow icons). VALUE: the click bench,
  even though 1-2pp is below its noise floor, DID catch a >10pp-class failure (the
  Maps-icon cluster) — exactly the no-regression role it can play.
- **2026-07-20 (cycle 12-13): cascade 6/6 OFFLINE, wired into production, LIVE bench
  running.** v4 verifier (rich UI-element negatives) → cascade-eval 6/6: no-cursor home
  frames NULL, real cursors detected 1.00 (incl. the Books-icon cursor v13 missed).
  Wired into findCursorByV8FullFrame behind PIKVM_ML_CASCADE=1 (proposer top-K NMS →
  96px verifier per crop → best>thresh else null); env PIKVM_ML_VERIFIER_MODEL /
  _CASCADE_K / _VERIFY_THRESH. PRODUCTION-PATH integration test = 6/6 (matches
  standalone). Canonical ml/crop-verifier.onnx = v4 selected epoch-0 (gate margin
  0.99). Health-check: iPad awake/100%/charging (was in Clock → bench does ipadGoHome;
  region stable 610,58,692,956). curve-mover.ts:93 uses findCursorByV8FullFrame, so
  PIKVM_ML_CASCADE=1 makes the LIVE mover use the cascade. Launched click-bench80-retry3
  with the cascade (proposer cursor-v14-ep05, verifier crop-verifier.onnx).
  ⚠️ STATISTICAL CAVEAT (be critical): the mover is already ~98-99%, so the cascade's
  benefit (fixing the ~1-2% widget-FP misses) is BELOW the ±10pp N=80 noise floor — a
  click bench CANNOT prove a 1-2pp lift. It IS a valid NO-REGRESSION / integration test
  (a broken cascade returning null would drop the rate >10pp, which N=80 detects). The
  SENSITIVE proof of the FP-fix is a getCursor-paired DETECTION-accuracy A/B on the
  failure surface (v13 vs cascade gross-miss rate near widgets/icons) — build + run
  after the click bench (can't run concurrently — both drive the iPad). NEXT: read
  click-bench result (expect ~98-99%, no regression) → run the detection A/B.
- **2026-07-20 (cycle 11): cascade v3 = 5/6 (icon FPs FIXED); last FP = the animated
  Maps-widget orange BUTTON → richer UI-element negatives.** Cascade-eval on v3: the
  books-icon AND books-edge are now rejected (v=0.00), hc15/17/18 return NULL (map
  candidates 0.04-0.07) — the position fix worked. Only hc13 FAILs: a candidate at
  (1130,324) scores v=0.75. Extracted + LOOKED at that 96px crop (scratch/crop-
  compare.png): it's the Maps widget's round ORANGE "food" BUTTON (white fork/knife
  glyph). The verifier rejects rounded-SQUARE icons (0.00) but accepted a round BUTTON
  with a glyph — a UI style my negatives (only rounded-rects) lacked. Intermittent
  because the live map animates (hc13 state has it, hc15/17/18 don't). FIX (general,
  not per-screen): expanded icon_crop to a DIVERSE UI-element mix — rounded rects,
  CIRCLES/buttons, buttons-with-GLYPHS (fork/cross/ring/dot), thin lines (roads) +
  markers, all random position. Verified by eye (scratch/negs-sheet.jpg). Retrain (v4,
  14000 crops). METHOD CHECK (is this whack-a-mole? NO): each fix is a GENERAL shape
  property (not-color, not-position, not-button-style), proven on HELD-OUT frames, and
  the failures shrink each round (map→icon→edge→button; now 5/6). If v4 still leaves a
  rare map-state FP, options: (a) even more map-texture negatives, (b) raise the
  verifier threshold (FP was 0.75 vs real 0.96-1.00 — a 0.85 gate separates), (c) also
  require a min PROPOSER peak (map FP p=0.57 vs real p=1.00). NEXT: cascade-eval v4 →
  6/6 → wire opt-in cascade into findCursorByV8FullFrame → LIVE N=80.
- **2026-07-20 (cycle 10): end-to-end cascade eval found a POSITION spurious-
  correlation in the verifier — fixed.** Ran scratch/cascade-eval.ts (proposer
  v14-ep05 + selected verifier, top-20 NMS peaks/frame → verifier per crop). Result:
  2/6 — the no-cursor home frames FAILED. The verifier CORRECTLY rejected the CENTERED
  Books icon (760,819) at v=0.05, but ACCEPTED a candidate at (690,819) at v=0.96.
  VERIFIED BY EYE (scratch/peak-annotated.jpg): (690,819) is empty blue wallpaper just
  LEFT of the Books icon — the 96px crop there catches the icon's LEFT EDGE (partial,
  off-center orange). ROOT CAUSE: my hard-negative icons were always CENTERED while
  positives had the arrow JITTERED off-center → the verifier learned the spurious rule
  "off-center orange = cursor, centered orange = not" (a POSITION heuristic, not
  shape). So it rejects a centered icon but fires on the icon's edge. FIX (principled):
  icon_crop now draws icons at RANDOM positions incl. partially off the crop edge, so
  an orange blob at ANY offset is a NEGATIVE — the ONLY positive/negative difference is
  the ARROW SHAPE. Verified by eye (scratch/crops-sheet3.jpg: negatives now have
  edge/corner/partial icons; positives arrow-over-icon). Also added (690,819) as a
  REJECT point to the trainer's selection GATE so it can't pick a model that repeats
  the edge FP, and the cascade-eval remains the broad proof. Retraining (v3). NOTE the
  method working here: each cascade-eval exposes a MORE SPECIFIC failure (map→books
  icon→books edge) and the fix gets more targeted — converging, not whack-a-mole,
  because every fix is a general robustness property (shape-not-color, shape-not-
  position), proven on HELD-OUT frames. NEXT: cascade-eval on v3 → must return NULL on
  all no-cursor frames (all icon crops rejected) → wire into findCursorByV8FullFrame
  opt-in → LIVE N=80.
- **2026-07-20 (cycle 9): crop-verifier WORKS in principle (separates the Books icon)
  but OVERFIT — found + fixed the generalization gap.** Verifier run-1 epoch-0 gate
  (held-out real frames): REJECT books-icon=0.30, maps-widget=0.00, ACCEPT
  clean-cursor=0.84, books-cursor=1.00 — the exact separation the single stage could
  NOT do (0.993 vs 0.995). PROOF-OF-CONCEPT that the cascade resolves the ceiling.
  BUT across epochs the real clean-cursor score DROPPED every epoch: 0.84→0.78→0.73→
  0.52→0.04→0.02 (by epoch 5 even books-cursor fell to 0.34). Synthetic val hit 1.0 by
  epoch 1, train-loss 1e-4 = OVERFITTING. DIAGNOSIS (verified by the pattern): the
  clean-cursor is the arrow on SMOOTH blue wallpaper; my crop backgrounds were ALL busy
  (icons/noise/app-crops) → "arrow on smooth bg" was OOD → the overfit model rejected
  it, while books-cursor (busy bg) stayed high. FIXES (both principled): (1) added
  smooth/gradient/near-solid backgrounds to composite-crops.py (smooth_crop, ~25% of
  bgs) — verified by eye (scratch/crops-sheet2.jpg: arrow now shown on green/blue/pink
  smooth fields; smooth negatives too); (2) trainer now SELECTS the checkpoint on the
  real-frame GATE margin (min_accept − max_reject among all-correct epochs) instead of
  the saturated synthetic val, so the overfit late epochs can't win; (3) stronger aug
  (wider jitter + 30% GaussianBlur — the synthetic arrow is crisp, the real HDMI arrow
  is slightly soft) + weight_decay 1e-4→3e-4. Retrain launched (run-2). Built the
  END-TO-END cascade eval (scratch/cascade-eval.ts: proposer top-K NMS peaks →
  verifier per 96px crop → detect best-verified>thresh else NULL) + verifier ONNX
  export. NEXT: pick the best-gate verifier snapshot → export → run cascade-eval on the
  no-cursor home frames (must return NULL — every icon rejected) + cursor frames (must
  detect) → wire into findCursorByV8FullFrame opt-in → LIVE N=80. NOT-YET-VALIDATED:
  the 4-frame gate is promising but not a verdict; the full cascade eval + LIVE are the
  real tests (offline gains have failed to translate before).
- **2026-07-20 (cycle 8): built the CASCADE crop-verifier (data + trainer) and
  launched training.** ml/composite-crops.py emits 96px crops from the SAME sprite +
  data/bg-real + procedural: POSITIVES = arrow composited, crop centered on it with
  ±22px jitter (matches the proposer's 11–27px peak error), often over HARD (orange
  icon / map) backgrounds so the arrow must be found OVER icon textures; NEGATIVES =
  crops with NO arrow incl. procedural warm/colorful rounded-rect "app icons" + real
  app-screenshot crops (full of real icons) + noise — teaching "arrow SHAPE present?"
  not "orange present?". VERIFIED BY EYE (scratch/crops-sheet.jpg): positives show a
  clear arrow incl. over orange icons; negatives are diverse hard orange/colorful
  icon crops with no arrow. Generated 12000 crops (6016 pos/5984 neg, 57MB).
  ml/train-crop-verifier.py = MobileNetV3-small (pretrained) → GAP → Linear(1), binary
  BCE, with a REAL-FRAME GATE reported every epoch (NEVER trained on): REJECT 96px
  crops of the held-out Books icon (760,819) + Maps widget (1110,297); ACCEPT crops of
  the real cursors (clean-cursor 620,432, books 757,846). Training running (bg,
  scratch/verifier-train.log, Monitor armed). The verifier gets what the single stage
  lacked: RESOLUTION (arrow ~40% of a 96px crop). SUCCESS = REJECT crops <0.5 AND
  ACCEPT crops >0.5, esp. rejecting the Books-icon crop it never trained on (proves
  generalization). NEXT: read the gate trajectory → export ONNX → wire the cascade
  (v14-ep05 proposer top-K peaks via NMS → verifier scores each 96px crop → pick
  best-verified above threshold) into findCursorByV8FullFrame as an opt-in →
  offline hold-out (no Books-icon FP + real cursors detected) → LIVE N=80.
- **2026-07-20 (cycle 7): DECISIVE — single-stage full-frame has hit its ceiling;
  pivot to the CASCADE (evidence-backed, verified by eye).** Trained v14 run-2 (14%
  negatives, 50/50 synth-v14). Heatmap CONVERGED beautifully on real cursors: the
  Books frame v13 MISSED (0.0012) is now 11px @ peak 0.992–0.997; clean-cursor on
  wallpaper 9px @ 0.995. BUT the ep05 GATE (scratch/v14-holdout-eval.ts on
  cursor-v14-ep05) exposed the ceiling: on the 4 NO-CURSOR home frames the heatmap
  PEAKS 0.993 at (760,819), and — VERIFIED BY EYE (scratch/peak-annotated.jpg) —
  (760,819) is EXACTLY THE ORANGE BOOKS APP ICON. The map FP is gone (hm@widget
  0.999→0.51) but the FP just RELOCATED from the Maps widget (v13) to the Books icon
  (v14). SAME failure mode (fires on an orange icon), different icon. NO GLOBAL GATE
  SEPARATES: no-cursor home = 0.993 peak, real cursors = 0.995 — presence AND peak
  both overlap. Presence head is also unusable (over-fires at 3.5% neg, under-fires
  0.01–0.04 at 14% neg). ROOT CAUSE (fundamental, not a data bug): at 768×480 input →
  192×120 heatmap the 31×38px arrow shrinks to ~3–4px — indistinguishable by SHAPE
  from a similar-scale orange icon; the model keys on color/blob because it has no
  resolution to see the arrow. On plain wallpaper (no competing orange icon) it's
  perfect (9px). TWO independent single-stage models (v13 @0.999 Maps, v14 @0.993
  Books) failing the SAME way on TWO different orange icons = robust evidence, not a
  noisy sample. CONCLUSION: more single-stage data/epochs won't fix a resolution
  limit → the CASCADE (user's idea) is the right architecture: v14 as PROPOSER (its
  heatmap now makes the real cursor a TOP peak — a strong proposer) → a high-res
  CROP-VERIFIER that sees each candidate at NATIVE resolution, where the arrow is
  large (~40% of an ~96px crop) and its shape IS separable from a book icon.
  REFUTED (do not retry): single-stage full-frame heatmap/presence gating for
  robust cursor-vs-orange-icon separation — ceiling verified twice by eye. NEXT:
  build the crop-verifier training data (reuse ml/cursor-sprite.png + data/bg-real +
  compositor, but emit ~96px CROPS: positives = crop containing the composited arrow;
  negatives = crops of backgrounds incl. orange-icon/map textures with NO arrow),
  train a small crop classifier, wire the cascade (v14 proposer top-K → verifier),
  gate on the same hold-out (must reject the Books-icon crop, accept the cursor
  crop), then LIVE N=80. Single-stage v14 training killed (GPU freed for the
  verifier); cursor-v14-ep05 kept as the proposer.
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
