> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 197b (v0.5.194) — `requireWithinRadius` applied to click-verify wake-recapture path

**Date:** 2026-05-10  
**Files changed:**
- `src/pikvm/click-verify.ts` (line 718) — `findCursorByTemplateSet` now
  passes `requireWithinRadius: true` for the wake-and-recapture
  second-opinion path.

## What the v0.5.193 5-trial bench surfaced

After Phase 197 closed the false-positive in `move-to.ts`, a second
hole was visible in the JSONL output. Files-target trial 2:

```json
{"target":"files","trial":2,"success":false,"residual":239.00,
 "cursorVerified":true,
 "failureReason":"All 4 attempts clicked with verified cursor but no
   screen change — likely iPadOS pointer-effect snap-zone miss"}
```

> The `failureReason` string above asserts a "snap-zone miss"
> cause that is on the REJECTED_CLAIMS.md list as unverified.
> The observation (no screen change at 239 px reported residual)
> is real; the causal interpretation is not.

`cursorVerified: true` with residual 239 px (outside the 200 px
expectedNearRadius). Phase 197's fix in `move-to.ts` correctly
returned null there — but `click-verify.ts:720` had its own
`findCursorByTemplateSet` call (the wake-and-recapture path
introduced in Phase 139) WITHOUT `requireWithinRadius`. That call
returned the 239 px false-positive, Phase 140 found it "closer to
target" than the moveToPixel-reported predicted position (which was
worse), and adopted it as the verified cursor location.

Result: the cursor wasn't actually verified — it was a far-away
widget feature. (The "snap-zone miss" diagnostic the older code
emitted asserts a mechanism on the REJECTED_CLAIMS.md list.)

## Fix

Single-line addition to the wake-recapture call:

```ts
const woken = findCursorByTemplateSet(wakeDecoded, sessionTemplates, {
  minScore: 0.7,
  expectedNear: target,
  expectedNearRadius: 200,
  requireWithinRadius: true,  // <-- Phase 197b
});
```

Now wake-and-recapture returns null (instead of a far-away
match) when no candidate is within 200 px of target. Phase 140's
"adopt only if closer to target" check then has nothing to adopt,
and `cursorVerified` reflects what moveToPixel reported.

## Why this is safe

- Same opt-in pattern as Phase 197 in `move-to.ts`.
- Phase 140's existing logic correctly handles the null case
  (no second-opinion adoption).
- Existing 673 tests pass.
- Failure messages will be more accurate: "click missed but no
  cursor verified" instead of "verified cursor but click didn't
  register". (The latter diagnostic was historically labelled
  a "snap-zone" miss; that label asserts an unverified mechanism
  — see REJECTED_CLAIMS.md.)

## Live measurement (v0.5.194) — REVERTED after measured regression

5-trial × 4-target bench at v0.5.194 (Phase 197b applied):

| Target              | v0.5.193 (n=5) | v0.5.194 (n=5) | Delta |
|:--------------------|:--------------:|:--------------:|:-----:|
| Settings            |     80%        |     60%        | -20pp |
| Books               |    100%        |     40%        | -60pp |
| AppStore            |     60%        |   **0%**       | -60pp |
| Files               |    **0%**      |    40%         | +40pp |
| **Overall**         |   **60%**      |   **35%**      | -25pp |

Files improved as predicted (0% → 40%), but Books and especially
AppStore collapsed. AppStore residuals were deterministic at 119px
on 4/5 trials — the same lock-in pattern Files used to have, just
at a smaller distance.

Aggregate dropped 25pp. Net negative. Reverted.

## What this teaches

The wake-and-recapture path in `click-verify.ts:720` was doing
real recovery work on some misses. Phase 140's "adopt only if
closer to target" filter was already doing useful work even on
far-away matches. Returning null from wake-recapture cut off that
recovery without a corresponding gain.

The Files improvement WAS real — Phase 197b broke the false-
positive lock-in for Files. But that target gain was offset by
losing the wake-recapture's recovery contribution on the other
targets where it was helping.

A future version of this fix would need to be more surgical:
- Only apply `requireWithinRadius` when the moveToPixel-reported
  position is ALREADY close to target (i.e., trust prediction over
  far-away match only when prediction is plausible).
- Or: tighten the radius (200 → 100) so AppStore's 119 px
  deterministic match also gets rejected.
- Or: add a new heuristic — REJECT a candidate if the algorithm
  reports the same position to within 5 px on multiple
  consecutive frames AND that position never moves with emits.
  That's the "stuck on a wallpaper feature" signature.

## Final state

Reverted to v0.5.193's wake-recapture behavior at v0.5.194. The
Phase 197 fix in `move-to.ts` is RETAINED — it broke the Files
deterministic lock-in without regressing other targets.

The revert is preserved as a comment in the code so future
attempts know the bench data they need to beat.
