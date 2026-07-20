# Target localization plan — "which pixel is the X?" (GUI grounding)

> **STATUS: DEFERRED (future work — not active).** Backlog: docs/FUTURE-WORK.md.
> Stage 1 (OCR text) is a working prototype; Stage 2 is an open fork. Resume when chosen.

Started 2026-07-20. NEW capability, separate from the (solved) cursor DETECTOR and MOVER.
Goal: given a screenshot + a target ("the + button", "Continue", "Settings"), output the
pixel to click — so the system can act on named targets without a human picking coordinates.

## Constraints (why this is vision-only)
We control the iPad BLACK-BOX via HDMI (video) + USB (HID) only. iOS sandboxes the
accessibility tree — an app (iPadCollector) can read only ITS OWN elements, not other apps'
(that needs an assistive-service entitlement we don't have). So localization MUST work from
the HDMI screenshot, like the rest of the system.

## Prior art (researched 2026-07-20)
GUI grounding = "instruction → click coordinate", an active field. Two families:
- COORDINATE-PREDICTION VLMs — UGround (arXiv 2410.05243, 10M elements/1.3M screenshots),
  UI-TARS (2509.21552), GUI-Actor (2506.03143, coordinate-free attention head), Phi-Ground
  (2507.23779). End-to-end but LARGE VLMs (GPU/API), and they STRUGGLE on high-res complex
  layouts (ScreenSpot-Pro) — a real risk at our 1920×1080.
- ELEMENT-PARSE + MATCH — OmniParser-style: detect ALL clickable boxes (icons + text), then
  match the instruction to one.
Best-practice for THIS project (self-contained, robust-by-design, no giant black-box model):
mirror the detector's crawl→walk→run.

## Staged plan
- STAGE 1 (crawl) — OCR TEXT localization. A huge fraction of targets are text buttons/rows
  (Continue, Get, Don't Allow, Allow, menu rows). OCR the screenshot → fuzzy-match the query
  → click the text box centre. Robust, tiny, immediately useful.
- STAGE 2 (walk) — ICON/element detection for icon-only targets (+, search, back). An element
  detector (OmniParser-style YOLO, or a small trained one) + match.
- STAGE 3 (run) — full grounding for arbitrary phrasing (a grounding VLM or parse+VLM-match).

## Stage 2 assessment (2026-07-20) — icon-only targets; the real fork
Stage 1 (OCR text) covers the MAJORITY of real targets (text buttons/rows/links/menu items)
robustly. The gap is (a) ICON-ONLY elements with no text (+, search, back, X) and (b) the
label→clickable mapping (app icons: label ~26px below the icon). Options for the element
detector (icon-only):
- **OmniParser v2** (microsoft) — YOLOv8 icon detector (~100MB, **AGPL**) + Florence-2 caption
  (~200MB, MIT), ~0.6s/A100 (→ ~2-5s on MPS). Robust + pre-built, BUT: AGPL license (copyleft —
  a real concern for a shipped tool), 300MB + a VLM dependency, latency. Don't-reinvent, but
  heavy + license-encumbered.
- **Custom small element detector** — train a YOLO-ish icon/button detector on UI screenshots
  (mirrors the cursor-detector philosophy: small, self-contained). Needs UI-element training
  data (a big labelling effort) — the whole reason robustness-by-design worked for the cursor
  was a FIXED sprite; arbitrary UI elements are not fixed.
- **Classical CV + OCR fusion** — detect rounded-rect/button regions (edges/contours) + fuse
  with OCR. Lightweight, no license/model deps, but less robust (misses many element types).
- **App-icon OFFSET heuristic (Stage 1.5)** — bounded: for a home-screen/dock label match, click
  ~26px above (the icon). A hack, home-screen-specific, but makes "launch app by name" work.
RECOMMENDATION: Stage 1 (OCR text) is the robust, self-contained foundation — PROMOTE it to a
src/ module + a tap-by-text command/nix app (real capability, no license/deps). Stage 1.5
(app-icon offset) is a cheap bridge for launching apps. Stage 2 (icon-only) is a genuine FORK
with tradeoffs (OmniParser's AGPL+size+latency vs a lighter custom/CV approach vs deferring
icon-only targets) — needs a product-level decision, not an autonomous pick.

## Progress
- **2026-07-20 (Stage 1 — WORKS for text targets):** OCR = Apple Vision (native, accurate,
  no deps, gives boxes). tools/ocr/ocr.swift (VNRecognizeTextRequest, .accurate) → JSON
  [{text,conf,x,y,w,h,cx,cy}] in TOP-LEFT pixel coords (flips Vision's bottom-left normalized
  box). scratch/tap-by-text.ts: screenshot → OCR → exact/substring/fuzzy(Levenshtein) match →
  click centre via the shipped mover+cascade. VALIDATED LIVE: OCR found 32 home-screen text
  elements @conf 1.00; app-label X within 1-2px of the true icon X (Books 756 vs 757, Settings
  1025 vs 1027). End-to-end: `tap-by-text "Display & Brightness"` → localized (750,708) exact →
  clicked 4px → NAVIGATED to that Settings page (verified by screenshot). No hand-picked coords.
- KEY NUANCE (the central problem): OCR gives the TEXT position, but the CLICKABLE element is
  the text ONLY for buttons/rows. For an APP ICON the label sits ~26px BELOW the icon → clicking
  the label HIGHLIGHTS but doesn't launch (verified: `tap "Settings"` highlighted the icon, no
  launch). So Stage 1 is clean for text buttons/rows; app-icon labels need a label→icon offset,
  and icon-ONLY targets need Stage 2. (`success=false` from click-verify on panel navigations is
  a change-signature quirk, NOT a localization failure — ground truth is the screenshot.)
- NEXT: (a) app-icon offset heuristic (short label + icon-shaped region above → click label-~26);
  (b) Stage 2 element/icon detector for icon-only targets; (c) promote ocr + localize into a
  proper src/ module + a `tap-by-text` explore/nix command once refined.
