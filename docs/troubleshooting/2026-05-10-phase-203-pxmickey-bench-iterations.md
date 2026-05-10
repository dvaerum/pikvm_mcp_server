# Phase 203 — px/mickey data-collection bench: two iterations, both noisy

**Date:** 2026-05-10  
**Status:** Bench infrastructure incomplete — production detection
must be reused for next iteration.

## Goal (user's plan)

User correctly identified the strategic next step:

> First get really good mouse pointer detection. Then use detected
> position + screenshot to figure out how much the algorithm over/
> undershoots. The acceleration must be a mathematical curve based
> on how it feels to use, so we should be able to model it by
> collecting enough data.

Phase 202 (cursor-keepalive screenshots) addressed the "really good
detection" half. This phase aimed at the data-collection half.

## Iteration 1: motion-diff between pre and post frames

**Approach:** Take pre-emit screenshot, emit one chunk, take post-
emit screenshot, motion-diff to find pre/post cursor positions.

**Result:** 8 of 54 trials failed to find a 2-cluster pair. Several
clear outliers (e.g. x:m=5:p=10 → 56.20 px/mickey vs 8.80 for
slow paces at the same magnitude).

**Root cause:** `screenshotKeepingCursorAlive` (Phase 202) emits a
±1px wake nudge on BOTH the pre and post frames. So the diff
sees: actual move trajectory + 2 wake-cursor positions per frame
= 4-6 distinct cursor blobs. The "pick the 2 largest clusters as
pre/post" heuristic fails because it might pick a wake-cursor
position instead of the actual pre/post.

## Iteration 2: reference-frame diff

**Approach:** Capture a NO-CURSOR reference frame at startup
(go home + wait 1.8s for fade). Diff each measurement frame
against the reference; the cursor appears as the only motion
cluster.

**Result:** Even worse. Negative px/mickey values, repeated
identical detections across paces, several zero-displacement
readings.

**Root cause(s):**
1. The reference frame may have CAPTURED the cursor (1.8s wait
   wasn't enough for some bench runs, OR the cursor came back
   visible due to background HID activity).
2. The `setupCursorAtAnchor()` slam moves leave motion artifacts
   that show up in the diff against reference.
3. "Largest cluster wins" is wrong when widget animations
   dominate over a small cursor.

## Why the production code works and the bench doesn't

The production `findCursorByTemplateSet` (used in moveToPixel) is
battle-tested. It uses:
- A seeded template (captured cleanly via Phase 58
  `seedCursorTemplate`)
- NCC template-matching (not motion-diff)
- Locality hints (Phase 11 `expectedNear`)
- Confidence thresholds and false-positive guards (Phases 119,
  194-A, 197)

The bench tried to reinvent detection from scratch with a
simpler approach. It doesn't work because cursor detection on
iPad is genuinely hard and requires the full production stack.

## Right approach for the next iteration

**Option A (simpler — recommended):** Extend
`pikvm_measure_ballistics` with more reps (default 2, try 5-10)
to get a richer dataset. The production tool handles detection
correctly and aggregates via median, so noise averages out. With
10 reps × 48 cells = 480 trials. At ~10s/trial = ~80 minutes,
runs unattended overnight.

**Option B (richer — bigger lift):** Write a NEW bench that
imports `seedCursorTemplate` and `findCursorByTemplateSet` from
the production code. Seed a template at startup, then for each
single-emit measurement use the seeded template to locate the
cursor in pre and post frames. This gives clean per-emit data
with full production detection robustness.

Both options would produce data suitable for offline curve-
fitting. Option A is the lower-risk path; Option B gives finer-
grained per-trial data instead of aggregated medians.

## What's NOT changing this commit

- No production code modifications. Phase 202 (cursor-keepalive)
  remains shipped at v0.5.196.
- The two failed bench iterations are kept in
  `bench-pxmickey-data.ts` (v2, reference-frame approach).
  Not deleted because the file structure is reusable for the
  next attempt.
- Pilot output preserved at `data/pxmickey-samples/` (frames +
  noisy JSONL) for later analysis if needed.

## Summary of session iteration on this problem

- ~2 hours of bench rewriting
- 2 noisy datasets collected
- 0 actionable px/mickey curve fit
- Real lesson: reuse production detection from the start

The user's strategic plan is sound. My execution of it needs to
use the right tools (production detection code) instead of
reimplementing detection.
