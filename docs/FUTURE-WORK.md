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

## Git history reclaim (167MB)  [DEFERRED]
The old cursor-v0..v12 model binaries are untracked now but still in .git history (~167MB).
Reclaiming needs a history rewrite (git filter-repo) — invasive (rewrites shared commits).
Only worth it if repo size matters.

## Data & model storage / reproducibility  [IN PROGRESS 2026-07-20]
How to store all created/collected data + trained models so we can (a) fully reproduce/retrain
from scratch AND (b) have models ready-to-go without rerunning the pipeline. See the design being
added to docs/ (data-and-model-storage plan).
