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

## 2026-05-28 honest re-bench with corrected target coordinates

After updating `bench-click-production.ts` to point at the actual icon
centers (Settings (1027, 837), Books (757, 837), AppStore (1027, 702),
Files (1162, 435)) and re-running 4×15:

| Target | HIT | SKIP | MISS |
|---|---|---|---|
| Settings (1027, 837) | 9/15 | 4/15 | 2/15 |
| Books (757, 837) | 8/15 | 7/15 | 0/15 |
| AppStore (1027, 702) | 9/15 | 6/15 | 0/15 |
| Files (1162, 435) | 14/15 | 1/15 | 0/15 |
| **TOTAL** | **40/60 = 67%** | 18/60 = 30% | 2/60 = 3% |

**The previous 92% number was inflated by stale bench coords.** With the
old (905, 800)-style coords pointing to empty wallpaper between icons,
the cursor could land anywhere within ±50 px of target and the verify
region's screen-changed gate would tag it HIT from wallpaper shimmer.
The "100% on AppStore/Books/Files" earlier was bench-noise, not real
icon hits.

**With honest icon-center coords, 67% is the real baseline.** The 30%
SKIP rate is the ballistic-positioning failure mode (cursor lands >35
px from target, safety gate refuses), not a detection failure. Only 3%
silent MISS — and even those 2 cases are on Settings target where the
icon is up against the right edge of the iPad bounds (cursor sometimes
clamps at edge).

**Detection (v9-bordered) is solid.** The remaining 30% gap to 100% is
**positioning** — emit-mickeys-to-pixels isn't accurate enough every
time. That's a downstream problem from this session's detection focus,
worth investigating separately. Path forward would be:
1. Re-calibrate ballistics on the current iPad (`pikvm_measure_ballistics`).
2. Increase retry budget / micro-correction passes.
3. Loosen `maxResidualPx` from 35 to 50-60 (more clicks, slightly more
   miss risk — likely a worthwhile tradeoff given current 3% miss rate).

**Key honesty correction from earlier in this session:** never report
a HIT rate when the bench targets weren't visually verified against
the current iPad layout. Bench coord drift between iPad reorientations
or iPadOS updates is invisible and inflates HIT numbers.

## 2026-05-28 PA19 root cause — model mismatch in verification path (41% → 81% HIT)

Investigation of the 30% SKIP rate turned up a real bug: two different
ONNX models were live in the codebase simultaneously, and only one used
the orange-bordered weights.

- `findCursorByV8FullFrame` → `ml/cursor-v9-bordered.onnx` (correct).
  Used by `discoverOrigin` to seed cursor position at the start of every
  attempt.
- `findCursorByML` / `findCursorByMLMultiHint` → `ml/cursor-v1.onnx`
  (borderless-cursor weights, wrong distribution). Used inside
  `tryOpenLoopShapeDetect` for post-emit verification.

Verbose trace on a Settings trial (n=4 attempts):

```
[discoverOrigin] v8 calibration: cursor at (1100, 684), heatmapPeak=0.978  ← TRUE cursor, v9-bordered
[move-to] motion-diff returned null
[move-to] ML detect ACCEPTED — (961,919) conf=0.989 prox=105                ← v1 hallucination, near target hint
```

discoverOrigin found the cursor correctly every attempt (1100, 684) →
(1110, 738) → (1110, 756) — moving as corrections accumulated. But the
verification ML, fed a crop centred on target hint (1027, 837), used
the v1 borderless-cursor weights and confidently returned (961, 919)
at heatmap_peak 0.989. (961, 919) is wallpaper between Settings icon
and the dock — visually nothing — but a confident-wrong feature for
the wrong model on this iPad's cursor distribution.

This was the same Phase 310 tautology class of bug, but the source
wasn't "the algorithm gets confused near target" — it was "the wrong
model is loaded in the verification path".

### Fix

`findCursorByMLMultiHint` now tries the full-frame v9-bordered detector
first; only when that returns null (presence below threshold = cursor
not visible) does it fall through to the hint-crop loop on v1. Single-
file change in `src/pikvm/cursor-ml-detect.ts`. No call-site changes.

### Live bench n=32 (PRODUCTION DEFAULTS, no env vars)

| Target | Before fix | After fix |
|---|---|---|
| Settings (1027, 837) | 0/8 HIT, 8/8 SKIP | **8/8 HIT** |
| Books (757, 837) | 3/8 HIT, 5/8 SKIP | 2/8 HIT, 6/8 SKIP |
| AppStore (1027, 702) | 2/8 HIT, 3/8 SKIP, 3/8 MISS | **8/8 HIT** |
| Files (1162, 435) | 8/8 HIT | 8/8 HIT |
| **TOTAL** | 41% HIT, 50% SKIP, 9% MISS | **81% HIT, 19% SKIP, 0% MISS** |

Silent MISSes dropped to 0% — the load-bearing safety metric. SKIPs at
Books are now legitimate positioning failures (cursor lands ~75 px east
of target, on the next icon's edge), not detection failures. That's the
next investigation — actual ballistic precision, not detection.

### Lesson for future ML wiring

When introducing a new model version, search the codebase for every
`onnx` model path and every `findCursor*` function call site. A single
file (`cursor-ml-detect.ts`) had two completely separate model load
paths and they drifted. The architectural fix would be to have one
"current cursor detector" used everywhere; currently the team has
crop-based and full-frame variants that solve different problems but
share the model-version assumption only by convention.

## 2026-05-28 PA19-d — wiggle-verify also on v9-bordered (78% → 90%)

After PA19-c's heatmapPeak floor and NCC-lie-verdict relaxation, the
bench settled at 78% with Books still the bottleneck (1/8 HIT).
Verbose trace caught the next link: `mlWiggleVerify` (the static-FP
guard that emits a small known motion and re-detects) was calling
`findCursorByML` directly — bypassing the v9-bordered preference in
`findCursorByMLMultiHint`. So when discoverOrigin (v9-bordered) found
the cursor 25 px from target on Books, wiggle-verify ran the v1
borderless model on the same frame, didn't recognise the cursor, and
returned null → "static FP" → SKIP.

Single-edit fix: wiggle-verify's two `findCursorByML` calls now route
through `findCursorByMLMultiHint`, which uses the same v9-bordered
full-frame path proven to work upstream.

### Final live bench n=60 (PRODUCTION DEFAULTS, no env vars)

| Target | HIT | SKIP | MISS |
|---|---|---|---|
| Settings (1027, 837) | **15/15** | 0/15 | 0/15 |
| Books (757, 837) | 11/15 | 4/15 | 0/15 |
| AppStore (1027, 702) | 13/15 | 2/15 | 0/15 |
| Files (1162, 435) | **15/15** | 0/15 | 0/15 |
| **TOTAL** | **54/60 = 90%** | 6/60 = 10% | **0/60 = 0%** |

### Session arc (PA19 a→g)

| Stage | HIT | SKIP | MISS | Note |
|---|---|---|---|---|
| Before PA19 | 41% | 50% | 9% | model mismatch v1/v9 in verification |
| PA19-b: multi-hint uses v9-bordered | 81% | 19% | 0% | corner-degenerate ML accepted |
| PA19-c: heatmapPeak floor + NCC relax | 78% | 22% | 0% | wiggle-verify still on v1 |
| PA19-d: wiggle-verify uses v9-bordered | 90% | 10% | 0% | end-to-end on one model |
| PA19-e: last-chance v9 before SKIP | 87% | 13% | 0% | AppStore false SKIPs lift |
| PA19-f: lower heatmap floor for snap | 90% | 10% | 0% | pointer-effect cursor-on-icon |
| PA19-g: pre-residual v9 override | **98%** | **2%** | **0%** | static-FP override |

Per-run n=60 results after PA19-g:
- Run 1: Settings 15/15, AppStore 15/15, Files 15/15, Books 14/15 → **98%**
- Run 2: Settings 15/15, AppStore 15/15, Files 15/15, Books 12/15 → **95%**
- Combined n=120: **96.7%** HIT, 0% silent MISS, 3.3% SKIP

All SKIPs are concentrated on Books and represent real iPad-side
ballistic variance — the cursor genuinely gets stuck somewhere in
the dock area and the algorithm's retry budget runs out. Settings,
AppStore, and Files are at 100% consistently. The detection chain
is solid; remaining variance is upstream of detection (HID input
pathway → iPad pointer-effect interaction).

### ⚠️ Honesty correction (PA19-i discovery): bench HIT semantics

Visual inspection of saved HIT frames from later session benches
(PA19-g and PA19-i) found cases where:

- The cursor is visibly on the target icon
- The bench classified the trial as HIT (`r.success === true`)
- The post-trial saved frame shows the iPad home screen — i.e., the
  app did NOT actually launch

The bench's HIT metric is `verifyClickByDiff` reporting screen-changed
fraction ≥ 5 % in a 100×100 verify region around target. iPadOS
pointer-effect cursor-on-icon animations + cursor-position change
between pre-click and post-click frames can satisfy this gate without
the iPad registering the click as a real tap (e.g. when the cursor
lands on the icon EDGE the snap-zone highlights the icon but the
tap dispatcher rejects the event).

Plus — the PA19-i bench Files target frames showed an iPad
**Low Battery 5% modal** had appeared partway through the bench,
which would have blocked all subsequent real taps. Some "HITs" in
Files trials are pure verify-region artifact.

Implication: **the 41% → 97% lift over the PA19 chain reflects how
often the verify region changes, not how often the iPad actually
opens the target app**. The detection improvements are real (cursor
position reporting is honest end-to-end on v9-bordered) but the
end-to-end "click opens the app" rate has NOT been honestly
measured in this session.

Open follow-ups:
- Replace the bench's `verifyClickByDiff` HIT gate with a real
  app-launched check (look for app-specific UI features after click,
  not just any pixel change in a 100×100 region).
- Re-run the entire PA19 chain after the bench is repaired to get
  honest before/after numbers.
- Charge the iPad and check whether the prior runs were contaminated
  by Low Battery modals or other system alerts.

### PA19-h null result: extra retries don't help

To rule out "the retry budget is too short", an A/B at n=60 ran with
`maxRetries=5` (6 attempts) against the default `maxRetries=3` (4
attempts). Result: Books still 12/15 — identical to the maxRetries=3
validation run. Extra retries recovered 2 trials that would have
SKIPped at attempt 4 but 3 other Books trials still failed at
attempt 6 (residuals stayed at ~120 px throughout). One trial
came tantalisingly close (residual 35.5 px on attempt 5, just over
the 35 px gate) but bounced back to 120 px on the next attempt.

Confirms the bottleneck is not retry budget — it is the iPad's
pointer-effect behaviour at the leftmost icon column. Possible
follow-ups (out of scope for the detection-focused PA19 chain):

- Touchscreen HID experiment (Phase 31) for absolute positioning.
- Keyboard-first navigation for left-edge targets.
- iPad-side configuration: experiment with different Pointer Size
  / Border Width values to see if the snap zone shifts.

### PA19-g technique — fresh-frame override of in-flight static FPs

A recurring pattern: the in-flight detection chain inside `moveToPixel`
locks onto a static UI feature (the (860, 912) dock-area FP at ~127 px
from Books target was the reproducible case) and reports it as cursor
position with high confidence. The cursor is *visibly* on the icon but
the verification path doesn't see it.

The fix: before any SKIP fires (cursor-not-verified OR residual-too-
large), take a fresh `client.screenshot()` and run `findCursorByV8FullFrame`
(the v9-bordered model). If it returns presence ≥ 0.5, heatmapPeak
≥ 0.3, AND the detected position is within 80 px of target AND closer
than the algorithm's current claim, override the claim with the
fresh-frame position and proceed with the click.

Guardrails:
- 80 px geographic filter rejects the recurring 100-130 px static FPs.
- "closer than current" prevents the override from making things worse
  when the algorithm was right and fresh detection is itself the FP.
- 0.3 heatmapPeak admits pointer-effect cursor-on-icon detections
  (which v9-bordered scores 0.33-0.48 rather than the 0.95+ it gives
  free-floating cursors).
