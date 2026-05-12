# Phase 287 — diverse template re-seed: NO SHIP (hurt near, didn't help far)

**Date:** 2026-05-12
**Version:** v0.5.226 (no code change — templates revert to Phase 283 set)
**Status:** Attempted, measured, reverted.

## Hypothesis (from Phase 286)

Phase 286 found NCC locked onto (936, 766) score 0.876 for ~95% of frames — a Settings-vicinity wallpaper FP. The reason: my Phase 283 templates were extracted from frames where the cursor was over wallpaper *near* Settings, so those templates carry Settings-area wallpaper context. NCC matches that wallpaper anywhere on screen.

The user picked Fix 1 (diversify templates) over Fix 2 (widget blacklist). The hypothesis was: templates extracted from cursor positions across the iPad screen will average out the wallpaper context bias.

## What was tested

`test-phase287-diverse-seed.ts`: drove the cursor through 6 emit-relative positions across the screen, verifying cursor location with shape-detect's locality filter at each, extracted templates at the 3 positions where shape-detect found the cursor:
- `(1047, 646)` — right-side wallpaper
- `(770, 462)` — mid-screen between widgets
- `(783, 961)` — bottom-mid wallpaper / dock-row area

3 templates committed. Phase 283's 9 templates backed up to `data/cursor-templates.backup-pre-phase287/`.

## Live click-rate measurements

| Target | Phase 283 (9 templates, Settings-biased) | Phase 287 (3 templates, diverse) | Δ |
|---|---|---|---|
| Near (905, 800) | 70% (N=40) | **47.5% (N=40)** | **−22.5 pp** |
| Far (757, 832) | ~0% | **0% (N=20)** | unchanged |

Near-target click rate **decreased** by 22.5 pp. Far-target unchanged.

## Why diverse templates hurt near target

The Phase 283 templates scored 0.85-0.90 on near-target frames specifically because the cursor was over Settings-area wallpaper at those moments — and the templates were extracted from that same wallpaper. The high score wasn't from cursor-pixel match; it was from wallpaper-context match. Strong locality + strong wallpaper similarity = strong NCC score.

Diverse templates from different wallpaper backdrops each match the cursor weakly against the *wrong* wallpaper context. NCC scores drop to ~0.73 on f023 (Phase 280's near-target frame). That's below the production threshold 0.83, so NCC returns null and the pipeline falls through to shape-detect's noisy fallback — exactly the failure mode Phase 281 documented.

## Action taken

Restored Phase 283 templates from `data/cursor-templates.backup-pre-phase287/`. Live bench post-restoration: near target 60% (back in the Phase 283 variance band).

The Phase 287 script (`test-phase287-diverse-seed.ts`) and backup directory are preserved in case a future phase wants to revisit with a mask-based template extraction (Phase 106) that would limit NCC to cursor pixels only, eliminating the wallpaper-context coupling.

## What this teaches

1. **NCC scores depend strongly on wallpaper context**, not just cursor-pixel match. The 24×24 template region is ~70% wallpaper.
2. **Phase 283's Settings-biased templates are well-suited for near-target by accident** — the cursor's at-target position happens to land on the same wallpaper area the templates were extracted from. This is fragile (would break if iPad layout changed) but it's the current production reality.
3. **Far-target failures are NOT a template-bias problem.** Even diverse templates didn't help far-target. The deeper issue is detector-FP handling in dock/widget regions.

## Why Fix 2 (widget blacklist) is now more attractive

Phase 286 + Phase 287 together establish that:
- The cursor IS in the frame during far-target moves (Phase 286)
- Templates can't be made cursor-only without mask-based extraction (Phase 287 evidence)
- Shape-detect locks onto widgets at score 2.0-2.5; cursor over wallpaper scores 0.3-1.5

A widget-region blacklist would directly reject the clock/weather/calendar FPs at the detection layer, giving the cursor a chance to be the picked candidate even at score 0.3.

Not pursued without user direction.

## State at end of phase

- v0.5.226 unchanged (template revert only)
- 722/722 tests
- Templates: restored to Phase 283 set (9 files)
- Near target: ~50-70% (Phase 283 ceiling)
- Far target: ~0% (unchanged)
- Phase 287 script preserved for future mask-based revisit
