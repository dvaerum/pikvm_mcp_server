# Phase 215 — looksLikeCursor saturation gate too strict for tinted iPad cursor

**Date:** 2026-05-10
**Version:** v0.5.203
**Status:** Diagnostic + fix shipped. End-to-end bench still 0/10 (separate
issue — Phase 216 candidate).

## TL;DR

After Phase 214 reliably reaches the home screen (`forceHomeViaSwipe`),
`seedCursorTemplate` was rejecting the iPad cursor with reason
`looksLikeCursor rejected all candidate cluster(s)`. Visually the
cluster IS clearly a cursor — but on the home screen's teal/cyan
wallpaper, the cursor pixels are tinted by JPEG/anti-aliasing
bleed-through. Per-pixel saturation reaches 60-110, far above the
strict `sat <= 30` per-pixel achromatic gate.

Phase 215 raises the per-pixel `sat` gate from 30 → 80. The frame-mean
gate (`meanSat >= 50` → reject) now does the icon rejection: a real
cursor template (4-18 % cursor pixels over a masked-zero background)
has frame-mean sat ~30; a colored UI icon (entire 24×24 saturated)
has mean sat 80+.

After this fix, `seedCursorTemplate` succeeds on the home screen
and writes a real cursor template to disk. 691/691 tests still
green.

## Investigation steps

### Step 1: visual confirmation that the cursor is in the cluster

`test-phase215-diagnose-seed.ts` ran the seedCursorTemplate code
path inline and dumped the masked 24×24 templates as 240×240 PNGs.
Both clusters' templates clearly show a cursor arrow shape — but
in cyan/teal pixels, not grayscale.

Stats from the rejected templates:
- Cluster 0 (BEFORE position): brightness range [0, 200], meanSat 13.0
- Cluster 1 (AFTER position):  brightness range [0, 207], meanSat 6.6

The frame-mean saturations (13 and 6.6) are LOW because most pixels
are zeroed by the diff mask. But individual cursor pixels have
sat 60-110, so the per-pixel gate `cMin >= 100 && sat <= 30`
admits ZERO pixels into the bright blob, and the cohesion check
returns 0 — failed.

### Step 2: identify the per-pixel sat threshold as the real issue

Phase 56 (history) lowered `CURSOR_BRIGHTNESS_FLOOR` from 170 to 100
to admit dim iPad cursors. But the per-pixel `sat <= 30` constraint
was untouched. On a teal home-screen wallpaper, JPEG anti-aliasing
blends the cursor with the background, producing pixels with high
saturation — the cursor pixels become teal/cyan instead of pure
white/black.

Loosening the per-pixel sat gate to 80:
- Real cursor pixels (R~80, G~150, B~180) are admitted (sat ~ 100, just
  inside the new gate is 80 — actually they are filtered out, see
  note below)
- The frame-mean meanSat gate (50) still filters out fully-saturated
  multi-color icons because the entire template is saturated, not
  just 4-18 % of it

NOTE: 80 doesn't admit pixels with sat > 80. Some cursor pixels in
the live data had sat ~ 100. The fix is necessary-but-not-quite-
sufficient: it now admits more cursor pixels, but the strictest
ones still fail. The frame-mean check is the real defense; the
per-pixel check is becoming a soft pre-filter. Future tuning may
loosen further to 100+ if the meanSat gate is robust enough.

### Step 3: pre-positioning the cursor

The cursor was ALSO pinned at the right edge of the screen
(~1075, 65) after `unlockIpad` ended its swipe. The wake-emit
`+80 right` had no visible effect because the cursor was already
at the edge — the per-call cap saturated at the bound.

The bench script now slams the cursor to top-left then chunks an
emit toward the middle of the screen before calling
seedCursorTemplate. This pre-positioning is currently in the test
script; promoting it to a `seedCursorTemplate` option is a Phase
216 candidate (`prePositionToCenter: boolean`).

### Step 4: live verification

After the fix:
- `seedCursorTemplate` returns `ok: true, "Template added (1 total)"`
- The seeded 24×24 template visually IS the iPad cursor arrow
  (saved as `data/phase215b/02-template-0-10x.png`)
- 691/691 unit tests still pass (no regression)

End-to-end click bench still fails 0/10 because the moveToPixel
correction loop with `forbidSlamFallback: true` cannot recover
the cursor's position when motion-diff and template-match both
fail in the discoverOrigin probe phase. That's a separate issue
documented as Phase 216 candidate below.

## What changed in code (v0.5.203)

`src/pikvm/move-to.ts:577-578` — looksLikeCursor's per-pixel sat
gate raised 30 → 80 with explanatory comment.

`package.json` + `src/version.ts` — v0.5.203.

Diagnostic scripts (committed for future debugging):
- `test-phase215-diagnose-seed.ts` — rejected-template dumper
- `test-phase215-seed-with-reposition.ts` — bench with cursor
  pre-positioning

## Phase 216 candidate

The end-to-end bench still hits 0/10 even with a working template.
Symptom: `moveToPixel: detect-then-move failed (motion-diff and
template-match both returned no cursor)` for every trial.

The bench passes `forbidSlamFallback: true` (correct for iPad —
slam-to-corner triggers App Switcher hot-corner gesture). With slam
forbidden, `moveToPixel` does a `discoverOrigin` probe to find the
cursor. If the cursor faded between probe screenshots or the probe
emit's effect is below the per-call cap, the probe fails and
moveToPixel throws.

Possible Phase 216 directions:
1. Increase probe magnitude — emit larger nudge so the cursor
   visibly moves between probe pre/post frames
2. Use template-match on a single fresh screenshot to find the
   cursor (no probe needed) when a good template is available
3. Add `keepCursorAlive` to discoverOrigin's screenshots (Phase
   202 work) so the cursor is visible in both pre/post frames

Each of these is a moderate-scope code change. The Phase 215
unblocker (working seed + sat gate) is shipped; Phase 216 is the
next concrete win.

## Files in this commit

- `src/pikvm/move-to.ts` — looksLikeCursor sat gate 30 → 80
- `package.json` + `src/version.ts` — v0.5.203
- `test-phase215-diagnose-seed.ts` — diagnostic script
- `test-phase215-seed-with-reposition.ts` — bench with reposition
- `test-phase215-seed-and-bench.ts` — earlier bench (kept for
  future ref)
- `docs/troubleshooting/2026-05-10-phase-215-tinted-cursor-template-seeding.md`
  — this doc
