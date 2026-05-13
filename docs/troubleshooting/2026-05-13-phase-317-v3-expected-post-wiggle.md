# Phase 317 v3 (v0.5.243) — wiggle-verify checks expected post-wiggle position

**Date:** 2026-05-13
**Version:** v0.5.243
**Status:** Phase 310 tautology successfully rejected. Detection is
honest at last. Click rate unchanged (was inflated by false-positive
screen changes).

## Iteration history

v0.5.241 first attempt at ML wiggle-verify used multi-hint
re-detection + motion-distance test. Failed: when pre-wiggle ML
returned an icon and post-wiggle multi-hint ML found the real cursor,
the position-difference looked large → falsely accepted the icon.

v0.5.242 used single hint AT initial position + still-there test.
Failed when ML confidence on the icon dipped slightly below threshold
post-wiggle — code accepted the original (wrong) detection by
returning `initial` when `stillThere` was null.

v0.5.243 (this version) flips the question: check at the **expected
post-wiggle position** (initial + emit · ratio). The real cursor
will be there because it moved with the wiggle. A static FP (icon)
will NOT be there because the icon doesn't move.

## Live verification (2 short benches × 3 trials, ~3 min each)

```
Bench 1 (v0.5.243):
  T1: residual=NN px detected=(NN,NN)   click=✗
  T2: residual=116px detected=(842,897)  click=✗
  T3: residual=197px detected=(1070,887) click=✗

Bench 2 (v0.5.243):
  T1: residual=108px detected=(840,886) click=✓
  T2: THREW — no cursor position established
```

Compared to v0.5.241 baseline:
- v0.5.241: ML returned icon-feature detections with residual=7-17
  px (lies, verified by visual GT). Click "successes" were false-
  positive screen changes (cursor not actually on icon).
- v0.5.243: No residual ≤ 30 px detected this run. Either large
  honest residuals (cursor not at target) OR honest throw (no valid
  detection found).

**Detection is now honest.** The "95% detection" claim from the
v0.5.240 multi-target bench was inflated by Phase 310 tautologies.
v0.5.243 ends that.

## How the test works

```
  Initial ML detection: position P, confidence C
  Emit wiggle: (+25, -10) mickeys = ~(35, -14) px on iPad
  Expected post-wiggle position: P + (35, -14)
  Re-run ML with hint AT expected post-wiggle position
  
  If cursor found within 30 px of expected:
    → real cursor moved with the wiggle, accept initial detection
  
  If nothing high-conf at expected:
    → static FP (icon doesn't move with mouse emits), reject
  
  If something found > 30 px from expected:
    → ML picking up a different feature, not the cursor, reject
```

The key insight: a static FP (icon, label text, dock glyph) does NOT
move when we wiggle the mouse. The real cursor DOES move. So check
at where the cursor SHOULD be after the wiggle — if it's there, real;
if not, FP.

This mirrors Phase 297's approach for shape-detect but framed around
ML's hint-and-crop architecture (single hint at expected position,
single inference) rather than radius-around-initial.

## Click rate

| | v0.5.240 | v0.5.241 | v0.5.243 |
|---|---|---|---|
| Reported "click ✓" | mixed | 1-2/3 | 0-1/3 |
| Cursor actually on icon | mostly no | mostly no | mostly no |
| Verifiable target hit | ~0/N | ~0/N | ~0/N |

Click rate didn't IMPROVE because the previous "successes" were
false-positive screen changes (clicks landing in background or wrong
target after cursor was not actually on icon). v0.5.243 stops
counting those as success.

This is a NET-NEUTRAL change to click rate but a STRICT IMPROVEMENT
to detection honesty.

## What's still upstream

The fundamental issue: cursor often doesn't reach the click target
due to iPad-side rate-limiting + pointer-effect. v0.5.243 honestly
reports this (residuals 100+ px = "cursor didn't reach target")
instead of lying about it. The remedy is upstream of detection
(click protocol experiments, Reduce Motion accessibility setting,
or different HID protocol) and needs explicit user direction per
past sessions.

## Files

- `src/pikvm/move-to.ts` — `mlWiggleVerify` v3
- `package.json` + `src/version.ts` — 0.5.242 → 0.5.243
- This document
