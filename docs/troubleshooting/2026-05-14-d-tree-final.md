> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# D-tree final — root cause of 0% live click rate

Date: 2026-05-14
Branch: main (D-tree investigation, post-v0.5.249 ML retrain)

## Bottom line

**It does not work.** Live correct-element-hit rate on the iPad
is 0% across 9 trials × 3 targets (Settings, Books, Files) on a
clean home-screen state. The cause is upstream of any cursor
detector: **the cursor is stuck in the dock zone at click time
and the algorithm cannot reliably move it elsewhere.** The
recent ML retrain (v0.5.249) is a real offline improvement but
makes no live difference because it never gets a chance to
detect a cursor that's reached the target.

## D-tree path taken

```
D1a → D1b → D1c → (skipped D1d, premise OK)
D1e (coord fix + rerun) → still 0% correct
D2a → D2b → D2c → "move-to broken"
(skipped D3a/D3b — HID test downstream of the actual bug)
D4 (this doc)
```

## D1 finding

iPad pre-click state was correct (HOME page 1 with all target
icons visible) on 9/9 trials. But the bench's hard-coded Files
coordinate was wrong — `(1180, 800)` is empty wallpaper, not the
Files icon at `(1037, 425)`. Fixed in D1e.

## D1e re-run with corrected coords

|         | v0 hits | v1 hits |
| ------- | ------- | ------- |
| Settings| 2/8     | 5/8     |
| Books   | 0/8     | 2/8     |
| Files   | 0/8     | 0/8     |
| **All** | **2/24=8%**| **7/24=29%** |

Visual inspection of all 9 of v1's "HITs": **0/9 actually opened
the intended target app.** Every "HIT" was a wrong-app open or
modal dismissal. The screenChanged metric remains broken.

## D2 finding

With `PIKVM_PREDOWN_DIR=...` instrumentation saving a screenshot
just before each `mouseClick` HID event, the cursor's actual
position at click time can be verified visually:

- Some attempts: cursor 200-500 px from target.
- Some attempts: cursor close but **in the wallpaper gap between
  icons** → click registers but doesn't open an app.
- Files target (row 2): cursor consistently stuck near `y≈877`
  in the dock area. The algorithm never reaches the upper rows.

**Cursor is stuck in the dock zone.** iPadOS pointer-effect
keeps snapping the cursor to dock icons; relative-mouse emits
don't overcome the snap.

This matches existing memory at `project_phase_291_far_target_root_cause.md`:
"stable dock-FP at (783,961) and clock-FP at (631,140); more
scoring tweaks won't help."

## D2c decision

The bug is **upstream** of the click HID event. There is no
point testing HID timing variations (D3a, D3b) when the cursor
isn't on the target icon at button-down.

The bug is also **upstream** of cursor detection. Even with
perfect detection (which v1 essentially gives us on small icons
in this session — Files target val pos ≈ 2.8 px median), the
algorithm needs to *move* the cursor to the icon. It can't,
because iPadOS keeps snapping it to the dock.

## Root cause — what's really happening

1. `ipadGoHome()` puts the iPad on home page 1 with the cursor
   somewhere near the bottom (per ipad-unlock.ts internals).
2. The algorithm starts moving toward the target.
3. Within the first few mickeys of motion, the cursor enters the
   dock zone (or stays there).
4. iPadOS pointer-effect snaps the cursor to a dock icon. The
   "hover halo" rendering glues the cursor to that icon.
5. Further emits don't escape the snap unless they're large and
   fast. The algorithm's small correction emits (5-10 mickeys at
   a time) are inside the snap deadzone.
6. The cursor remains stuck on or near a dock icon while the
   algorithm thinks it's been moving. detect-then-move sees the
   stuck cursor, re-emits, repeats.
7. Eventually maxRetries=3 hits, cursor is still in dock area,
   click fires at target coordinate while cursor is elsewhere
   → wrong-app open (whatever dock icon was nearest) or no-op
   (wallpaper gap).

## What does NOT fix this

- ML detector improvements (Phase 257-313, ML retrain v0.5.249):
  detection is not the bottleneck.
- Co-linearity / radial penalties (Phase 307, 311): scoring
  tweaks don't move the cursor.
- Click HID timing (downMs adjustments, Phase 145+): cursor
  isn't on icon when click fires.
- Pre-click in-motion approach (Phase 125): small approach
  emits are inside the snap deadzone.
- ipadGoHome variants (Cmd+H vs swipe vs Spotlight): all leave
  the cursor near the dock.

## What might fix it

Honest list, with the user's "mouse-first" preference noted:

1. **Larger one-shot emits** that exceed iPadOS snap deadzone.
   The Phase 30 slam-bottom-right was designed for this — emit
   so large the cursor blasts past any snap zone. The bench uses
   `forbidSlamFallback: true` to disable this, on the assumption
   that detect-then-move should work. Re-enabling slam-anchor
   recovery may unstick the cursor.
2. **iPad-side: disable pointer-effect snap.** AssistiveTouch +
   custom pointer style can disable the magnet behavior.
   Documented at Phase 56-58 area. Not user-side preferred.
3. **Different target geometry.** Click well above the dock
   (e.g. on the weather widget or row-2 app icons) — those
   targets don't have the dock-snap interference. This is a
   workflow change, not an algorithm fix.
4. **Touchscreen HID overlay.** Phase 31 explored this and
   marked closed. iPad sees PiKVM as a mouse, not a touchscreen.

## Verdict

- ML retrain (v0.5.249) is correct-shipped as the default model.
  Offline metrics confirm it works.
- Live click rate is bottlenecked by iPad pointer-effect snap-
  to-dock, not by any detector or move-to logic.
- The previously documented "50-60% reliability ceiling" for
  icon-sized targets (Phase 70, 111) was likely seen under
  conditions where slam-anchor was enabled. With
  `forbidSlamFallback: true`, the live rate collapses to ~0%.

## Recommended next move (not done)

Re-enable slam-bottom-right recovery for icon-sized iPad targets
behind an opt-in flag, re-run the v0/v1 A/B with slam enabled,
visually verify hit rates. If slam recovers the 50-60% number,
that confirms iPad pointer-effect snap is the live bottleneck
and slam is the only counter-measure.

Not making this change in this D-tree session — would re-open
the Phase 30/32/45 territory, which the user has already
deliberated on (slam triggers app-switcher gestures on some
targets, Phase 45).

