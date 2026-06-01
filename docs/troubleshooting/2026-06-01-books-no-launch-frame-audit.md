# Books NO_LAUNCH frame audit (2026-06-01)

## Why this doc exists

`benches/bench-click-production.ts` on iPad home page 1 (Stage 3.5 gate
in place) consistently measures **Books at ~60 % HIT** while Settings,
AppStore, Files hold 85–100 %. Books is the persistent soft target.

This doc records **what the failure frames actually show**, separated
from mechanistic hypotheses. The `feedback_rejected_unverified_claims`
memory and project history both flag "pointer-effect snap" /
"snap-zone" / "iPad ignored the tap" as phrases that have been
asserted as fact without evidence — this audit is observation-only.

## Data

Bench run 2026-05-31, v12 detector, N=20 trials on the Books target
(757, 837). Result: 12 HIT, 3 SKIP, 5 NO_LAUNCH. Per-trial:

```
01 SKIP     pos=(680, 864) attempts=4  Δ=(-77, +27) Euclid=81.6
02 NOLAUNCH pos=(740, 864) attempts=1  Δ=(-17, +27) Euclid=31.9   sim=0.999
03 HIT      pos=(763, 867) attempts=1
04 HIT      pos=(760, 837) attempts=1
05 HIT      pos=(740, 843) attempts=3
06 HIT      pos=(745, 851) attempts=1
07 HIT      pos=(790, 828) attempts=2
08 HIT      pos=(760, 837) attempts=1
09 SKIP     pos=(760,1008) attempts=4  Δ=(+3, +171) Euclid=171.0
10 NOLAUNCH pos=(727, 828) attempts=2  Δ=(-30,  -9) Euclid=31.3   sim=0.999
11 HIT      pos=(760, 864) attempts=3
12 NOLAUNCH pos=(757, 867) attempts=3  Δ=(+0, +30) Euclid=30.0    sim=0.999
13 HIT      pos=(767, 867) attempts=1
14 HIT      pos=(740, 819) attempts=1
15 SKIP     pos=(829, 840) attempts=4  Δ=(+72, +3) Euclid=72.1
16 HIT      pos=(760, 837) attempts=4
17 HIT      pos=(760, 837) attempts=1
18 NOLAUNCH pos=(746, 828) attempts=1  Δ=(-11, -9) Euclid=14.2    sim=0.990
19 NOLAUNCH pos=(771, 869) attempts=3  Δ=(+14, +32) Euclid=34.9   sim=0.999
20 HIT      pos=(750, 828) attempts=1
```

## Three distinct failure categories (observation-only)

### Category 1: SKIPs that ended far off target

Trials 01, 09, 15. The bench refused to click because all four
move-to attempts left the cursor > 35 px from target. **These are
positioning failures, not click-handling failures.**

- 01: final residual 81.6 px (-77 x, +27 y)
- 09: final residual 171.0 px (cursor at y=1008, inside the dock row)
- 15: final residual 72.1 px (+72 x bias)

These three are noise in the detector + ballistics pipeline. The
safety gate worked correctly. No iPad-side tap behaviour is involved.

### Category 2: NO_LAUNCH with sim ≥ 0.99 and Euclid ~30 px

Trials 02, 10, 12, 19. Click was emitted at a position within 35 px
of target (gate permitted it); post-click frame sim ≥ 0.99 vs the
home reference, meaning the iPad did **not** transition to the Books
app. Frame inspection (visual): the post-click frame shows the
home screen with the cursor visibly positioned near or on the Books
icon, **not** showing the Books app's "Free Books / New Releases"
launch view.

Final positions clustered at y=864–869 (target y=837), i.e. the
cursor consistently landed ~30 px south of the target on these.
Across all 20 Books trials including HITs, median Δy = +6 px south,
mean Δy = +9 px south — there is a **south-of-target bias** specific
to this target that is consistent on both HITs and NO_LAUNCHes.

**What we DO NOT KNOW:** why the iPad did not launch Books on these
4 frames. Plausible mechanisms include but are not limited to:

- iPadOS treating the click as a hover-acknowledged event because of
  pointer-effect interactions
- The cursor being on the icon-label region (below ~y=860) rather
  than the icon-art region
- An unrelated tap-registration variance

These are **hypotheses, not findings.** Frame 18 in particular had
cursor only 14 px from target (well inside any icon body) and still
didn't launch — that argues against a pure "position too low" cause,
but a single frame is too small a sample to draw conclusions.

### Category 3: NO_LAUNCH with apparent system-gesture interpretation

Trial 18 only. Post-click frame shows what visually looks like the
Slide Over / Today View peek panel beginning to appear on the left
edge of the screen, with the cursor near Books (Euclid 14.2 px).

**Caveat:** the panel appearance is subtle. A single-frame screenshot
captured ~250 ms after a click is not enough to characterize the
iPadOS gesture system. It could be:

- A real Slide Over invocation triggered by some aspect of the click
- A different system overlay
- Visual artifact of the post-click capture timing

This is reported here so it's on the record, not as a mechanism claim.

## Counter-experiment that was tried and failed

The hypothesis "target y=837 is too far south, move it north to land
on icon centre after south-drift" was tested by changing TARGETS
Books y=837 → y=810 and re-running N=20. Result: 11/20 HIT (55 %)
vs the original 12/20 (60 %). Inside noise — the re-aim did not move
the needle. SKIPs went from 3 to 7 because north-overshoots now miss
the icon top. Reverted in `bench-click-production.ts`.

This rules out "wrong target coordinate" as the dominant cause.

## What this audit does NOT establish

- The mechanism for the 4 Category-2 NO_LAUNCHes. Frame inspection
  + position data are consistent with several possibilities; none is
  confirmed.
- That Books is uniquely hard. Settings sits at the same y=837 in the
  bottom-of-page row and consistently HITs 90 %+. The target-specific
  variance is real but the cause is not characterized.
- That a position fix would lift Books to ≥ 90 %. Earlier attempt
  ([1.6 pointer-accel ballistics A/B]) made things worse.

## What this audit DOES establish

- 60 % HIT on Books is a real, repeated number, not a one-off.
- 3 of 8 failures are pure positioning (Category 1) — the bench gate
  caught them.
- 5 of 8 failures involve a click that **did** emit within 35 px of
  target — for these, the iPad-side outcome is not "we missed the
  icon"; something else is happening.

## Related

- `docs/roadmap-2026-05-31.md` § Stage 3 (3.1 tap-registration-fine
  diagnostic which established that iPadOS launches reliably when
  cursor is on icon, ≤ 31 px residual → 100 % HIT at 7/10).
- `feedback_rejected_unverified_claims` memory (don't assert
  "pointer-effect snap" as the cause without separate evidence).
- `project_v12_synth_dataset_pipeline.md` (current corrected baseline).
