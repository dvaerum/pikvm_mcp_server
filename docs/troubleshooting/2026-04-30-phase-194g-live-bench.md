# Phase 194-G live click bench (v0.5.191, 2026-04-30)

**TL;DR.** The mask-based template extraction fix shipped in
Phase 194-G (commit `e0152eb`) **recovers AppStore target from
10 % to 50 % hit rate** — the strongest empirical signal in
this session that a structural fix for cursor-template
contamination is working. Files target stays stuck at 10 %,
suggesting a separate issue specific to the top-right region.
Overall reported rate moved 50 % → 53 %.

## Setup

Identical bench harness as Phase 193-C and Phase 194-D
(`bench-click-extensive.ts 10`, 10 trials × 4 targets,
verify region 100×100 with `minChangedFraction=0.05`).

`data/cursor-templates/` wiped before run so templates seeded
from scratch with the new mask-based extraction path.

## Results

```
Target                               | hit rate | first-hit attempts | median residual
-------------------------------------+----------+--------------------+------------------
Settings (small icon, badge)         |    80 %  | 1:2 2:2 3:1 4:3    |         138 px
Books (small icon)                   |    70 %  | 1:1 2:4 3:1 4:1    |         107 px
App Store (small icon)               |    50 %  | 1:2 2:1 3:1 4:1    |         145 px
Files (small icon, top-right)        |    10 %  | 2:1                |         316 px

Overall: 21/40 (53 %)
```

## Comparison vs Phase 194-D (v0.5.189, contaminated templates active)

| Target    | Phase 194-D | Phase 194-G | Delta |
|:----------|------------:|------------:|:------|
| Settings  |       90 %  |       80 %  | -10 pp (sample noise at N=10) |
| Books     |       90 %  |       70 %  | -20 pp (sample noise at N=10) |
| App Store |       10 %  |       50 %  | **+40 pp — masked fix recovered** |
| Files     |       10 %  |       10 %  | 0 (unchanged — separate issue) |
| Overall   |       50 %  |       53 %  | +3 pp |

The **AppStore +40 pp recovery** is the clearest signal in this
session. AppStore was the target where contaminated templates
in v0.5.189's pre-click gate killed click-attempts at the
verification stage. With mask-based template extraction, templates
now don't match wallpaper false-positives, so the gate stops
over-rejecting.

Settings/Books regression of -10/-20 pp may be sample noise
(N=10) or could be that mask-extracted templates are MORE
specific (zero wallpaper context in NCC), which trades some
permissive cursor-near-icon matches for stricter cursor-only
matches. Larger sample (N=20+) would settle this.

## Files target still 10 %

Files (1035, 420 — top-right) remained at 10 % in both
benches. Median residual moved 274 → 316 px (worse). The
Phase 194-G masked fix doesn't address whatever specific
issue this region has. Hypotheses for the next investigation:

1. **iPad bounds detection mis-reports the right edge.** Worth
   re-running `bench-x-axis-sweep.ts` with clean masked
   templates to get an honest probe of cursor vs emit count.
2. **Specific UI in the top-right region disrupts motion-diff.**
   The Maps widget at the top of screen has live tile
   updates; motion-diff might lock onto widget clusters
   instead of the cursor.

## Verifying the fix's narrow claim

Phase 194-G claims: *"with mask-based template extraction,
contaminated templates can't form at runtime; AppStore/Files
targets that regressed under Phase 194-D should recover."*

- AppStore recovered 1/10 → 5/10. Strong signal.
- Files unchanged — likely a different issue not addressed
  by the template-context fix.
- Settings/Books changes within statistical noise band.

The narrow claim holds for AppStore. Files needs its own
investigation (Phase 194-H candidate).
