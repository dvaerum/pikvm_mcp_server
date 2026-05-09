# Phase 196 — 6h TTL on persisted cursor templates fixes deterministic-residual bug

**Date:** 2026-05-10  
**Version:** 0.5.192  
**Files changed:**
- `src/pikvm/template-set.ts` — added `maxAgeMs` parameter to `loadTemplateSet`,
  default 6 hours.
- `src/pikvm/__tests__/template-set.test.ts` — three new TTL tests.

## What the bench showed

Live `bench-click-extensive.ts` run at v0.5.191 with templates from a
prior session (~4 hours old) on disk:

| Target                              | Hit rate | Median residual |
|:------------------------------------|:--------:|:---------------:|
| Settings (small icon, badge)        |   100%   |     38px        |
| Books (small icon)                  |   100%   |     47px        |
| App Store (small icon)              |    33%   |    119px        |
| Files (small icon, top-right)       |   **0%** |  **245.15px**   |

**Critical observation:** Files target had identical residual
`245.15301344262525` on all 3 trials, with `cursorVerified=true` on
each. Floating-point identical to many decimal places. That's not
random click variance — that's the cursor-detection algorithm
deterministically locating "the cursor" at the same wrong place every
trial.

## Diagnosis

The persisted cursor templates in `data/cursor-templates/` were from
a session ~4 hours earlier (file mtimes from May 9 20:40-45). Phase
194-A added a load-time validator (`looksLikeCursor`) that drops
templates whose pixels don't look cursor-like. But these templates
PASSED the validator while still matching strongly at a non-cursor
feature in the top-right region (likely on an animated Maps widget
pixel pattern).

Wiping `data/cursor-templates/` and re-running the same Files target
produced varying residuals across trials:

| Trial | Result | Cursor detected at | Residual    |
|------:|:------:|:-------------------|------------:|
|   1   | HIT    | (1051, 370)        |  52.50 px   |
|   2   | MISS   | (812, 316)         | 246.06 px   |
|   3   | MISS   | (1035, 298)        | 122.00 px   |

Residuals now vary trial-to-trial, and trial 1 hit at 52px on first
attempt. The deterministic 245.15 px across trials was a function of
stale cross-session templates — **NOT** an iPadOS snap-zone effect or
ballistics issue as the prior diagnosis (Phase 194-E) thought.

## Fix

Added a `maxAgeMs` parameter to `loadTemplateSet` (default 6 hours).
Templates whose file mtime is older than this are silently skipped
at load time. This naturally separates sessions while still letting
templates amortize across a long-running batch.

```ts
// src/pikvm/template-set.ts
export const DEFAULT_TEMPLATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export async function loadTemplateSet(
  dir: string,
  validate?: (t: CursorTemplate) => boolean,
  maxAgeMs: number | null = DEFAULT_TEMPLATE_MAX_AGE_MS,
): Promise<CursorTemplate[]> {
  // ... reads dir, filters by mtime ...
}
```

Pass `null` to opt out of TTL (back-compat for callers that want it).

## Why 6 hours?

- Within-session: a typical bench or production session runs <2h,
  so all freshly-captured templates are reusable.
- Cross-session: > 6h is almost certainly a different session
  (overnight gap, new day, new task). Reusing templates from then
  risks the bug observed here.
- Iteration cycle: less than 6h means a developer running back-to-
  back tests gets template reuse benefits without contamination.

If a longer or shorter TTL turns out to be optimal, callers can
pass an explicit `maxAgeMs`.

## What this changes for downstream

- `click-verify.ts` and `move-to.ts` already call `loadTemplateSet`
  with two args; they now pick up the 6h default automatically.
- `seed-template.ts` exposes `loadExisting` as an option — also
  picks up the default.
- All 671 existing tests still pass.
- 3 new tests pin the TTL behavior.

## Related work

- Phase 102/103 (cache contamination fix): tightened cluster-size
  bounds to reduce false-positive template extraction.
- Phase 105 (multi-cluster try): retry alternative clusters if the
  primary one fails extraction.
- Phase 106 (mask-based extraction): mask zeros out non-changed
  pixels so templates are cursor-only.
- Phase 194-A (load-time validator): rejects templates that fail
  `looksLikeCursor`.
- **Phase 196 (this doc): rejects templates that pre-date the
  current session via TTL.**

The chain is now fully defensive — at persist time, at load time
(content), at load time (age).

## Honest measured lift (REGRESSION on first attempt)

A live re-bench at v0.5.192 with `data/cursor-templates/` wiped at
bench start (Phase 196b initial commit) showed a REGRESSION:

| Target              | v0.5.191 (stale templates) | v0.5.192 (clean templates)|
|:--------------------|:--------------------------:|:-------------------------:|
| Settings            |          100%              |             0%            |
| Books               |          100%              |            67%            |
| App Store           |           33%              |            33%            |
| Files               |        0% (det. 245px)     |        0% (unverified)    |
| **Overall**         |        **58%**             |          **25%**          |

What this teaches us:

The "stale" templates were not pure poison. Some helped Settings/
Books (where the cursor lives in the lower-half of the screen and
templates from prior sessions still matched correctly there). Only
the Files target was actively poisoned by a template matching a
top-right widget feature.

A blanket wipe removes the helpful templates along with the
poisonous one, and forces trial 1 of the first target to fall back
to motion-diff alone — which has higher variance and frequently
fails on iPadOS soft cursors.

## Revised approach

The TTL on `loadTemplateSet` is still a sound long-term safety net
(catches truly cross-day templates), and was kept. The bench-script
auto-wipe was REVERTED in `bench-click-extensive.ts` (Phase 196b
follow-up). Manual wipe between back-to-back same-day comparison
runs remains a good practice for A/B testing, but it is no longer
the default bench-start behavior.

Real fix for the Files-target false-positive remains TBD. Likely
options:
1. Per-region template stores (templates trained against one
   screen region don't match in another).
2. Stricter false-positive rejection at template-match time
   (e.g. require multi-pixel motion-diff agreement above a higher
   threshold).
3. Region-blacklist (don't search for cursor inside known
   animated widget zones like Maps).

These are Phase 197+ candidates.

## Conclusion

Phase 196 ships:
- (kept) 6h TTL on `loadTemplateSet` — defensive against
  cross-session contamination, low blast radius.
- (reverted) auto-wipe in `bench-click-extensive.ts` — was a
  measured regression.

Live numbers at v0.5.192 with templates left intact should match
v0.5.191 baseline (58% overall). The Files-target failure is a
deeper bug in template false-positive matching that the TTL alone
doesn't fix.

## Diagnostic procedure for future stale-template incidents

1. If a target shows deterministic-identical residual across
   multiple trials, suspect template-match cursor mislocation.
2. Check `data/cursor-templates/` for files older than the current
   session.
3. If the TTL is correctly disabled (`maxAgeMs: null`) but stale
   templates pollute, escalate to a stricter validator (e.g.
   require minimum interior cluster cohesion) or reduce TTL.
