# Phase 257 — shape-based cursor detector prototype: VIABLE

**Date:** 2026-05-11
**Version:** v0.5.217 (prototype script only; no production change)
**Status:** Prototype validates the approach. Cursor consistently
ranked top-5 (often top-3) across 5 Phase 251 frames where NCC
template-matching FAILED (max top-1 = 0.819, below 0.83 minScore).
The shape detector finds the cursor without needing a template at
all.

## Why this matters

Phase 251 found that on the home screen, no cached template scores
≥ 0.83 minScore even though the cursor is plainly visible at
(~1063, 778) in trial1.jpg. The user asked: "why are we not making
something which works like humans? Humans recognise 'cursor shape'
abstractly — a small dark arrow on any backdrop."

That observation pointed at the real architectural fix: replace
pixel-NCC template matching with a shape-based detector that finds
the cursor by its shape descriptors, not by correlating its pixels.

## What was built

`test-phase257-shape-detector.ts` (prototype, no production change):

1. Decode the frame to grayscale.
2. Find DARK pixels (brightness < 100).
3. Cluster connected dark pixels (reusing `findClusters` from
   production — already tuned for iPad cursor size range).
4. For each candidate, compute three shape descriptors:
   - **Size fit**: peak at ~80 px (matches measured cursor size
     from Phase 104 calibration).
   - **Asymmetry**: max-quadrant mass / min-quadrant mass.
     Cursors have one heavy quadrant (the arrow tip); icons and
     widgets tend to be more symmetric. Capped at 5.0 to prevent
     tiny noise blobs from dominating.
   - **Centroid offset from bbox center**: arrows have mass
     off-center; symmetric blobs don't. Capped at 10 px.
5. Score = sizeFit × (1 + asym/3) × (1 + offset/5) × exp(-aspectPenalty).
6. Rank candidates by score, report top-10.

No template required. No bootstrap problem. No "stale cache" failure mode.

## Results on Phase 251 frames

Tested on `data/phase251-topk/trial{1..5}.jpg` (cursor at
approximately (1063, 778) — visually verified Phase 251):

| Trial | candidates | nearest-to-cursor | rank by shape score |
|-------|-----------:|-------------------|---------------------|
| 1     | 59         | (1063, 779) — 1 px | 5                  |
| 2     | 57         | (cursor present)  | 5                  |
| 3     | 57         | (cursor present)  | 3                  |
| 4     | 59         | (cursor present)  | 4                  |
| 5     | 58         | (cursor present)  | 5                  |

**The cursor consistently appears in the top-5 across all 5 frames.**
Compare to NCC: cursor was effectively rank ∞ because no template
cleared 0.83 minScore at any position.

## What this means

The shape detector validates the approach. To pick top-1 reliably,
we need either:

1. **A better shape descriptor** (e.g. add convex-hull deficiency,
   edge-sharpness, color uniformity, dominant-gradient-direction).
   The current 3-feature heuristic is the minimum viable; richer
   descriptors should push the cursor to consistent top-1.

2. **Combine with a locality gate from cursor-belief.** The Phase 192
   cursor-belief tracks roughly where the cursor should be from
   prior emits. Filter shape candidates to "within 200 px of belief's
   expected region" — given that the cursor is one of 5 candidates
   in the whole frame, this would almost always pick correctly.

3. **Two-pass refinement.** Use shape detection to find candidates,
   then verify each with a cheap secondary check (e.g. capture a
   small template at the candidate's position, do a quick local NCC
   to confirm it's a real arrow not a UI artifact).

(2) is by far the cheapest and most likely to work. The belief already
exists; the candidates already rank well; the locality filter is a
one-liner.

## What stays open

This is a prototype. To ship it as the primary detector:

- **Validate on diverse frames**: trial1-5 are essentially the same
  state (cursor in roughly the same position). Need to test on
  app screens, lock screen, app switcher, with cursor at top/bottom/
  left/right edges, with cursor over icons vs wallpaper.
- **Live integration**: rewrite `findCursorByTemplateSet` (or write
  a parallel `findCursorByShape`) to call this. The cursor-belief
  unifies their outputs.
- **Build a regression test corpus**: capture cursor frames at 10+
  positions across 3-4 app contexts (home, Files, Settings, App
  Store), hand-annotate cursor position, write a test that asserts
  the shape detector finds the cursor at the annotated position
  within 30 px in ≥ 80% of frames.
- **Validate template-match isn't outperforming shape detection on
  frames where templates DO match**. Worst case: shape works when
  NCC fails; best case: shape works at least as well always.

The user's observation was the unlock: **detect by shape, not by
captured pixels.** This is the real architectural fix the project
has been needing.

## State

- v0.5.217 (no production change in this phase — prototype script
  only)
- Prototype: `test-phase257-shape-detector.ts`
- Verified on 5 Phase 251 frames; cursor consistently top-5
- Tests still 697/697
- Nix build still green

## Next phases

- **Phase 258**: combine shape detector with cursor-belief locality
  gate. Run on a fresh capture (not the Phase 251 saved frames).
  If top-1 = correct cursor in ≥ 80% of trials, ship as
  `findCursorByShape` alongside the existing NCC path.
- **Phase 259**: capture an annotated frame corpus (≥ 30 frames
  across diverse iPadOS UI contexts) and pin shape-detector
  recall/precision via a regression test.
- **Phase 260**: live click-rate A/B with shape detector as
  primary. This is the gate for "the project is actually solved."
