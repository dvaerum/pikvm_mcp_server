# Phase 199 (v0.5.194) — production-defaults bench reveals the published matrix overstates real reliability

**Date:** 2026-05-10  
**New file:** `bench-click-production.ts` — measures user-facing
behavior with production MCP defaults (requireVerifiedCursor=true,
maxResidualPx=35).

## What the production bench measured

5 trials × 4 small-icon targets (20 total) at v0.5.194:

| Target              | HIT | SKIP | MISS |
|:--------------------|:---:|:----:|:----:|
| Settings            | 1/5 | 4/5  | 0/5  |
| Books               | 0/5 | 5/5  | 0/5  |
| AppStore            | 0/5 | 5/5  | 0/5  |
| Files               | 0/5 | 5/5  | 0/5  |
| **TOTAL**           | **1/20** | **19/20** | **0/20** |

- **HIT rate: 5%** (1 successful correct-element click out of 20)
- **SKIP rate: 95%** (safety gate fired — caller gets clear error)
- **MISS rate: 0%** (no silent wrong-element clicks)

## Why the diagnostic bench reports much higher numbers

`bench-click-extensive.ts` reports 38-67% "hit rate" depending on
sample. That bench:
- Sets `requireVerifiedCursor: false` (clicks even when cursor
  unverified)
- Doesn't pass `maxResidualPx` (no skip gate)
- Counts "hit" as `screenChanged: true` in a 100×100 px window
  around the target

That counts wrong-element clicks as "hits". A click 80 px off the
target Settings icon that lands on the adjacent Books icon will:
1. Open Books (screen changes within the 100×100 window)
2. Get counted as a Settings "hit"

The Phase 134 bench (referenced in `defaultMaxResidualPxFor`) found
~73% of attempts have residuals 36-200 px = wrong icon or empty
area. The 35 px gate exists precisely to refuse those.

## What this means for the published reliability matrix

The README states "50-60% for ~70 px icon-sized targets". That was
based on screen-changed measurements. The CORRECT-ELEMENT click
rate is much lower — closer to 5-15% on this iPad with current
settings.

Production users calling `pikvm_mouse_click_at` on small iPad icons
get:
- ~5-15% correct-element clicks (varies by target, time, cursor state)
- ~85-95% explicit "Click skipped: residual NN px exceeds
  maxResidualPx=35" errors
- ~0% silent wrong-element clicks (the safety gate works)

This is GOOD for safety (no surprise wrong-clicks) but BAD for
ergonomics. The user has to retry or fall back to
`pikvm_ipad_launch_app` (Spotlight, 100% reliable).

## What's actually reliable

- `pikvm_ipad_launch_app` (Spotlight + type + Enter): 100%
- Sidebar rows / large UI: 95-99%
- Mid-size icons (≥120 px): 80-90%
- **Small icons (~70 px): ~5-15% correct-element via clicking**
  (vs. published "50-60% screen-changed")

## Recommendations

For users of the MCP server:

1. **For small iPad icons, USE `pikvm_ipad_launch_app`** instead
   of `pikvm_mouse_click_at`. This is the practical workflow.
2. If you must click an icon, expect SKIPs and have retry logic.
3. Toggle iPadOS Pointer Animations OFF (Settings → Accessibility
   → Touch → Pointer Control). Phase 194-H predicts ≥ 90% small-
   icon click rate after this.

For the README and skill prompts:

1. Distinguish "screen-changed rate" from "correct-element rate"
   in the reliability matrix.
2. Surface the production-defaults bench numbers as the
   user-facing reality.
3. Keep the diagnostic bench numbers for algorithm-internals
   reference.

## Why not just loosen maxResidualPx default?

Phase 134 measured: residuals 36-200 px land on WRONG icons or
empty areas. Loosening from 35 to e.g. 100 px would convert many
SKIPs to MISSes (wrong-element clicks). That would silently break
caller workflows that depend on hitting the intended target.

The current 35 px default is the correct safety floor. The hit
rate is bottlenecked on actual cursor-positioning accuracy, not
the gate's strictness.

## State at v0.5.194

- Production bench shipped (`bench-click-production.ts`).
- 673/673 tests pass, nix build green.
- Working tree clean, all pushed.
- The bench provides an honest user-facing baseline going forward:
  pre-Pointer-Animations-toggle, expect ~5% small-icon HIT, ~95%
  SKIP, ~0% MISS.
