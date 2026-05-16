# Phase 198 (v0.5.194) — honest n=10 baseline + Files lock-in still present

**Date:** 2026-05-10  
**Bench:** `npx tsx bench-click-extensive.ts 10` (40 clicks total)

## Numbers

| Target              | Hit rate | Median residual |
|:--------------------|:--------:|:---------------:|
| Settings            |   30%    |    138px        |
| Books               |   70%    |    104px        |
| AppStore            |   50%    |    274px        |
| Files               | **0%**   | **258.05px**    |
| **Overall**         | **38%**  |       —         |

The published reliability matrix (~50-60% small icons) was an
average. Per-target variance is wide:
- Books target consistently performs better than the matrix
  predicts (likely good cursor visibility against the gray icon
  area, far from animated widgets).
- Settings, AppStore, Files all underperform.
- Files is fully broken (0% on n=10).

## Files target lock-in IS BACK

9 of 10 Files trials reported residual 258.0484450641003 px —
EXACTLY identical to many decimal places. This is the same
deterministic false-positive lock-in pattern Phase 196 + 197
were designed to fix.

What's happening: the Phase 197 fix in `move-to.ts` returns null
when no template match within 200px radius. That works — trial 4
shows "moveToPixel: detect-then-move failed (motion-diff and
template-match both returned no cursor)" — Phase 197 IS firing.

But click-verify.ts:720's wake-and-recapture path STILL has the
lax fallback (Phase 197b was reverted because it regressed other
targets). So:

1. moveToPixel returns null (Phase 197 firing correctly).
2. Click-verify wake-and-recapture finds a feature at (X, Y)
   such that distance(X, Y, target) = 258.05 — the SAME widget
   feature every time.
3. `shouldAdoptSecondOpinion`: cursor was unverified initially,
   so adopt anything. Adopts the 258 px match.
4. cursorVerified now true with residual 258.05.
5. Click happens at predicted-position (still close to target).
6. Click misses because the cursor isn't actually at the target.
   (Earlier framing said "outside snap-zone of click landing";
   that mechanism is unverified — see REJECTED_CLAIMS.md. The
   simpler explanation: cursor was 258 px away, click landed
   somewhere else.)

The diagnostic message "All 4 attempts clicked with verified
cursor but no screen change — likely iPadOS pointer-effect
snap-zone miss" is WRONG for these trials. The cursor wasn't
actually at the target; it was on a Calendar/Maps widget feature
258 px away. (Separately, the "pointer-effect snap-zone miss"
hypothesis itself is on the REJECTED_CLAIMS.md list and should
not be quoted as a confirmed mechanism.)

## Why Phase 197b regression happened

When I tried Phase 197b (apply requireWithinRadius to wake-
recapture), the n=5 bench showed Books 100→40, AppStore 60→0.
That regression wasn't sample noise — the wake-recapture's lax
fallback was actually doing useful recovery work for some
non-Files targets.

The right fix needs to be MORE SURGICAL than blanket rejection:
- Only reject the wake-recapture match if it's clearly not in
  the cursor's plausible region (e.g., > 300 px from target).
- Or: detect the "deterministic lock-in" signature (same X, Y
  across multiple frames + no movement with emits) and reject.
- Or: per-target search-window restrictions (don't let templates
  match into the top-right widget area when target is also there).

These are Phase 199+ candidates and need careful A/B testing.

## What's actually working

- Settings/Books occasionally hit at low residuals (24, 36, 38 px).
  The cursor IS being placed correctly some of the time.
- Phase 196 TTL successfully caught one cross-session
  contamination case earlier this session.
- Phase 197 in move-to.ts correctly returns null on the
  template-fallback path when no in-radius candidate exists.

## What's still broken

- Files target: 0% (deterministic false-positive lock-in via
  wake-recapture).
- Aggregate click rate (38%) sits below the published 50-60%
  matrix. Possibly the iPad's cursor-fade behavior has gotten
  worse over the day's many bench cycles, OR sample noise is
  larger than estimated.

## Recommended user-side action (unchanged)

Toggle **Settings → Accessibility → Touch → Pointer Control →
Pointer Animations OFF** on the iPad. Predicted lift to ≥ 90%
on small icons.

## Project state at v0.5.194

- 673/673 tests pass
- Nix build green
- Working tree clean
- All commits pushed
- Phase 196 (TTL) + Phase 197 (requireWithinRadius in move-to)
  are kept
- Phase 197b (requireWithinRadius in click-verify) was tried
  + reverted with documented measurement
- Files target remains the most concrete remaining bug — needs
  surgical wake-recapture filter (Phase 199+)
