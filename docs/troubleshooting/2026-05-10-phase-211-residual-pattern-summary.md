# Phase 211 — residual pattern reveals false-positive cluster lock-in

**Date:** 2026-05-10
**Test:** `npx tsx test-residual-pattern.ts` — 10 trials of `moveToPixel`
to (905, 800) Settings target, log each detected cursor.

> **PARTIALLY SUPERSEDED by Phase 214 (2026-05-10).** This doc
> attributes the deterministic clusters at (949, 795), (970, 771),
> (972, 772) to "false-positive cluster lock-in" on UI features —
> but Phase 214 found those measurements were taken against the
> **App Switcher** (not the home screen) because `pikvm_ipad_home`
> (Cmd+H) doesn't dismiss the App Switcher. The clusters coincide
> with the Weather widget animation in App Switcher tile previews,
> not stationary UI false-positives. Phase 212's stationary-cluster
> rejection (which this doc inspired) still ships as a correct
> safety mechanism, but the framing about "static UI features" is
> wrong. See:
> - `2026-05-10-phase-214-app-switcher-root-cause.md` — methodology fix
> - `2026-05-10-phase-212-stationary-cluster-rejection.md` — what shipped

## Data

| trial | detected cursor | dx (= det.x - target.x) | dy | residual |
|:-----:|:---------------:|:----------------------:|:----:|:--------:|
| 1 | (949, 795) | +44 | -5 | 44.3 |
| 2 | (970, 771) | +65 | -29 | 71.2 |
| 3 | (972, 772) | +67 | -28 | 72.6 |
| 4 | (972, 772) | +67 | -28 | 72.6 |
| 5 | (907, 872) | +2 | +72 | 72.0 |
| 6 | (970, 771) | +65 | -29 | 71.2 |
| 7 | null | — | — | — |
| 8 | (949, 795) | +44 | -5 | 44.3 |
| 9 | null | — | — | — |
| 10 | (errored before slam fallback could trigger) |

## Three deterministic clusters

- **Cluster A** at (949, 795) — appears 2x (t1, t8)
- **Cluster B** at (970, 771) — appears 2x (t2, t6)
- **Cluster C** at (972, 772) — appears 2x (t3, t4)
- One outlier at (907, 872) — possibly the real cursor

The same exact pixel coordinates repeating across trials = the
algorithm is locking onto STATIC screen features, not the actual
cursor.

## Why the safety gates work but click rate is still 0%

- maxResidualPx=35 (Phase 88) skips clicks with residual >35
- All 8 valid trials had residual 44-73 (= all skipped)
- 0 wrong-element clicks (good)
- 0 correct-element clicks (no surprise — algorithm doesn't actually
  know where cursor is)

## Why bias correction won't help

If we pre-compensated by `target - mean_bias_vector`:
- Mean (dx, dy) ≈ (+50.6, -7.4)
- Aim at (905-51, 800-(-7)) = (854, 807)
- Cluster A would land at residual ~7 px (would hit!) but
- Cluster C would land at residual ~80 px (worse than before)
- Outlier t5 would be even further from target

Clusters are at FIXED pixel positions on the iPad UI. Moving the
cursor's TARGET around doesn't change where the false positives
appear — they're tied to specific UI elements (icon edges, letter
glyphs in app names, etc.).

## Why we've hit a real ceiling

Phase 206 showed each `mouseMoveRelative` call moves the cursor
~52 px on x-axis regardless of mickey count. With cumulative
variance over 4-8 calls, ~50-70 px residual is the physical floor
for HID-mouse positioning on this iPad.

To get below 35 px residual reliably, we'd need either:
1. **Smaller per-call displacement** — possibly via slowing the
   mouse acceleration on iPadOS side (user-side toggle)
2. **iPadOS Pointer Animations OFF** (Phase 194-H) — changes the
   snap-zone behavior so clicks register on icons even at 50 px
   residual
3. **Different input mechanism** — touchscreen HID (Phase 31 found
   this dead-end), gamepad HID (Phase 188 deferred)

All three require user-side action or substantial protocol work.

## Real fixable opportunity: stationary-cluster rejection

The strongest signal in this data: **same (x, y) detected across
multiple attempts within one clickAtWithRetry**. If attempts N and
N+1 detect cursor at literally the same pixel after the algorithm
emitted a correction move, that's a static feature, not the cursor.

Implementation: cursor-belief module already has `lastUpdateMs`
and a `position` field. Add a `detectionHistory` array — if 2
consecutive observations are within 5 px AND a non-zero emit
happened between them, reject the second observation as static-
feature lock-in and force motion-diff fallback.

This is a design change of moderate scope. Phase 212+ candidate.

## State at v0.5.199

- Diagnostic test scripts in repo:
  - `test-click-newest.ts` — single click via newest src/
  - `test-cursor-actual-vs-reported.ts` — visual gap inspector
  - `test-residual-pattern.ts` — 10-trial systematic measurement
- All commits pushed
- Cron `31e540a7` running every 15 min with standing instructions

## Honest current capability

- ✅ `pikvm_ipad_unlock` (Phase 210 Space-key first)
- ✅ `pikvm_ipad_launch_app` (Spotlight, 100% reliable)
- ✅ `pikvm_ipad_home` / Cmd+H
- ✅ Sidebar / large-button clicks
- ❌ Small-icon `pikvm_mouse_click_at` — 0-15% correct-element rate,
  bottlenecked by iPad's per-call displacement cap and false-positive
  cluster lock-in. Safety gate prevents wrong-element clicks (good).

The keyboard-first workflow is the recommended path until a
user-side fix (Pointer Animations OFF) or a major detection
overhaul is implemented.
