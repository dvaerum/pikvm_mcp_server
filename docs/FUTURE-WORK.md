# Future work / backlog

Deferred items — captured so they aren't lost. NOT scheduled. (GitHub issues are disabled
on the repo, so this file is the backlog.)

## Target localization — "tap UI elements by name" (GUI grounding)  [DEFERRED]
The next capability after the (solved) cursor detector + mover: figure out WHICH pixel a named
target is at ("tap Continue", "open Settings", "the + button") so the system acts on names, not
hand-picked coordinates. Vision-only (HDMI black-box; no accessibility tree from other apps).
- Stage 1 (OCR text) = DONE prototype: tools/ocr/ocr.swift (Apple Vision) + scratch/tap-by-text.ts;
  validated live (`tap-by-text "Display & Brightness"` localized + navigated, no coords).
- Stage 1.5 = app-icon label→icon offset (labels ~26px below icon).
- Stage 2 (icon-only: +, search, back) = the fork: OmniParser (robust but AGPL + 300MB + slow),
  vs a small custom detector (needs UI-element labels), vs classical CV+OCR, vs defer.
- First step when resumed: promote Stage 1 into a src/ module + tap-by-text command/nix app.
- Details/research: docs/target-localization-plan.md.

## openLoopShape detector — grey-background locate blind-spot  [OPEN, offline-diagnosable]
The `openLoopShape` fallback detector (`CursorLocator` profile `openLoopShape`, i.e.
`findCursorByMLMultiHint` → `findCursorByShape` dark/bright, exercised live via the
exported `tryOpenLoopShapeDetect`, `src/pikvm/move-to.ts`) under-locates on a solid-grey
scene: **~48% locate overall, 0% in the upper-right region, ~6 px accurate when it does
hit** (measured live on iPad by the @georgs-mac-mini worker, 2026-07-22). Accurate-on-hit
but low recall → a *detection-recall / coordinate-coverage* problem, not an accuracy one.
This is the canonical tracker for the finding (previously only in commit messages + agent
profiles).
- The shape/ML detectors are hint-anchored: shape uses `expectedNear: predicted` +
  `expectedNearRadius: 100`; ML uses `buildMLHints(predicted, …)`. So recall depends on
  both detector coordinate handling AND hint geometry near frame edges.
- The `upper-right` target is `(tight.x + 0.75·tight.w, tight.y + 0.25·tight.h)`
  (`benches/lib/groundtruth.ts` `standardTargets`).
- OFFLINE repro (no iPad): sweep the 180×180 cursor sprite (`ml/cursor-sprite.png`,
  label point = centre (90,90)) composited on a grey-0.55 frame across a position grid and
  run the pure detectors directly — `benches/bench-openloopshape-offline-sweep.ts`. Sweeping
  with a *perfect* hint isolates a genuine detector edge/coordinate blind-spot from an
  upstream hint-geometry cause.
- A fix's final sign-off must be routed to the iPad-equipped node for a ground-truth bench
  (`benches/bench-openloopshape-groundtruth.ts`).

## Git history reclaim (167MB)  [DEFERRED]
The old cursor-v0..v12 model binaries are untracked now but still in .git history (~167MB).
Reclaiming needs a history rewrite (git filter-repo) — invasive (rewrites shared commits).
Only worth it if repo size matters.

## Data & model storage / reproducibility  [IN PROGRESS 2026-07-20]
How to store all created/collected data + trained models so we can (a) fully reproduce/retrain
from scratch AND (b) have models ready-to-go without rerunning the pipeline. See the design being
added to docs/ (data-and-model-storage plan).
