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

## Live measurement (v0.5.193) — initial 3-trial vs follow-up 5-trial

### 3-trial run (preliminary, noisy)

| Target              | v0.5.192 | v0.5.193 (n=3) | Delta |
|:--------------------|:--------:|:--------------:|:-----:|
| Settings            |   33%    |   67%          | +34pp |
| Books               |  100%    |   67%          | -33pp |
| AppStore            |   67%    |  100%          | +33pp |
| Files               |    0%    |   33%          | +33pp |
| **Overall**         | **50%**  | **67%**        | +17pp |

### 5-trial follow-up (more honest)

| Target              | v0.5.193 (n=5) | Median residual |
|:--------------------|:--------------:|:---------------:|
| Settings            |     80%        |    138px        |
| Books               |    100%        |     66px        |
| AppStore            |     60%        |    163px        |
| Files               |   **0%**       |    239px        |
| **Overall**         |   **60%**      |       —         |

### What the larger-N tells us

- The 60% overall sits between the v0.5.191 baseline (58%, n=3)
  and the noisy v0.5.193 n=3 reading (67%). Phase 197 doesn't
  blow up overall click rate — it's roughly neutral on the
  aggregate.
- **The Files-target false-positive lock-in IS broken**. Pre-
  Phase 197: every Files trial reported residual 245.15301...
  px (identical to many decimal places, deterministic). Post-
  Phase 197 (n=5): residuals are 538, 239, unv, unv, 207. The
  algorithm is no longer confidently locked onto a wrong widget
  feature.
- **But Files still fails 0% on 5 trials** — for OTHER reasons:
  cursor fades before screenshot, snap-zone misses, or detection
  genuinely failing in the top-right region. Two trials reported
  `unv` (cursorVerified=false) — Phase 197 correctly returned
  null instead of fabricating a position.

### Practical takeaway

Phase 197 is a CORRECTNESS improvement, not a click-rate
improvement. The algorithm now reports honest "I don't know
where the cursor is" instead of confidently lying. Downstream
behavior (trust the prediction, retry) is unchanged.

The remaining Files failure class needs different work:
- Cursor wake/refresh before detection in top-right region
- Region-specific search-window tuning (Maps widget interferes)
- iPadOS Pointer Animations OFF (user-side toggle)

## Conclusion (revised after 5-trial bench)

Phase 197 ships a CORRECTNESS improvement, not a click-rate
improvement. The Phase 196 TTL + Phase 197 `requireWithinRadius`
together close the false-positive surface at:
- Persist time (Phase 102-106 cluster bounds + masked extraction)
- Load time content (Phase 194-A `looksLikeCursor` validator)
- Load time age (Phase 196 6h TTL)
- Match time (Phase 197 `requireWithinRadius`)

Aggregate click rate on n=5: 60% — within noise of v0.5.191
baseline (58%). The 67% on the initial n=3 sample was sample
noise; don't read a real lift into it.

## What's still on the roadmap (Phase 198+ candidates)

- Files target still 0% on 5 trials. Remaining failure modes:
  cursor fade before detection, snap-zone misses, or detection
  genuinely failing in top-right region (Maps widget animation
  interferes).
- Region-specific search-window tuning: top-right has different
  detection characteristics than dock area.
- Apply `requireWithinRadius: true` to `click-verify.ts:720`
  (wake-and-recapture path) — additive, Phase 140 already
  filters second-opinion results by closer-to-target.
- iPadOS Pointer Animations OFF (Phase 194-H, user-side):
  remains the highest-leverage step for small-icon click rate.
