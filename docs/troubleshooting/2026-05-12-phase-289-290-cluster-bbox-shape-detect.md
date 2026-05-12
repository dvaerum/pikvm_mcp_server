# Phase 289-290 — cluster-bbox-aware shape-detect (v0.5.227)

**Date:** 2026-05-12
**Status:** Foundational refactor shipped. No measurable click-rate lift — the failure mode it targets was already being suppressed by the production locality gate.

## Phase 289: diagnose

`test-phase289-shape-diagnostic.ts` ran cursor-shape-detect against
saved Phase 280 + Phase 286 frames with the locality gate disabled and
full per-candidate score breakdowns (size, asymmetry, centroid offset,
bbox aspect, chroma).

### Findings

1. **The cursor IS visible** in every frame Phase 286 marked as "cursor
   vanishing". The original framing was wrong.
2. **Across 61 Phase 286 frames the clock widget at (629, 155) won
   unhinted top-1 on 82% of frames** (score 2.0-2.5). Cursor reached
   top-1 only on 3% (score 5+, frames f0007 and f0014).
3. **Root cause of the clock-FP score:** the 25-px rescan in
   `cursor-shape-detect.ts` (`findAllShapeCandidates` line 184)
   recomputes bbox + quadrant mass by sweeping a fixed 25-px box around
   each cluster's centroid. For clusters near other dark UI elements
   (clock face has digits, dial marks, two hands all within 25 px of
   any one hand's centroid), the rescan bbox saturates at 50×51 — the
   whole scan window — giving the clock-FP a "square aspect ratio" it
   does not actually have.
4. **The cluster's true connected-component bbox** is tight: a thin
   clock hand is 5×35 pixels (aspect 0.14, strong `aspectPenalty`),
   not 50×51. The rescan masks the discriminative information.
5. **A secondary issue:** the rescan accumulates RGB sums over ALL
   dark pixels in the 25-px box, including adjacent non-cluster
   pixels. For cursors on busy wallpaper, neighbouring teal-tinted
   pixels inflate chroma from ~5 (cursor itself) to 50+, triggering
   a near-fatal chromaPenalty.

## Phase 290: implement

### Changes

`src/pikvm/cursor-detect.ts`:
- `Cluster` interface gains `bboxMinX/MaxX/MinY/MaxY` (required) and
  optional `members: number[]` for connected-component pixel indices.
- `findClusters` BFS tracks bbox min/max during flood-fill; optionally
  retains member pixels via `opts.keepMembers`.
- `mergeClusters` combines bboxes (min/max) and concatenates members
  when merging.

`src/pikvm/cursor-shape-detect.ts`:
- Removed the 25-px rescan entirely.
- Aspect ratio computed from cluster's true bbox.
- Quadrant masses computed by iterating cluster member pixels.
- Centroid offset from cluster's bbox center, not scan-box center.
- Chroma from cluster's own `meanR/G/B` (which already excludes
  neighbours by construction). Softened penalty from `chroma/20` to
  `chroma/40` because cluster-only chroma is much lower than the old
  rescan-polluted chroma.

`src/pikvm/__tests__/mergeClusters.test.ts`:
- Helper updated to set trivial bbox `(centroidX, centroidX,
  centroidY, centroidY)`.

`src/pikvm/__tests__/cursor-shape-detect.test.ts`:
- New regression test pinning the cluster-bbox-aware behaviour: a
  compact arrow-like blob outscores a thin elongated stroke of similar
  pixel count by ≥2×. Before Phase 290, the fixed-radius rescan let
  the stroke score competitively with the arrow.

### Static-frame verification

Re-running `cursor-shape-detect` against the diagnostic frames:

| Frame | Pre-Phase 290 cursor rank | Post-Phase 290 cursor rank (unhinted) | Post-Phase 290 (hint at GT, r=200) |
|---|---|---|---|
| f0005 | 5/48 (score 0.08) | 5/10 (0.31) | **1/10** |
| f0007 | 1/48 (score 5.33) | 1/10 (1.27) | **1/10** |
| f0008 | 2/47 (score 2.35) | 1/10 (2.39) | **1/10** |
| f0014 | 1/48 (score 5.10) | 5/10 (0.43) | **2/10** |
| f023  | not in candidates | 3/10 (0.36) | **1/7** |

Clock-FP unhinted score: **2.45 → 0.63 (-74%)**. The fix is structurally
correct.

### Live click-rate measurement

| Target | Pre-Phase 290 (Phase 283 templates) | Post-Phase 290 (N=20 × 2) |
|---|---|---|
| Near (905, 800) | 50-70% band | 55%, 70% — same band |
| Far (757, 832) | ~0% | 0%, 0% — unchanged |

**No measurable click-rate lift on either target.**

## Why no click-rate lift?

In production, `cursor-shape-detect` is always called with a locality
hint from `client.belief.position`. The hint's default radius of
200 px already excludes the clock widget at (629, 155) when the
cursor is anywhere near a typical target (e.g. cursor near Books at
(733, 770) is 700+ px from the clock). So the clock-FP that
dominated unhinted diagnostic runs was *not* in fact dominating
production picks.

The Phase 286 hypothesis — that shape-detect was "locking onto the
clock widget at 2.0-2.5 in most frames" — was true *for unhinted
benchmark runs*, but Phase 290 confirms the locality gate was
already suppressing this failure mode in production. The remaining
~50% near and ~0% far failures come from somewhere else, most
likely:
- Cursor at edge / off-screen after sequential emits
- Belief drift pulling the locality gate away from cursor's true
  position
- Other FPs (dock-icon character, calendar digit) inside the
  locality region

## What was gained

1. **Detector reasoning is now principled.** Features come from the
   cluster's actual connected component, not a fixed-radius rescan
   that mixes in unrelated dark pixels.
2. **Future detector work has a clean foundation.** `Cluster` now
   carries bbox + optional member pixels; new geometric features
   (skeletonisation, moment invariants, stroke topology) can be
   computed without rebuilding the BFS or re-scanning.
3. **Regression test pins the principle.** Thin elongated strokes
   now objectively score lower than compact asymmetric blobs of the
   same pixel count.

## What was NOT gained

1. **Click rate.** Same Phase 283 band on near; still 0% on far.
2. **Far-target unblock.** The root cause of far-target failures is
   elsewhere — not in shape-detect's scoring math.

## Bottom line

This is a **foundational improvement, not a click-rate improvement**.
Shipped because (a) the refactor is independently correct, (b) the
regression test pins a previously-implicit assumption, and (c) the
next phase needs the cluster-bbox plumbing to investigate the real
production failure mode (likely belief-drift-related, not detector
scoring).

Per project standing rules: cursor-shape-detect remains the bet.
Phase 290 makes it cleaner; the next phase should diagnose why the
locality-gated detector still doesn't lift the click rate.
