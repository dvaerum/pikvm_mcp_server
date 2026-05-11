# Phase 252 — H1 vs H2 unanswered; clock widget blocks seedCursorTemplate

**Date:** 2026-05-11
**Version:** v0.5.216 (no code change in this phase)
**Status:** Comparison experiment failed at step 2: seedCursorTemplate
returned ok=false because motion-diff was dominated by the clock
widget's animating second hand, not the cursor. H1 (stale cache) vs
H2 (extraction leaks backdrop) remains unanswered. New finding:
seedCursorTemplate is fragile to other animated UI on the home
screen. Phase 253 will retry with cursor pre-positioned far from
the clock + a larger wake-emit.

## What was attempted

`test-phase252-fresh-vs-cached.ts`: compare cached templates' top-1
score on a frame F1 against a freshly-seeded template's top-1 on the
same F1. The cached set should fail per Phase 251; the fresh template
should clear 0.83 if H1 (stale cache) is the lever.

## What happened

Step 1 — cached templates against F0:
- Set size = 5 (within 6h TTL)
- Max top-1 across cached = **0.781**, below 0.83 minScore
  (matches Phase 251: 0.45-0.81 range)

Step 2 — `seedCursorTemplate(client)`:
```
ok=false
cursorPosition=(619,168)
persisted=false
reason="looksLikeCursor rejected all 1 candidate cluster(s).
Tried: (619,168) 175px → looksLikeCursor rejected."
```

(619, 168) lies INSIDE the clock-widget bounds (~605-695 × 95-185
on this 1680×1050 layout). The cluster is 175 px — that exceeds the
nominal cursor size (~80-90 px from Phase 104) but wasn't filtered
because mergeClusters runs AFTER the size filter and merges
sub-clusters within `mergeRadius: 20` px. The clock's second-hand
sweep produces multiple sub-clusters within 20 px of each other; the
merged sum exceeds the per-pre-merge cap.

Step 3 — comparison: skipped because no fresh template was
persisted. The script identified the "newest" template by mtime
but it was the same old file from 02:04 UTC.

## Visual confirmation (screenshots are source of truth)

`data/phase252-fresh-vs-cached/F0.jpg`: home screen with the cursor
clearly visible at approximately (1063, 778) (small dark arrow right
of Settings icon). Clock shows 06:38 (Phase 251 was 06:24 — 14 min
gap). Weather widget temperature changed from 2° to 3° — confirming
both clock and weather widgets are animating.

## Why this matters beyond the unanswered H1/H2

Even without the H1/H2 result, the run produced a real finding:
**seedCursorTemplate cannot reliably extract a fresh template on the
iPad home screen because animating widgets dominate motion-diff.**
This wasn't documented before. It explains why "re-seed when
detection fails mid-session" wouldn't actually work as the Phase 252
hypothesis assumed — the seeding path itself fails on the very same
home-screen state the click bench targets.

This is a different kind of failure than Phase 215 documented (sat-
gate rejecting cursor clusters). Here the cursor cluster is rejected
because a NON-cursor cluster won the candidate ordering and
looksLikeCursor said "no" to it.

## Mechanism

`src/pikvm/seed-template.ts:128-135` calls `diffScreenshotsDecoded`
with `maxClusterSize: 120, mergeRadius: 20`. The size filter is
applied to RAW clusters before merging. `mergeClusters` (line 257
of cursor-detect.ts) sums member pixels into merged total. So a
clock-widget sweep producing 2× ~90 px sub-clusters within 20 px →
one ~180 px merged cluster, larger than the cursor's ~85 px and
ranked first in the size-sorted candidate list. looksLikeCursor
rejects it (correctly — it's not the cursor) and seeding fails.

## Decision

**No code change in this phase.** Phase 248/250 lesson: do not ship
a fix without bench evidence the fix helps.

Two candidate fixes for Phase 253 to test, each in script-only form
first (no production change yet):

1. **Pre-position cursor mid-screen, far from clock.** Use chunked
   relative emits to deposit the cursor at (840, 600) before
   calling seedCursorTemplate. The cursor's local wake-emit motion
   then dominates motion-diff in that region. Lowest-risk path.

2. **Larger wake-emit in seedCursorTemplate.** Default emitDx=100;
   try emitDx=200 or emitDy=200. Larger emit makes the cursor
   contribute more motion-diff pixels (two cursor positions further
   apart = bigger total diff area when the post-merge bound is wide
   enough).

Phase 253 will run option 1 first (script-only, no production
change). If a fresh-template extracted via option 1 clears 0.83
on the same frame, then both H1 (stale cache) AND the seed-pre-
positioning recipe are confirmed in one experiment. If it fails too,
H2 (extraction leaks backdrop) is more likely and Phase 254 should
revisit Phase 106 mask construction.

## What stays open

- H1 vs H2 — not yet answered
- Whether `mergeClusters` should apply a post-merge size cap when
  used for cursor seeding (vs general motion detection where wider
  merges are useful)
- Whether the home screen needs a different seeding strategy than
  apps-with-static-UI (clock widget is iPadOS default; can't be
  removed)

## State

- v0.5.216 stable (no code change)
- Tests pass (744/744)
- nix build green
- Bench script `test-phase252-fresh-vs-cached.ts` retained
- Trial frames at `data/phase252-fresh-vs-cached/`
