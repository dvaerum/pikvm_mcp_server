# Phase 260 — shape + motion-diff hybrid: clock widget beats cursor

**Date:** 2026-05-11
**Version:** v0.5.220
**Status:** Hybrid approach attempted. Shape detector returns top-K
candidates; small wiggle should reveal which one moved. BUT: the
clock widget's continuous second-hand sweep produces MORE local
pixel-diff between pre/post frames than the cursor's discrete
50-px wiggle. 4/5 trials picked the clock widget area.

Need a differential approach (compare baseline vs wiggle-response),
not single-shot motion-diff. Queued as Phase 261.

## Ships in this phase

- `src/pikvm/cursor-shape-detect.ts` refactor:
  - Extract `findAllShapeCandidates` (internal) — find + sort all
    candidates by shape score
  - Add `findCursorShapeCandidates(rgb, w, h, k, options)` public
    API returning top-K
  - `findCursorByShape` now wraps `findAllShapeCandidates`[0]
- `test-phase260-shape-plus-motion.ts` validation script
- `data/phase260-hybrid/` 10 frames (pre + post per trial)
- v0.5.219 → v0.5.220
- All 713 unit tests still pass (no behaviour change in
  findCursorByShape's return)

## What was tested

`test-phase260-shape-plus-motion.ts`:
1. Unlock + home + gentle pre-position emit
2. 5 trials: each a different wiggle direction (right, down, left,
   up, diagonal) of ~50 px
3. Per trial:
   - Pre-frame screenshot
   - Shape detector → top-5 candidates
   - Wiggle emit
   - Post-frame screenshot
   - For each candidate: sum |pre - post| in a 50x50 box around
     the candidate's pre-position. The candidate with the
     highest local diff is hypothesized to be the cursor.

## Result

```
trial         | pick (x, y)    | local diff  | actual cursor?
--------------+----------------+-------------+---------------
wiggle-right  | ( 609,  970)   |     11,795  | NO (dock area)
wiggle-down   | ( 629,  158)   |     41,634  | NO (clock widget)
wiggle-left   | ( 629,  158)   |     39,188  | NO (clock widget)
wiggle-up     | ( 629,  159)   |     35,071  | NO (clock widget)
wiggle-diag   | ( 629,  158)   |     33,428  | NO (clock widget)
```

4 of 5 trials picked (629, 158-159) — inside the clock widget at
(605-695, 95-185). The minute-hand position varies in pre vs post
frames captured ~400 ms apart, contributing significant local
pixel diff.

## Why this fails

The clock widget has CONTINUOUS animation. Over 400 ms (the
inter-frame interval), the second hand sweeps ~2.4° = small
geometric motion but enough to change many pixels in a 50x50 box
around the minute-hand tip. Total local diff ~33-41k.

The cursor's wiggle is a DISCRETE 50-px displacement. In the
50x50 box around the cursor's PRE-position:
- Pre: cursor present (~80 dark pixels)
- Post: cursor gone (~80 light wallpaper pixels)
- Diff: ~80 pixels × ~100 brightness × 3 channels ≈ 24k

So clock motion-diff (33-41k) > cursor motion-diff (~24k). Static
shape candidates plus single-shot motion-diff doesn't distinguish
correctly.

## The fix (Phase 261 candidate)

DIFFERENTIAL motion-diff: capture THREE frames, not two.
- F0: pre-frame, no wiggle
- F1: short delay (e.g. 100 ms), no wiggle
- F2: wiggle emit + 400 ms delay, capture

Compare local diffs:
- diff(F0, F1) — baseline. Captures only "things that move on
  their own" (clock, animated widgets). Cursor doesn't move
  between F0 and F1.
- diff(F1, F2) — wiggle response. Captures clock + widgets +
  cursor.

For each candidate:
- score = diff(F1, F2) − diff(F0, F1)
- Cursor: large positive (only moves in F1→F2)
- Clock widget: ≈ 0 (moves equally in both intervals)

This is the principled separation. Phase 261 implements it.

## What does NOT change

- `moveToPixel`, `clickAtWithRetry`, MCP tool surface — unaffected.
- No production behaviour change.
- Tests still 713/713.
- Shape-detect module remains exported, with extended top-K API.

## Honest take

Phase 257 (prototype) said "looks promising." Phase 258 (locality
gate on Phase 251 frames) said "works 5/5." Phase 259 (diverse
positions) said "0/5 — dock icons beat cursor." Phase 260 (motion-
diff verification) said "0/5 — clock widget beats cursor."

Pattern: every approach finds A moving/dark/asymmetric thing.
Picking THE CURSOR among them needs a discriminator that's
specific to the cursor's distinguishing feature: it moves only
when we tell it to move. Differential motion-diff captures this.

Per Phase 248/250 lesson: this phase ships only the new top-K API
and the refactor that supports it. The hybrid concept is half-built
and not yet useful — Phase 261 finishes the principled version.

## Phase 261 follow-up: differential motion-diff is also noise-dominated

Implemented the Phase 261 fix the same tick: 3 frames (F0, F1, F2)
where F0-F1 is baseline-no-wiggle and F1-F2 is wiggle response.
Score = response − noise per candidate. Cursor should have low
noise + high response = high differential.

`test-phase261-differential.ts` N=5 result:

```
trial | pick (x, y)    | differential
right | (630, 157)     |       1596    ← clock widget area
down  | (1018, 983)    |        948    ← dock area
left  | (618, 260)     |       1404    ← calendar widget area
up    | (609, 970)     |       9606    ← dock area
diag  | (608, 969)     |        463    ← dock area
```

Differentials are tiny (463 - 9606 vs Phase 260's 33-41k motion-
diff scores). Signal-to-noise is too low. The iPad home screen has
multiple continuous noise sources (clock, weather widget refresh,
wallpaper subtle changes), and a single-wiggle differential can't
cleanly separate them.

This means **pixel-diff approaches at the iPad home screen need
either much larger cursor motion (200+ px), multiple averaged
wiggle cycles, or a fundamentally different signal.**

Phase 261 negative result documented; experiment retained at
`test-phase261-differential.ts` for future investigations.

## State

- v0.5.220
- 713/713 tests
- nix build green
- All committed and pushed
- Phase 260 top-K refactor + chroma penalty SHIPPED
- Phase 261 differential approach: NEGATIVE RESULT, no production change
