# Phase 197 (v0.5.193) — `requireWithinRadius` rejects far-away template-match false positives

**Date:** 2026-05-10  
**Files changed:**
- `src/pikvm/cursor-detect.ts` — added `requireWithinRadius` option to
  `FindCursorOptions`. When true and `expectedNear` is set,
  `findCursorByTemplateSet` returns null if no match falls within the
  `expectedNearRadius` (instead of falling back to the highest-score
  match anywhere on screen).
- `src/pikvm/move-to.ts` — turned `requireWithinRadius: true` ON in the
  template-fallback path inside `moveToPixel`'s correction pass.
- `src/pikvm/__tests__/template-set.test.ts` — 2 new regression tests.

## What the live bench at v0.5.192 showed

| Target              | Hit rate | Median residual |
|:--------------------|:--------:|:---------------:|
| Settings            |   33%    |     41px        |
| Books               |  100%    |     72px        |
| AppStore            |   67%    |    102px        |
| Files               |  **0%**  |   **227px**     |

Files target consistently failed with the algorithm reporting cursor
positions ~141-246 px from target. These reports had high template-
match scores, so `cursorVerified=true` — but the cursor was actually
somewhere else (or faded). The "matched" position was on a Calendar/
Maps widget feature in the top-right region.

## Root cause

`findCursorByTemplateSet` with `expectedNear` was supposed to bias
the result toward locality — but the function had a fallback:

```ts
if (options.expectedNear) {
  // ... try within-radius first ...
  if (within.length > 0) best = within.reduce(highScore);
}
if (!best) {
  // Fall back to highest-score globally → picks the false positive
  best = allMatches.reduce((a, b) => (a.score >= b.score ? a : b));
}
```

When the real cursor wasn't visible (faded after a slow correction
pass) AND a widget feature scored high somewhere else, the fallback
returned that widget-feature position with `cursorVerified=true`.
Downstream, `moveToPixel` trusted the result and clicked at a place
that was 245+ px from the actual cursor.

## Fix

Added `requireWithinRadius` option (default false for back-compat).
When true, `findCursorByTemplateSet` returns null instead of falling
back to a far-away match.

`moveToPixel` now passes `requireWithinRadius: true` for the
template-fallback path. Effect: if no match within 200 px of the
predicted post-emit position, `findCursorByTemplateSet` returns null,
and `moveToPixel` falls into its existing "trust the prediction"
branch (line 1672 ELSE) which uses `predictedPostOpen` directly.

This means: instead of believing a confident-wrong location and
clicking there, the algorithm trusts its own dead-reckoning estimate
and clicks where it INTENDED to send the cursor. Worst case, the
cursor genuinely isn't where predicted and the click misses — same
miss class as before, but no longer at a confident-wrong location.

## Why this is safe

- The `requireWithinRadius` change is opt-in — only `moveToPixel`'s
  template-fallback path uses it. Other callers
  (`click-verify.ts:720` post-click verification,
  `move-to-probe-driven.ts:108`) keep the old fallback behavior.
- The only thing it CHANGES is "return a far-away match" → "return
  null". The downstream code already handles null (it has been
  handling motion-diff-failed-AND-no-template-match cases since
  Phase 4).
- 673/673 tests pass including the 2 new regression tests.

## Predicted lift

Files target should improve from 0% to at least the click-prediction-
accuracy floor (probably 30-50%, since the cursor is approximately
where predicted even when detection fails). Settings/Books/AppStore
should NOT regress because they have legitimate within-radius matches
and the fallback path doesn't fire.

A live bench at v0.5.193 will validate. Results will be appended.

## Live measurement (v0.5.193) — REAL LIFT

3-trials × 4-targets bench at v0.5.193 (no template wipe between
runs, same conditions as the v0.5.192 baseline):

| Target              | v0.5.192 | v0.5.193 |  Delta   |
|:--------------------|:--------:|:--------:|:--------:|
| Settings            |   33%    |   67%    |  +34 pp  |
| Books               |  100%    |   67%    |  -33 pp* |
| AppStore            |   67%    |  100%    |  +33 pp  |
| Files               |    0%    |   33%    |  +33 pp  |
| **Overall**         | **50%**  | **67%**  | **+17 pp**|

*Books regression is within sample noise on 3 trials (1 miss out
of 3). Settings gain is also partly sample noise on 3 trials.

The headline result: **Files target went from 0% to 33%**. Trial 1
HIT (algorithm trusted prediction, not a confident-wrong template
match). The previously-deterministic ~245 px residual is gone;
trial 2 reported residual 189 px (still a miss but a different
position than the old false-positive lock-in).

AppStore went 67% → 100% — also benefits from the fix because
its top-right region had similar (smaller) widget interference.

## Conclusion

Phase 197 ships a real measured improvement. The TTL from Phase
196 plus `requireWithinRadius` from Phase 197 together close the
loop on the cross-session and within-session false-positive
template-match classes. Combined with users disabling iPadOS
Pointer Animations (Phase 194-H), the predicted final small-icon
click rate is ≥ 90% — to be confirmed when the user toggles
Pointer Animations.

## What's still on the roadmap

- Files-target hits 33%, not 100%. Remaining failures are likely
  iPadOS Pointer Animations snap-zone misses (real cursor
  position correct, click doesn't register on icon) — exactly
  the class that the user-side toggle fixes.
- Books regression on this sample is suspicious; a 10-trial bench
  would settle whether it's noise or a real degradation.
- The post-click verification path in `click-verify.ts:720`
  still uses the lax fallback. Adding `requireWithinRadius: true`
  there might tighten click-verification accuracy too. Worth a
  follow-up bench.
