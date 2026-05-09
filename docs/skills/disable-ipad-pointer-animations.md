# Skill: disable iPad Pointer Animations

> **Purpose** — Verify and (if necessary) disable the iPadOS
> **Pointer Animations** setting that magnetically snaps the
> cursor onto nearby UI elements. With it ON, small-icon clicks
> via PiKVM cap at ~50–60 % per attempt (Phase 111). With it
> OFF, clicks land where the cursor actually is and reliability
> jumps. Phase 194-H identified this as the user-side lever.

## Setting location

**Settings → Accessibility → Touch → Pointer Control →
Pointer Animations** (toggle should be OFF).

On older iPadOS (< 17) the path is **Settings → Accessibility →
Pointer Control → Pointer Animations**.

## Verified procedure

The following is a sequence that **partially worked** on this
PiKVM/iPad (iPadOS 26.1, Sat 9 May 2026) — Settings opens
correctly, search field auto-focuses, but the keyword "Pointer"
returns "No Results for Pointer" in this iPadOS version's
Settings search index. Empirical: iPadOS 26.1's Settings
search does not surface this control by keyword.

### What worked

1. `pikvm_ipad_launch_app` with `appName: "Settings"` —
   reliably opens Settings via Spotlight (verified Phase 58+).
2. After launch, the Settings search field is auto-focused —
   `pikvm_type` text goes directly into search.
3. Keyboard shortcuts that DO work in Settings:
   - Backspace — clears characters one at a time
   - Enter — commits search

### What did NOT work

- `Cmd+F` — does nothing in Settings
- `Cmd+A` — does not select-all in Settings search field
- Searching for "Pointer", "Mouse", "AssistiveTouch" —
  returned "No Results" on this iPadOS 26.1 (date 2026-05-09).
  Either iPadOS 26 renamed the setting or removed search
  indexing for it.
- `pikvm_mouse_click_at` for small UI controls in Settings —
  motion-diff fails to detect cursor at start (cursor faded);
  algorithm falls back to slam-then-move which **triggers the
  iPad hot-corner re-lock**. Avoid.

## Recommended human-operator path

Because the keyboard search and click paths are unreliable on
iPadOS 26.1 from PiKVM, the recommended approach is:

1. Have the user (physically near the iPad) navigate
   manually:
   - Open Settings
   - Tap **Accessibility** in the sidebar
   - Tap **Touch** (iPadOS 17+) → **Pointer Control**
   - Verify **Pointer Animations** is OFF (or toggle off)
2. Confirm via PiKVM screenshot that the cursor no longer
   shows a "magnetic" snap when hovering near icons (visible
   even at 1 fps in the PiKVM HDMI feed).

## Programmatic verification (not yet reliable)

A future iteration could:

1. Open Settings via Spotlight (works).
2. Tab through sidebar with arrow keys to reach
   "Accessibility" — needs Full Keyboard Access enabled
   (Phase 63).
3. Press Enter to enter Accessibility section.
4. Continue keyboard navigation to Pointer Control.
5. Read screenshot to verify the toggle state.
6. Press Space to toggle if needed.

This is documented but not yet wired as a reliable skill.
The keyboard navigation through Settings sidebar varies by
iPadOS version.

## Once confirmed OFF

Re-run `bench-click-extensive.ts 10` from the repo. Predicted
outcome:

| Target type | Pointer Animations ON | Pointer Animations OFF (predicted) |
|:------------|----------------------:|-----------------------------------:|
| Small icons |               50-60 % |                              ≥ 90 % |
| Mid icons   |               80-90 % |                              ~100 % |

If the predicted lift materializes, update the README and
click-at skill prompt to recommend Pointer Animations OFF as
a setup prerequisite for any iPad-PiKVM deployment.

## Investigation notes for the next session

- `data/x-sweep/00-initial.jpg` and `25.jpg` from the Phase
  194-F session demonstrate that mouse emits work fine; the
  cursor does reach the right edge after enough mickeys. So
  any "stuck cursor" symptoms are detection illusions, not
  real movement failure.
- The Settings search returning "No Results" for "Pointer" /
  "Mouse" on iPadOS 26.1 is the new finding from Phase 194-H
  attempted live verification. Worth confirming on a different
  iPad / iPadOS version.
- Empirical: launching Settings via `pikvm_ipad_launch_app`
  auto-focuses the search field, so typing immediately works.
  This is a reliable starting point for future skill iterations.

## Files referenced

- `docs/troubleshooting/2026-04-30-phase-194h-disable-pointer-animations.md`
  — fuller writeup of the Phase 194-H finding and predicted
  click-rate impact.
- `docs/troubleshooting/ipad-cursor-detection.md` — Phase 111
  baseline for the 50–60 % ceiling this setting addresses.
