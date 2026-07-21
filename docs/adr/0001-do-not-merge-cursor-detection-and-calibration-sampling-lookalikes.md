# Do not merge the look-alike screenshot / iPad-bounds helpers

## Status

accepted (2026-07-21)

## Context

An architecture review flagged three apparent duplications for consolidation.
On investigation, two of them are **intentional divergence that a naive merge
would turn into a behaviour regression** on hardware paths that can only be
validated live. Recording the decision here so a future review does not
re-suggest the merge.

## Decision

**Merged (safe):** the `median()` helper — byte-identical (modulo an empty-array
guard that both variants already honoured) — was extracted to
`src/pikvm/util.ts` and shared by `auto-calibrate.ts` and `ballistics.ts`.

**Deliberately NOT merged:**

1. **`takeRawScreenshot` is three functions, not one.** The exported copy in
   `cursor-detect.ts` prefers `screenshotKeepingCursorAlive()`, which emits a
   ±1 px wake nudge so the auto-fading iPad cursor stays visible for
   pre/post-diff detection. The private copies in `auto-calibrate.ts` and
   `ballistics.ts` deliberately use a plain `client.screenshot()`: a wake nudge
   right before a **calibration/ballistics** capture would contaminate the very
   displacement being measured. They share a name, not a contract.

2. **`orientation.ts` and `ipad-region-detect.ts` are two iPad-letterbox
   detectors on purpose.** They serve different consumers with different
   tuning: `orientation.ts` (RGB-sum > 60, ≥10 content px/col, `lastGoodBounds`
   cache) drives the runtime cursor-positioning path; `ipad-region-detect.ts`
   (downscaled mean-RGB > 40, affine transform, native-margin inflation) drives
   the ML / calibration coordinate-transform path. Collapsing them would force a
   single threshold regime onto both consumers.

## Consequences

Merging either would require an N≥80 live iPadCollector re-bench to prove no
regression — the cost outweighs the ~small dedup. If a future change genuinely
needs one shared implementation, unify the *interface* (e.g. an explicit
`{ wakeCursor: boolean }` option, or a parameterised bounds threshold) rather
than silently adopting one variant's behaviour for all callers.
