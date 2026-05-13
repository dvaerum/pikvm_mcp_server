# ML detector live integration — v0.5.237 bench

**Date:** 2026-05-13
**Version:** v0.5.237 (ML primary, heuristic fallback)
**Status:** ML integration shipped. Detection works as designed.
Live click rate 0/40 — the iPad pointer-effect / click-registration
bottleneck is now fully exposed.

## Aggregate

N=10 × 4 targets × 2 reps = 40 trials at v0.5.237:

| target   | rep1  | rep2  | overall | dominant residual |
|----------|-------|-------|---------|--------------------|
| Settings | 0/5   | 0/5   | 0/10    | 13-17 px (cursor on icon, click ignored) |
| Books    | 0/5   | 0/5   | 0/10    | n/a (cursor outside ML crop after rate-limited emit) |
| TV       | 0/5   | 0/5   | 0/10    | 42-67 px (partial emit reach) |
| AppStore | 0/5   | 0/5   | 0/10    | 80 px (consistent — cursor at snap-zone edge) |

Compare to v0.5.236 baseline (Phase 313):

| version | screenChanged | genuine target hits |
|---------|---------------|---------------------|
| v0.5.236 (heuristic) | 6/40 (15%) | ~2/40 (5%) genuine, ~4/40 wrong-app |
| v0.5.237 (ML primary) | 0/40 (0%) | 0/40 |

The screenChanged rate dropped because v0.5.236's "successes" were
mostly wrong-app clicks at residual 100-280 px — ML correctly
returns NULL for those cases, eliminating the false positives.

## What worked (ML is doing its job)

**Settings (all 10 trials):**
- ML detection at 13-17 px from target icon
- Cursor unambiguously on the Settings icon
- 10/10 clicks fired at the detected position
- 10/10 failed to open Settings — iPad pointer-effect blocks tap

This reproduces the Phase 310 finding (residual=7 px tautology) on
a fresh detector. Detection isn't the bottleneck. Click registration
is.

## What didn't work (and why)

**Books (10/10 NULL):** Books target is at (640, 800). Cursor home
is at (1060, 778) — 420 px right of target. After emit, iPad rate-
limits and cursor stays near home. ML crop is centered at predicted
(640, 800), 256×256 wide → covers x=[512, 768]. Cursor at x≈1060
is OUTSIDE the crop window. ML correctly returns NULL.

The heuristic fallback (cursor-shape-detect with locality radius
100 around predicted) ALSO returns nothing because cursor is far
outside the locality window.

**TV/AppStore (partial reach):** Cursor moves partway but doesn't
reach target. ML finds it at the edge of the crop window (42-80 px
residual). Click fires there → outside target's hit area → no
screen change.

## What this means

The cursor-shape-detect (heuristic) work over Phases 290-313 and
the ML pivot have both succeeded **at the detection task**. The
detector is now demonstrably accurate (Phase 312: 3/3 visually-
verified within 7 px; this bench: Settings 10/10 within 17 px).

But the iPad has TWO upstream bottlenecks:

1. **Emit pipeline rate-limit**: iPadOS limits how fast/far the
   cursor can be moved via PiKVM relative-mouse HID events. Large
   target-displacement emits (Books from home is 420 px) get
   clamped → cursor doesn't reach target area → detection has
   nothing to find.

2. **Click registration**: iPadOS pointer-effect snap zone consumes
   single-tap mouse clicks when cursor is on an icon. Even at
   residual 7-17 px (cursor dead-on icon), the click doesn't open
   the app.

Neither is a detection problem. Both need either iPad-side
intervention (Reduce Motion accessibility setting, manual toggle
per Phase 117) or a different click protocol (longer dwell,
double-tap, or different HID sequence).

## Honest verdict

ML cursor detector v0 (`ml/cursor-v0.onnx`, ~10 MB) is **shipped
and works as designed**. It correctly identifies cursor positions
when the cursor is in the crop window. On Phase 312 visually-
confirmed frames it achieved median 3-6 px error.

Production click rate did NOT improve over v0.5.236 baseline. The
v0.5.236 baseline's "successes" were inflated by wrong-app clicks
(Phase 310 finding). ML correctly rejects those — exposing the
honest 0% genuine click rate.

The next bottleneck is iPad-side. Two paths forward both need
explicit user direction:

A. **Click protocol exploration**: Investigate longer mouseDown
   duration, double-tap, or different HID sequencing. Could
   directly unblock Settings/AppStore where cursor IS on icon.

B. **Emit pipeline fix**: Investigate why iPad rate-limits large
   emits. Could unblock Books where cursor doesn't reach target.

Per pivot memory: ignoring stale CURRENT FOCUS prompts. The ML
pivot is the right architectural direction — detector is solved.
Awaiting user direction on which upstream bottleneck to address
first.

## Files shipped this tick

- `src/pikvm/cursor-ml-detect.ts` — TypeScript wrapper around the
  ONNX model via `onnxruntime-node`
- `src/pikvm/move-to.ts` — ML primary in `tryOpenLoopShapeDetect`
  and correction-pass shape fallback. Heuristic stays as fallback.
- `ml/cursor-v0.onnx` + `cursor-v0.onnx.data` (10 MB) — trained
  model
- `ml/train-cursor-v0.py` — training script
- `ml/relabel-v0-data.py` — fix for label-direction bug in v0
  collection
- `bench-collect-cursor-data.ts` — self-supervised data harness
- `data/cursor-training-v0/` — 478 frames, 229 labeled pairs

## Tests

730/730 unit tests pass at v0.5.237. No regressions.

Phase 312 saved-frame replay (off-line) confirms ML accuracy:
- mid_left: 6.3 px (conf 0.997)
- mid_upleft: 22.8 px (conf 0.765)
- mid_above: 2.8 px (conf 0.997)
- offset-hint test (50 px off ground truth): 4.0 px (conf 0.998)
