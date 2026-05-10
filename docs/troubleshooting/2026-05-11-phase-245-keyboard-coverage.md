# Phase 245 — keyboard-workflow live coverage at v0.5.211

**Date:** 2026-05-11
**Version:** v0.5.211
**Status:** Verified working across 4 distinct apps.

## Test

`test-phase245-keyboard-coverage.ts` runs `launchIpadApp` for 4 apps
sequentially and saves the post-launch screenshot for each. Tests
that the Phase 217/219/231/235 unlock + Cmd+Space + type + Enter
chain generalizes beyond Settings (Phase 234 covered only that).

## Result

All 4 apps launched cleanly via Spotlight:

| App        | Outcome                                                      |
|:-----------|:-------------------------------------------------------------|
| Files      | ✅ opened to "Recents" view (no docs yet)                     |
| App Store  | ✅ opened with "What's New on App Store & Apple Arcade" modal |
| Maps       | ✅ opened to map view (with "Get Notified..." permission popup) |
| Settings   | ✅ opened to "Home Screen & App Library" pane                  |

The cosmetic differences (App Store intro modal, Maps notification
popup, Files empty Recents) are app-specific first-launch behaviors,
not problems with the launch mechanism itself — each app reached
its main UI.

## Why this matters

The keyboard workflow is the project's most reliable path to a
specific app — 100% across this N=4 coverage, consistent with the
"recommended" framing in `docs/skills/ipad-keyboard-first-workflow.md`.
By contrast, cursor-based `pikvm_mouse_click_at` on a ~70 px app
icon is post-Phase-244 ~20-33% per-attempt (per Phase 236 N=10 +
Phase 244 N=10 — both with large variance per Phase 237's lesson).

The keyboard recipe works because it bypasses cursor positioning
entirely: every step is a keyboard event (Cmd+Space, character
input, Enter), each of which iPadOS receives reliably from the
USB HID. No motion-diff, no template-match, no per-call cap.

## State

- v0.5.211 stable
- 725/725 tests pass
- nix build green
- Coverage retained: `data/phase245-keyboard-coverage/{files,app-store,maps,settings}.jpg`
- Test script `test-phase245-keyboard-coverage.ts` retained for
  reproducibility

## What's next

The cursor click-rate gap remains the project's primary bottleneck
on small targets. Phase 245+ candidates (score-margin gate,
motion-diff cross-validation, negative-template list) are
documented in the Phase 244 doc but each needs N≥30 live data to
validate per Phase 237's variance lesson. None implemented this
session.
