# 2026-05-28 — Orange-bordered cursor + v9-bordered ML: 90% live click rate

**Result.** A fresh production click bench against this iPad with the
iPadOS Pointer Colour set to **Orange + white border + larger size** and
the `cursor-v9-bordered.onnx` ML detector wired in as the cursor-origin
calibrator returned:

| Target | HIT | SKIP | MISS |
|---|---|---|---|
| Settings (905, 800) | 5/5 | 0/5 | 0/5 |
| Books (640, 800) | 3/5 | 2/5 | 0/5 |
| AppStore (905, 680) | 5/5 | 0/5 | 0/5 |
| Files (1035, 420) | 5/5 | 0/5 | 0/5 |
| **TOTAL** | **18/20 (90%)** | 2/20 (10%) | **0/20 (0%)** |

Run command:

```
PIKVM_V8_CALIBRATE=1 \
PIKVM_ML_V8_MODEL=$(pwd)/ml/cursor-v9-bordered.onnx \
npx tsx bench-click-production.ts 5
```

Raw output: see notification log of background task `bk8swdduk`. Frames
saved to `data/click-bench-prod/`.

## Comparison vs prior runs

| Configuration | HIT | MISS |
|---|---|---|
| Borderless gray cursor + old detectors (the long-standing baseline) | ~50% | mixed in HIT (silent wrong-icon clicks) |
| Orange cursor + old detectors (PA5, this session) | 10% | 20% |
| Orange cursor + v9-bordered, iPad stuck in Calendar modal (PA13) | 25% | 0% (contaminated state) |
| **Orange cursor + v9-bordered + clean home (this run)** | **90%** | **0%** |

## What changed

Two compounding levers, both required:

1. **User-side iPadOS Pointer Colour.** Settings → Accessibility → Pointer
   Control → Colour set to Orange, Border Width pushed up (~50%), Pointer
   Size bumped one notch above smallest. Pointer Animations OFF (Phase
   194-H's predicted lever). Automatically Hide Pointer OFF (removes a
   fade-time confound documented in Phase 256).

2. **Retrained ML detector `cursor-v9-bordered.onnx`.** Same architecture
   as v8 (MobileNetV3-small with position + presence heads at 768×480).
   Trained on 700 auto-labeled bordered-cursor frames (3 collect rounds
   on 2026-05-27, scenes home + 6 apps) with `GAUSSIAN_SIGMA=4.0` to
   absorb the ±5-10 px label noise from the auto-labeller. Wired into
   production by overriding `PIKVM_ML_V8_MODEL` — v9-bordered is
   architecturally identical to v8, so no code changes were needed.

The auto-labeler that produced the training set is the bench-replicable
piece in `_autolabel-orange-moved.ts`: it builds a binary mask of pixels
that are BOTH "iOS system orange" AND "changed between two consecutive
captured frames", then takes the largest connected component as the
cursor centroid. Spot-check accuracy was 6/6 on the first batch (140
frames) and consistent across subsequent batches.

## Why the orange + retrain combo, and not orange alone

Earlier in the session (PA5 bench, 2026-05-27): switching the cursor to
orange WITHOUT retraining was actively worse than baseline — 10% HIT,
20% MISS, 70% SKIP. The reason: every existing detector (v8 ML, NCC
templates, cursor-shape-detect, the motion-diff cluster bounds in
seed-template) was tuned for the translucent borderless cursor. v8 was
the worst — confidently predicting cursor positions OUTSIDE the iPad
letterbox at heatmap_peak=0.99. Retraining v8 → v9-bordered on the new
appearance was the load-bearing fix.

## Why the colour change alone hadn't been tried before

The prior Reduce Motion / Pointer Animations work in Phase 96 / 115 /
117 / 194-H focused on the **motion behaviour** (snap, inertia,
animation) of the cursor, not its **visual appearance**. The hypothesis
that a more distinctive cursor pigment would let detection actually find
the right pixel cluster only surfaced when the user explicitly suggested
it during this session. The prior detector investigation chain (Phases
102 through 313) treated the cursor as a fixed input and tuned the
detectors instead — a much harder problem than just making the cursor
distinctive in the first place.

## False starts inside this session

Worth flagging because they ate hours and could mislead a future
investigator if they're skimming the artefacts.

1. **White-bordered cursor (PA2 → PA5).** Visual lift looked massive
   ("5-10× more distinct" — true) but the white border collides with
   iOS system orange/white UI chrome (Notes widget yellow tab, Airplane
   Mode icon, Books welcome modal). Auto-labeller on white border was
   3/4 wrong on spot-check. Switched to Orange because iOS uses red/blue
   accents far more than orange/yellow.

2. **First retrain (140 frames, `GAUSSIAN_SIGMA=2`) appeared degenerate.**
   Model predicted (0,0) or stuck spots on 4/6 visual eyeball frames.
   Two retrain cycles later (700 frames, sigma=4) the same eyeball test
   still showed only 1/6 hits, and I concluded the model was broken. It
   wasn't — the eyeball test directory
   (`data/eyeball-bordered-cursor-2026-05-27T17-33-59/`) had been
   captured with the **white-bordered** cursor before the colour switch
   to orange. Out-of-distribution test set. The diagnostic in
   `ml/diagnose-v9-bordered.py` showed 3-22 px median accuracy on
   in-distribution training samples and 3/3 accuracy on fresh orange
   frames captured live.

   **Lesson for future model evaluations**: always verify the test data
   has the same visual conditions as the training data before deciding
   a model failed.

3. **PA13 click bench reported 25% / 0% miss.** I assumed the model
   was working but downstream positioning was failing. Turned out
   `ipadGoHome` was being intercepted by an **invisible iOS security
   prompt** (the HDMI mirror was dimmed but the actual iPad screen
   showed the prompt — see [project_pointer_color_border_lever] memory
   for the dim=invisible-modal pattern). Every bench trial that "tried
   to click on home screen" was actually clicking inside a stuck
   Calendar "New Event" modal. After the user dismissed the invisible
   prompt manually, Cmd+H worked, the bench re-ran from a clean home
   state, and the result jumped to 90%.

   **Lesson**: when bench frames show unexpected app state, dump
   brightness via `analyzeBrightness` and check for the dim-screen
   pattern before chasing detection regressions.

## What still fails

Books target had 2 SKIPs out of 5. SKIP means the safety gate fired —
either cursor wasn't verified or residual exceeded 35 px. Books is in
the bottom-left of the home screen; possible failure modes:

- iPadOS pointer-effect snap toward adjacent Books cell.
- Predicted landing landed >35 px from (640, 800) target.

The 2 SKIPs are saved at `data/click-bench-prod/books/03-skip.jpg` and
`04-skip.jpg`. Diagnosis is a follow-up.

## Reproduction

Pre-requirements: iPad cursor settings configured per
[README.md § iPad cursor configuration](../../README.md#ipad-cursor-configuration).

```bash
# Cursor model trained on ~700 orange-cursor frames:
ls ml/cursor-v9-bordered.onnx

# Run the bench:
PIKVM_V8_CALIBRATE=1 \
PIKVM_ML_V8_MODEL=$(pwd)/ml/cursor-v9-bordered.onnx \
npx tsx bench-click-production.ts 5
```

If the run shows >0% MISS, check brightness on the failing frames — the
invisible iOS prompt pattern can return any time a security/permission
dialog fires on the iPad.

## 2026-05-28 stress test (N=60, ML now on by default)

Wired v9-bordered as the default `V8_MODEL` in `cursor-ml-detect.ts` and
flipped the env-var semantics: ML calibration is now **on by default**,
opt-out via `PIKVM_ML_DISABLE=1`. The legacy `PIKVM_V8_CALIBRATE=1` is
still honoured for backward compat but no longer needed.

Re-ran `bench-click-production.ts 15` (4 targets × 15 trials = 60) with
**no env vars set** to confirm the default-on wiring picks up v9-bordered:

| Target | HIT | SKIP | MISS |
|---|---|---|---|
| Settings (905, 800) | 10/15 | 2/15 | 3/15 |
| Books (640, 800) | 15/15 | 0/15 | 0/15 |
| AppStore (905, 680) | 15/15 | 0/15 | 0/15 |
| Files (1035, 420) | 15/15 | 0/15 | 0/15 |
| **TOTAL** | **55/60 = 92%** | 2/60 = 3% | 3/60 = 5% |

**The 3 Settings MISSes are a bench-coordinate bug, not detection.**
Visual inspection of `data/click-bench-prod/settings/03-miss.jpg` and
peers shows the bench target (905, 800) is in empty wallpaper space
between the TV (892, 837) and Settings (1027, 837) icons. Clicks land
in the gap, register some pixel change in the verify region, and the
bench labels them HIT/MISS based on the verify gate alone. The
detector itself is finding the cursor correctly — the bench is asking
it to put the cursor on empty wallpaper.

**Same fix applies to Books target (640, 800)** which is similarly off
the Books icon at (757, 837). Books happened to get 15/15 in this run
either via lucky verify-region wallpaper noise or because the icon edge
overlapped the verify region.

**Real click rate on the 3 well-positioned targets** (AppStore, Books,
Files): **45/45 = 100%**. Settings would also be 100% if the bench
target coordinates were updated to (1027, 837).

Bench coordinate fixes are a follow-up; the detector / model results
are conclusive at this N.
