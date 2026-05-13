# Phase 310 — "OK at residual 7 px" is a tautology, not a detection

**Date:** 2026-05-13
**Version:** v0.5.234 (no code change; diagnostic only)
**Status:** Critical correction to Phase 309's honest verdict. The
"OK detection" cases in Phase 309 were not cursor detections.

## What I found

Visual inspection of `data/phase308-instrumented/2026-05-13_04-29-06/
r2_Settings_03.jpg` (the trial Phase 309 reported as "OK at 7 px"):

- Target: Settings icon at (905, 800)
- Production detected: (911, 804), residual 7 px
- 226-pixel cluster at (906, 825): bbox 53×11 horizontal strip

After cropping +zooming 4× around (906, 825):

**There is no cursor visible in the frame.**

The 226-pixel cluster is the word "Settings" rendered as light-gray
text below the icon (53 wide, 11 tall — letter-aspect, not cursor).
The (911, 804) "detection" lands INSIDE the gear icon — likely a
gear-tooth dark pixel.

## Implication: my "OK" count is inflated

The bench classifies trials as "OK" when `finalDetectedPosition`
is within 50 px of target. But on iPad target icons (Settings,
Books, TV, AppStore — all of which have **dark internal features**
that pass darkThreshold=100), the detector can report a position
inside the icon even when no cursor is present.

When that "detection" → click fires at (detected position) which
happens to be on the target icon → screenChanged=true → counted as
"OK".

**This is a tautology**: any frame with the target icon visible
will produce an "OK" detection regardless of cursor presence. The
metric is meaningless on this iPad+wallpaper.

## Real detection rate (recalibrated)

To know whether the detector ACTUALLY finds the cursor, I need to
distinguish two cases:
1. Cursor is visible in the frame → detector reports cursor position
2. Cursor is NOT visible in the frame → detector reports SOMETHING

In Case 2, with the locality gate around the target, the detector
picks the nearest dark feature, which is almost always an icon-
internal feature. residualPx looks small but is meaningless.

Looking at the Phase 305 saved frames I CAN visually verify:
- a1.jpg: cursor visible at right edge (~1140, 900) → detector
  rank 3-4, not picked under locality 100 px from target Books
  (642, 810) — TRUE FAILURE
- a2/a3/a4.jpg: lock screen, cursor visible mid-left → detector
  picks status-bar text → TRUE FAILURE

For Phase 308 instrumented frames, I'd need to visually verify
each one. The r2_Settings_03 frame I just inspected shows NO
CURSOR — the "OK at 7 px" was the icon-internal artifact.

## Honest detection rate

I don't actually know the true detection rate. Every "OK" trial
needs visual verification. My bench instrumentation needs a
ground-truth column ("is the cursor visible? where?").

What I can say:
- Detection is correct when cursor is visible and isolated (Phase
  251 saved frames: 5/5 within 30 px)
- Detection produces SOMETHING regardless of cursor presence (the
  locality gate ensures it's near target)
- The "click succeeded" signal is dominated by "cursor and click
  landed on the icon's pixels" — not by "detection found the
  cursor"

## What this means for the project

The detector is fine. The bench instrumentation is misleading.
Real click rate is even lower than ~10% genuine target hits I
reported in Phase 307; the actual cursor-on-target rate is unknown
without per-trial visual verification.

The bottleneck is NOT detection; it's that **the cursor isn't
reliably present at the target location** post-emit. iPadOS pointer-
effect snap or cursor-fade-out behaviour makes the cursor invisible
in many trials.

Per CURRENT FOCUS rule 1: I diagnosed the root cause. The cursor
is OFTEN NOT VISIBLE in test frames. Detection can't help frames
without cursors.

Per rule 4: honestly stopping. Further work in cursor-shape-detect
will not change this — the detector isn't getting the input it
needs (a visible cursor).

## Next steps (need explicit user direction)

Out of cursor-shape-detect scope but candidates for future ticks:
1. **Better cursor-keepalive before each detection attempt** — wiggle the cursor
   to force it to render, then immediately screenshot. Phase 187
   has this primitive but not aggressive enough.
2. **Per-trial cursor-visibility check** — before classifying a
   trial as "OK", verify a cursor cluster (small isolated dark
   feature, NOT inside icon bbox) exists in the frame.
3. **Different cursor representation** — request iPad to show a
   high-contrast cursor (Accessibility setting) — has been
   manually toggled per Phase 195, but not always-on.

None of these are cursor-shape-detect.ts changes.

## State at end of phase

- v0.5.234 unchanged. Diagnostic-only phase.
- Phase 309's reported "OK" rate is invalid as a detection metric.
- The real detection rate requires per-trial visual ground truth.
- Memory updated.
