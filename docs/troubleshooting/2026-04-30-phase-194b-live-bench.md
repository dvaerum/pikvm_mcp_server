# Phase 194-B live click bench (v0.5.188, 2026-04-30)

**TL;DR.** The dark-cursor `looksLikeCursor` fix shipped in Phase 194-B
(v0.5.188) lets `maybePersistTemplate` actually persist cursor
templates on this iPad. Templates dir went from 0 to 5 templates
during a 40-trial bench. Median residual on hits dropped 4-5×
(Settings 152 → 30 px, Books 143 → 37 px). Reported success rate
is statistically unchanged (55 % vs 57 % prior bench) because the
click-landing bottleneck remains the iPadOS pointer-effect
snap-zone (Phase 111-117).

## Setup

Identical to the Phase 193-C bench (10 trials × 4 small-icon
targets, verify region 100×100 around target,
`minChangedFraction=0.05`). The only deltas vs Phase 193-C:

- v0.5.188 (Phase 194-A + 194-B) deployed via tsx runner
- `data/cursor-templates/` wiped before run

## Results

```
Target                               | hit rate | first-hit attempts | median residual
-------------------------------------+----------+--------------------+------------------
Settings (small icon, badge)         |    70 %  | 1:2 2:3 3:1 4:1    |          30 px
Books (small icon)                   |    60 %  | 1:4 2:1 4:1        |          37 px
App Store (small icon)               |    60 %  | 1:4 3:1 4:1        |          96 px
Files (small icon, top-right)        |    30 %  | 1:1 2:1 3:1        |         285 px

Overall: 22/40 (55 %)
```

## Median-residual delta vs Phase 193-C bench

| Target    | Phase 193-C | Phase 194-B | Delta            |
|:----------|------------:|------------:|:-----------------|
| Settings  |      152 px |       30 px | **−80 %**         |
| Books     |      143 px |       37 px | **−74 %**         |
| App Store |      150 px |       96 px | **−36 %**         |
| Files     |      245 px |      285 px | +16 % (regressed) |

The first three targets show dramatic improvement in algorithm-
reported cursor accuracy. Files target persists at high residual
— specific to top-right targets, deserves its own diagnosis
(possibly bounds-aware refusal in micro-correction is firing
prematurely near the right edge).

## Templates persisted during the bench

Five templates wrote to `data/cursor-templates/`:

```
8341956148.jpg  (Settings trial 1)
8342364217.jpg
8342403647.jpg
8342619924.jpg
8342969257.jpg  (clear cursor arrow, post-bench inspection)
```

Visual spot-check of `8342969257.jpg`: clear dark arrow cursor on
light teal wallpaper background — exactly what the dark-cursor
path was added to admit. Phase 194-B's gate is working.

## Reported success rate didn't lift

Phase 194-B improved DETECTION (smaller residuals, real templates
persisted, template-match now functional). It did NOT lift the
reported `screenChanged`-positive rate, which sits at 55 % —
same statistical band as prior 57 %.

This matches Phase 111's documented finding: there's a hard ~50–60 %
per-attempt ceiling on small-icon clicks on iPadOS, driven by the
pointer-effect snap zone rejecting clicks even with cursor
visually on the icon. Phase 194-B confirms the ceiling is NOT a
detection-quality artefact — it's intrinsic to iPadOS.

## Visual sample of "hits"

| Trial | Reported | Residual | Visual verdict |
|:--|:--|--:|:--|
| Settings 05 | HIT | 23 | **FALSE** — home screen, Settings did not open |
| Books 09    | HIT | 27 | **FALSE** — home screen, Books did not open |

Even at 23–27 px residual (cursor visually on the icon), the
click failed to launch the app. iPadOS's snap-zone rejects click
events that the rendered cursor position would otherwise hit.

## What this leaves on the table

The remaining click-rate lift opportunities are NOT detection
fixes:

1. **Pre-click hover dwell + re-aim**. Hover the cursor at the
   target for 500–800 ms BEFORE the click, allowing iPadOS's
   pointer-effect to magnetically snap the cursor onto the icon.
   Currently `preClickSettleMs = 80` ms is too short. Risk: long
   dwell may trigger iPadOS pop-up or auto-fade; needs careful
   tuning.
2. **Click without prior cursor reveal**. iPadOS may treat clicks
   from "fresh" mouse activity differently. Try emitting a wake
   wiggle, then immediately clicking, without a stationary
   pre-click frame.
3. **Retry strategy**: Phase 192-D belief-driven unstick already
   addresses pinned-cursor retries. Could extend to "click missed
   icon" detection: if 2 retries fail with residual < 50, abandon
   and recommend Spotlight launch (`pikvm_ipad_launch_app`).
4. **Files target diagnosis**. The 245–332 px residual is not
   normal. Trace one Files trial frame-by-frame.

## Files referenced

- Bench script: `bench-click-extensive.ts`
- Bench output: `data/click-bench/{settings,books,appstore,files}/NN-{hit,miss}.jpg`,
  `data/click-bench/results.jsonl`
- Templates persisted: `data/cursor-templates/*.jpg` (5 files)
- Per-step trace bench: `bench-click-trace.ts`
- Phase 194-B regression tests:
  `src/pikvm/__tests__/looksLikeCursor.test.ts §
  Phase 194-B: ...`
