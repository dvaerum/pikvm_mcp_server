# D1 — bench pre-click state verification

## Verdict

**Bench premise is partially broken.** Pre-click state IS the
iPad home page 1 with the expected icons visible. But the
hard-coded Files target coordinate `(1180, 800)` is wrong — it
lands in the empty area to the right of the page-1 icon grid,
nowhere near any Files icon. Settings `(905, 800)` and Books
`(640, 800)` are roughly correct (≈≤10px off icon center).

## Method

`bench-d1-pre-click-state.ts` — for each (target, trial), run
`ipadGoHome()` + 900ms settle, then save the screenshot. No
click attempted.

Ran 3 targets × 3 trials = 9 frames into `data/d1/`.

## Frame classification (n=9)

All 9 frames: **HOME page 1** with the standard wallpaper, the
weather/calendar/maps widgets in the top half, and the icon grid
+ dock in the bottom half. Page indicator at bottom shows
`•·` (page 1 of 2). `ipadGoHome()` is reliable — that part of
the bench setup works.

## Actual icon positions on page 1

Measured from the saved frames (1680×1050 full-frame coords,
iPad letterbox is approx left=515, right=1165, top=50,
bottom=1010):

| App      | Approx center | Bench target | Δ (px) |
| -------- | ------------- | ------------ | ------ |
| Settings | (905, 808)    | (905, 800)   | 8      |
| Books    | (642, 808)    | (640, 800)   | 8      |
| **Files**| **(1037, 425)** | **(1180, 800)** | **~370** |
| FaceTime | (905, 425)    | —            | —      |
| Maps     | (1037, 550)   | —            | —      |
| TV       | (775, 808)    | —            | —      |

Files at `(1180, 800)` is OUTSIDE the page-1 icon grid (x=1180
is right of the rightmost icon column at x≈1037) AND wrong row
(y=800 is the bottom row; Files-on-page-1 is in row 2 at
y≈425). The dock also has Files at approx (1130, 960) but that's
also not at y=800.

## Why this matters

Tapping at `(1180, 800)` lands in empty wallpaper to the right
of the icon column at y=800. On iPadOS, a click+small-drag in
empty home-screen wallpaper triggers a page swipe (page 1 →
page 2, or page 2 → App Library). That explains:

- Why every Files "HIT" in the v0/v1 bench opened App Library or
  page 2 — those are the natural swipe-destinations from
  `(1180, 800)`.
- The same problem may also explain some Settings/Books misses
  if the cursor was even 30-50 px off icon center (click in
  empty wallpaper → swipe).

## Action

1. Fix Files coordinate to (1037, 425) (page-1 row 2, column 4),
   or to the dock-rightmost Files icon if that's what's intended.
2. Optionally widen the on-icon tolerance for Settings/Books:
   the icons appear ~70-90 px wide so a click within ±35 px of
   icon center should still hit. But: even 30 px off could
   trigger a wallpaper swipe rather than just being "close but
   no app open."
3. Re-run the v0/v1 A/B with corrected coordinates to get a
   real signal on the ML retrain's effect on click rate.

## Skipping D1d

D1d (fix go-home) is not needed — go-home is fine. The bug is
target coordinates, not iPad state. Proceeding directly to D2
after fixing Files coordinate.
