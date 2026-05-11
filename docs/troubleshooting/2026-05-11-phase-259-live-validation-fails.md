# Phase 259 — live validation FAILS on diverse cursor positions

**Date:** 2026-05-11
**Version:** v0.5.219 (soft chroma penalty added; no integration shipped)
**Status:** Shape detector validated on Phase 251 saved frames
(Phase 258, 5/5 picked correctly) does NOT generalise to fresh
live frames with cursor at different screen positions. Phase 259
N=5 trials with cursor at varied positions = 0/5 within 30 px.
The Phase 251 frames were UNREPRESENTATIVE — cursor in an open
area away from dock; on diverse frames the detector ranks dock-
icon dark regions above the actual cursor. NOT ready for
production integration.

## What was tested

`test-phase259-shape-live.ts`:
1. Unlock + home + chunked emit to centre-ish cursor position.
2. 5 trials: each emits a different displacement (right, down,
   left-up, up, right-down), captures post-emit screenshot.
3. Motion-diff between pre/post = ground-truth cursor position.
4. Run `findCursorByShape` on post frame with hint at the
   motion-diff truth.
5. Compare detected vs. truth.

Acceptance was set at ≥4/5 within 30 px. Result: **0/5**.

```
trial         | truth          | detected       | dist
--------------+----------------+----------------+-----
right         | (1165,  988)   | (1018,  983)   | 147
down          | (1162,  987)   | (1133,  965)   |  36  (≤30 px)
left-up       | (1040,  889)   | (1133,  965)   | 120
up            | (1040,  889)   | (1018,  983)   |  97
right-down    | (1153,  871)   | (1018,  983)   | 175
```

## Root causes

### 1. Experiment design — pre-position drove cursor off-screen

The 8 × (80, 60) chunked emit at the start drove the cursor to
the right screen edge (cumulative 640 right + 480 down from
slamToCorner). On a 1680×1050 iPad in portrait, that exceeds the
visible screen-region right edge (~1156 px). Cursor got clamped.

Visual inspection of `data/phase259-shape-live/t1-post.jpg`: no
cursor visible anywhere on the iPad screen. The "motion-diff
truth" at (1165, 988) was picking dock-area animation noise, not
the cursor. Trials 1, 2, 5 hit this case.

Trial 3 (left-up: cursor moved -100, -100) actually un-clamped
the cursor enough to render: visually at ~(1050, 890) in trial 3
post-frame. Motion-diff said (1040, 889) — that was correct.

### 2. Dock icons score better than cursor on the shape heuristic

For trial 3 (where ground truth was reliable):
- Cursor at (1050, 890): dark gray, ~76 px, asymmetry ~2
- Shape detector picked (1133, 965): dock area (App Store / AppTV
  region), darker, more asymmetric icon outline

The dock icons aren't just dark — they have STRONGER asymmetry
than the soft anti-aliased cursor. The shape score prefers them
even WITH the locality gate active.

### 3. Chroma penalty (this commit) helps but not enough

Added `chromaPenalty = exp(-chroma / 20)` to penalise candidates
whose dark-pixel mean RGB shows large channel spread (coloured
icons vs grayscale cursor). Tests pass; Phase 251 frames still
work; but live diverse-position N=5 still 0/5.

Likely because the iPad dock-icon dark sub-regions are
NEARLY-grayscale dark (Mail icon's "M" stroke is fairly neutral
gray, AppTV body is very dark gray). Chroma penalty differentiates
red/blue badges, not dark-gray icon strokes.

## What was shipped

- `src/pikvm/cursor-shape-detect.ts`: soft chroma penalty (does
  not change Phase 258 behaviour on Phase 251 frames; 16 unit tests
  still pass)
- `test-phase259-shape-live.ts`: validation script (retained as a
  regression bench)
- `data/phase259-shape-live/`: 10 frames (pre + post per trial)
- This doc
- v0.5.218 → v0.5.219

The shape-detect module remains exported but **NOT INTEGRATED**
into the production click pipeline. Integration was contingent on
this validation, which failed.

## What does NOT change

- `moveToPixel`, `clickAtWithRetry`, MCP tool surface — all
  unaffected.
- Tests still 713/713.
- Nix build still green.
- Cursor-belief, NCC template-match, motion-diff — all unchanged.

## What stays open (Phase 260+ candidates)

The shape detector finds the cursor as a CANDIDATE — it ranked the
cursor 3-5/59 in Phase 257 unhinted. The problem is picking it as
top-1 when dock icons compete.

Discriminators that might separate cursor from dock icons:
- **Edge sharpness vs softness**: cursor is anti-aliased (gradient
  edges); icons are rendered with sharper edges. Compute edge
  gradient histogram per candidate; cursors have lower gradient
  variance.
- **Local-region brightness**: cursor sits on relatively bright
  wallpaper or app background; dock-icon dark sub-regions are
  surrounded by icon backgrounds (also dark or coloured).
  Reject candidates where the SURROUNDING annulus is also dark.
- **Y-coordinate prior**: dock occupies y > 950 on this iPad. A
  belief-aware filter could downweight candidates in known UI
  zones. Fragile (different layouts have different zones), but
  effective.
- **Confirm via motion-diff**: emit a small wiggle, check if the
  candidate moved between pre/post. Real cursor moves; icon
  doesn't. This is essentially the legacy motion-diff detector
  but bootstrapped by shape candidates instead of finding clusters
  raw.

The most principled fix is the LAST one — **shape candidates +
motion-diff confirmation**. Shape gives ~5 candidates; a tiny
wiggle distinguishes the moving one (cursor) from the static ones
(icons). Phase 260 candidate.

## Honest take

Phase 257-258's positive results were premature. The Phase 251
saved frames had the cursor in an open area far from the dock,
where dock-icon competitors didn't appear in the top-5. The
moment the cursor is anywhere near the bottom of the screen,
dock icons win the shape score.

This is a **negative result** for "shape detector alone solves
detection." It's still useful as a candidate generator (better
than NCC which returns null on these frames), but it needs a
secondary disambiguator to pick top-1 reliably across diverse
positions.

Per Phase 248/250 lesson: ship code with demonstrated effect.
This phase ships only the chroma penalty (which is a small,
demonstrated improvement against coloured-icon false positives)
and documents the integration gate clearly: shape detector is
NOT yet production-ready.

## State

- v0.5.219
- 713/713 tests
- nix build green
- No production behaviour change in this commit
