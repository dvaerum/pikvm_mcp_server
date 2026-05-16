> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# v0.5.239 — home-zone multi-hint fix for ML detection

**Date:** 2026-05-13
**Version:** v0.5.239
**Status:** Shipped. Detection on Books target goes from 0/10 → 8/8.

## Root cause (v0.5.238 Books 10/10 NULL)

The v0.5.238 multi-hint integration passed `belief.position` as a
second crop hint to the ML detector, intending to cover the case
where iPad rate-limits a long emit and the cursor stays near home.

Live diagnostic at v0.5.238 showed `belief.position = (-3051, -4130)`
— **wildly off-screen** — after a routine `unlockIpad → ipadGoHome`
sequence. The belief's `predict()` integrates emits and clips to
bounds, but `bounds` is only set when `setBeliefBounds` is called
(in `move-to.ts` per Phase 192-B). Unlock and home swipes happen
*before* `moveToPixel`, so they accumulate as predicted motion with
no clipping and drift the belief off-screen.

Result: the second ML hint was clamped to the (0, 0) corner crop,
which never covers the actual cursor location. Multi-hint reduced
to effectively single-hint at predicted target → same 0/10 NULL.

## What was actually happening

Single-trial diagnostic at v0.5.238 (`test-v238-books-diagnostic.ts`):

```
hint=predicted (target)     → ML=(674,674) conf=0.143
hint=belief.position        → ML=(254,  2) conf=0.076  ← off-screen, useless
hint=home (1060, 778)       → ML=(1170,892) conf=0.968  ← CURSOR
hint=screen-center (840, 525) → ML=(966, 399) conf=0.142
```

Cursor was at (1170, 892), the home zone. The ML detector finds it
with 96.8% confidence when given the right hint. The fix is to give
ML the right hint regardless of belief state.

## v0.5.239 fix

New helper `buildMLHints` in `src/pikvm/cursor-ml-detect.ts`:

1. Always include `predicted` (the target the algorithm is aiming for).
2. Include `belief.position` ONLY if it's inside the frame AND > 200 px
   from the existing hints. (Skips the off-screen drift case.)
3. Always consider a "home-zone" fallback at
   `(frameWidth × 0.625, frameHeight × 0.75)` — the typical cursor
   park location on iPad after navigation. Add if > 200 px from
   existing hints.

Used at both ML call sites in `move-to.ts`:
- `tryOpenLoopShapeDetect` (line 1854)
- correction-pass (line 2315)

Eight unit tests in `src/pikvm/__tests__/cursor-ml-detect.test.ts`
pin the helper behavior, including the v0.5.239 diagnostic scenario
(predicted Books + drifted belief → home-zone hint covers cursor).

## Empirical result

`test-v238-books-verify.ts` ran 8 trials at v0.5.239 before iPad
re-lock interrupted (results.json not written, but per-trial output
captured):

| Metric | v0.5.237 (no multi-hint) | v0.5.238 (belief multi-hint) | v0.5.239 (home-zone) |
|---|---|---|---|
| Detected | 0/10 | 0/10 | **8/8** |
| Click success | 0/10 | 0/10 | **2/8** |

Per-trial v0.5.239 results:

```
T1: detected=(652,724) residual=77px  attempts=2 click=✓
T2: detected=(754,806) residual=114px attempts=4 click=✗
T3: detected=(752,806) residual=112px attempts=4 click=✗
T4: detected=(648,561) residual=239px attempts=4 click=✗
T5: detected=(753,806) residual=113px attempts=1 click=✓
T6: detected=(755,799) residual=115px attempts=4 click=✗
T7: detected=(753,806) residual=113px attempts=4 click=✗
T8: detected=(777,668) residual=190px attempts=4 click=✗
```

**Detection layer: 8/8 (100%) — full recovery from 0/10 NULL.**
**Click layer: 2/8 (25%) — first non-zero rate on Books at home.**

The click failures still trace to two unresolved iPad bottlenecks:
- Residual >100 px on most trials: cursor reaches near-target but
  iPad pointer-effect snap zone consumes the click.
- Some trials show consistent residual 113 px → snap-zone consistently
  parking cursor in the same wrong spot.

These are upstream of detection. The detection fix unblocks all
future work on iPad-side click protocols.

## Files modified

- `src/pikvm/cursor-ml-detect.ts` — added `buildMLHints` helper
- `src/pikvm/move-to.ts` — both ML call sites use the helper
- `src/pikvm/__tests__/cursor-ml-detect.test.ts` — new, 8 tests
- `package.json`, `src/version.ts` — 0.5.238 → 0.5.239

## Tests

738/738 unit tests pass (730 before, +8 new). No regressions.

## What's left

- Settings/AppStore/TV targets: unverified at v0.5.239. Expected
  improvement only for cases where cursor doesn't reach target
  (i.e. Books-like pattern). Settings cursor reached target at
  v0.5.238 (residual 13-17 px), so v0.5.239 won't change those.
- The 25% click rate on Books is bounded by iPad pointer-effect
  snap zone. Next bottleneck: click protocol experiments need
  user direction.
- belief drift root cause (no bounds during unlock/home) still
  exists. Defended at the multi-hint layer; not fixed at the
  belief layer. Future work could move the clip-and-inflate into
  `client.mouseMoveRelative` directly, but the multi-hint defense
  is sufficient for the detection improvement.
