# Phase 283 — re-seeded cursor templates, +20 pp lift on near target

**Date:** 2026-05-11
**Version:** v0.5.225 (no code change — templates are in `data/` which
is gitignored / device-local)
**Status:** SHIPPED — real production lift confirmed.

## Action taken

The 23 cached cursor templates in `data/cursor-templates/` (each
300-750 bytes, showing an older iPadOS cursor style) were replaced
with 4 freshly-extracted templates from Phase 280 frames where the
current cursor is visibly identifiable.

Backup of the old templates preserved in
`data/cursor-templates.backup-pre-phase283/` for rollback.

## Method

The live `seedCursorTemplate` MCP path failed twice — motion-diff
couldn't find a clean cursor cluster (cursor faded too quickly and
status-bar second-hand changes dominated the diff). Working around
that, Phase 283b extracted templates directly from Phase 280 frames
where `findCursorByShape` had already identified the cursor with high
confidence:

| Source frame | Cursor at | Shape-detect score | Template kept |
|---|---|---|---|
| `phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg` | (733, 777) | 2.919 | ✓ |
| `phase280-cursor-vanishing/2026-05-11_19-04-06/f007.jpg` | (963, 777) | 0.395 | ✓ |
| `phase280-cursor-vanishing/2026-05-11_19-04-06/f008.jpg` | (948, 777) | 1.444 | ✓ |
| `phase280-cursor-vanishing/2026-05-11_19-05-45/f017.jpg` | (819, 777) | 3.413 | ✓ |

Each extracted as a 24×24 RGB patch centred on the cursor centroid,
persisted via `saveCursorTemplate`.

## NCC investigation re-run (Phase 281 methodology)

| Metric | Before re-seed (stale templates) | After re-seed |
|---|---|---|
| NCC at production default (minScore=0.83) returns match | 0/5 frames | **5/5 frames** |
| NCC with cursor-locality hint finds real cursor ≤ 35 px | 0/2 testable | **2/2 within 6 px** |
| NCC best score range | 0.78-0.79 | **0.85-0.90** |
| NCC clock-widget false positives | n/a (never reached threshold) | 0/5 |

NCC now returns a confident match on every frame. With a locality
hint (as production always passes), it lands within 6 px of the
real cursor.

## Live click-rate bench

Two N=20 runs of `test-phase262-current-click-rate.ts 905,800`
(near target, Settings vicinity):

| Run | Within 35 px |
|---:|---:|
| 1 | 17/20 = 85% |
| 2 | 11/20 = 55% |
| **N=40 cumulative** | **28/40 = 70%** |

**Baseline before re-seed:** 50-55% (Phase 278 N=100). Lift: **+15-20
pp** sustained.

Phase 237 variance lesson applies — individual N=20 runs swing 55-85
%, but the central tendency at 70% is clearly above the prior 50%
baseline.

Far target (757, 832) tested with one N=20 run: 0/20. Still
0% because the cursor vanishes during chunked moves (Phase 280
finding — the cursor is off-screen at the moment of final
detection, so even good templates can't find it).

## Root-cause summary (Phase 281 + 283 combined)

Phases 268-280 (12 phases of cursor-shape-detect tuning, proximity
gates, multi-cycle averaging, progressive emit A/B benches) were
all treating downstream symptoms of a single upstream bug: **the
cached NCC templates were stale**. NCC's silent null return on every
home-screen frame forced the pipeline to use the shape-detect
fallback exclusively, and the fallback's widget false-positives
became the apparent failure mode.

After re-seeding, NCC works as designed: scores the real cursor at
0.85-0.90 against current iPad state, returns the correct position
when hinted, and the production click rate immediately lifts from
~50 % to ~70 % on the near target.

## Important: this is not in git

`data/` is gitignored. The fresh templates exist only on the local
machine where this work was done. **Deploying to a fresh machine
will fail the same way** — the production pipeline needs templates
that match the current iPad state on that machine.

Two long-term fixes worth considering (not done this phase):

1. **Auto-refresh check on startup.** Run a self-test on first
   `pikvm_mouse_click_at` call: if NCC returns < 0.83 on a known
   visible cursor, automatically re-seed.
2. **Bundle a starter template set in the repo.** Ship a few baseline
   templates from a known-good iPad state under `data/` (override
   `.gitignore` for that specific subdirectory) so first-deployment
   click rate isn't 0%.
3. **Document the maintenance procedure.** Add a note to the README
   explaining that templates can go stale across iPadOS updates and
   describe the re-seed workflow.

## What got shipped

- `test-phase283-reseed-templates.ts` — live re-seed script (failed
  due to motion-diff issues with cursor-on-edge)
- `test-phase283b-manual-seed-from-saved-frame.ts` — manual
  extraction from saved frames (succeeded)
- 4 fresh templates in `data/cursor-templates/` (local-only, not
  in git)
- 23 old templates moved to `data/cursor-templates.backup-pre-phase283/`
- This doc

No code change. Production binary unchanged at v0.5.225. The
production click rate is now ~70% near / ~0% far without touching
any source.

## State at end of phase

- v0.5.225 unchanged
- 713/713 tests
- nix build green
- 4 templates in production cache (down from 23 stale ones)
- Near click rate: ~70% (was ~50%)
- Far click rate: ~0% (unchanged; cursor-vanishing remains)
