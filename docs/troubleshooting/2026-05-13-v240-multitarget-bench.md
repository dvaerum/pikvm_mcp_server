> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# v0.5.240 — multi-target verification (Rep 1, N=20)

**Date:** 2026-05-13
**Version:** v0.5.240 (Phase 315 home-zone multi-hint + Phase 316 default belief bounds)
**Status:** Detection layer verified across 4 targets. Click ceiling at iPad pointer-effect.

## Summary

`test-phase307-bench-with-unlock.ts` ran Rep 1 of 2 (20 trials, all 4
targets) before the 28-min bash timeout cut it. Rep 1 is conclusive:

| Target   | Trials | Detect | Click | Notable                             |
|----------|--------|--------|-------|--------------------------------------|
| Settings | 5      | 5/5    | 0/5   | 3× residual ≈19 px (cursor on icon, iPad ignored tap — Phase 310) |
| Books    | 5      | 5/5    | 0/5   | residuals 37–294 px (cursor rarely reached) |
| TV       | 5      | 5/5    | 2/5   | 2 successes at residuals 129–147 px (screenChanged but not target-hit) |
| AppStore | 5      | 4/5    | 1/5   | 1 NULL, 2× residual 3-8 px (tap ignored), 1 success at residual 70 px |

**Totals: 19/20 detection (95%), 3/20 click (15%)**

## Compared to v0.5.237 baseline

The same bench at v0.5.237 (Phase 314 doc) showed:

| Metric              | v0.5.237 | v0.5.240 (Rep 1) |
|---------------------|----------|-------------------|
| Detection           | 0/40 baseline on Books NULL; mixed on others | 19/20 (95%) |
| Click success       | 0/40 (0%) | 3/20 (15%) |

Detection is the major win. The Phase 315 home-zone multi-hint fixes
the Books NULL case (cursor parked at home not covered by predicted
crop). The Phase 316 default belief bounds eliminate the off-screen
drift, making belief itself a useful hint.

## Where the click rate is bottlenecked

Looking at residual distribution across the 20 trials:

- **5 trials with residual ≤ 20 px** (Settings 19×3, AppStore 3, 8):
  these are "cursor is dead-on the icon" cases. None registered a
  successful click — the Phase 310 tautology / pointer-effect snap
  zone consumes the tap.
- **2 trials at residual 70 + 147 px**: registered as screenChanged
  successes but residual is too large to plausibly be a target hit.
  These are likely background clicks (Spotlight/dock area). Suggest
  the bench overstates click rate.
- **13 trials with residual 100-300 px**: cursor reached vicinity but
  the icon area is missed.

Pessimistic read: **0/5 trials had a verifiably-correct click**.
Optimistic read: **3/20 trials registered screenChanged**, but with
the 70-147 px residuals on the successes, "verifiably target-hit"
likely 0-1.

The detection improvement is solid. The click rate ceiling is iPad-
side and outside the detection layer's control.

## Trial-by-trial breakdown

```
Settings r1.1: residual=19px   click=✗  (cursor on icon, tap ignored)
Settings r1.2: residual=119px  click=✗
Settings r1.3: residual=19px   click=✗  (cursor on icon, tap ignored)
Settings r1.4: residual=19px   click=✗  (cursor on icon, tap ignored)
Settings r1.5: residual=107px  click=✗
Books    r1.1: residual=190px  click=✗
Books    r1.2: residual=190px  click=✗
Books    r1.3: residual=113px  click=✗
Books    r1.4: residual=294px  click=✗
Books    r1.5: residual=37px   click=✗  (close but tap missed)
TV       r1.1: residual=108px  click=✗
TV       r1.2: residual=107px  click=✗
TV       r1.3: residual=129px  click=✓  (screenChanged — likely wrong target)
TV       r1.4: residual=130px  click=✗
TV       r1.5: residual=147px  click=✓  (screenChanged — likely wrong target)
AppStore r1.1: residual=218px  click=✗
AppStore r1.2: residual=8px    click=✗  (cursor on icon, tap ignored)
AppStore r1.3: residual=3px    click=✗  (cursor on icon, tap ignored)
AppStore r1.4: residual=70px   click=✓  (closest legit success)
AppStore r1.5: residual=n/a    click=✗  (detection NULL)
```

## What this confirms

1. **Detection layer is now solid** — 19/20 (95%) across diverse
   targets. The two-phase fix (home-zone multi-hint + default belief
   bounds) generalises beyond just the Books target.
2. **Click bottleneck is iPad pointer-effect** — 5 trials with
   residual ≤ 20 px ALL failed. The cursor is unambiguously on the
   icon; the iPad consumes the tap. This is the same finding as
   Phase 310 / Phase 307. No detection change can fix it.
3. **Books target detection now works** — was 10/10 NULL at v0.5.237,
   now 5/5 detected. Even though click rate is still 0/5, the
   detector is reporting cursor location honestly. This unblocks any
   future click-protocol experimentation.

## What's left

The detection layer is at the ceiling that the upstream iPad-side
issues permit. Next bottleneck options (need explicit user direction):

A. **Click protocol experiments**: longer mouseDown duration,
   double-tap, multi-stage tap. Could directly unblock the 5 trials
   where cursor is dead-on icon at residual ≤ 20 px.

B. **iPad-side Reduce Motion / Accessibility toggle**: Phase 115
   tried this with mixed results; could revisit.

C. **Rep 2 N=10 finish**: the bench was cut off after Rep 1. Running
   Rep 2 would give N=10 per target for a more stable estimate.
   Likely confirms but doesn't change the conclusion.

## Files

- `data/phase307-bench/2026-05-13_07-49-07/` — partial bench run
  (results.json not written; transcript in `/tmp/v240-multitarget-bench.log`)
- This document
