# Phase 195 — Settings.app search works for SOME terms, but indexes "Pointer" as no-result on iPadOS 26.1

**Date:** 2026-05-10 (Sun)  
**Context:** Live keyboard navigation attempt to toggle Pointer Animations
without user physical action.

## Finding

The previous session (Phase 194-H/I) concluded that iPadOS 26.1
Settings search returns "No Results" for the keyword `Pointer`. That
finding is **confirmed correct** — but the conclusion that *Settings
search is broken* was incorrect.

### What Settings search actually does on iPadOS 26.1

Settings.app's internal search field DOES return rich, deep-linked
results — for many terms, including:

- `Accessibility` — returns Accessibility, Accessibility Shortcut,
  Share Accessibility Settings, Accessibility Reader, Autoplay in
  Accessibility Reader, Larger Accessibility Sizes, Apple TV Remote,
  Assistive Access, Audio & Visual, **Click Speed (Accessibility)**,
  Display & Text Size, Hearing Control Centre, Hearing Devices,
  Keyboards & Typing, Motion (Accessibility), and more.
- `Accessib` (partial) — returns superset including Touch
  (Accessibility), Voice Control, Switch Control, Tap to Wake,
  Subtitles & Captioning.

These entries are deep-links — selecting one would jump directly
into that pane.

### What it doesn't surface

- `Pointer` — "No Results for 'Pointer'"
- `Animation` (partial keystrokes) — typing was disrupted by
  autocorrect; sidebar reverted to full Settings tree at "Ani"
  partial.

So the specific terms `Pointer Control` and `Pointer Animations`
appear absent from the iPadOS 26.1 Settings search index. This is
different from "search is broken" — the index is just missing
those entries (likely an Apple bug or oversight in 26.1).

### Spotlight from home screen vs Settings.app internal search

- **Home-screen Spotlight** (Cmd+Space): DOES return Pointer
  results, including a Tip "Make the pointer easier to see when
  using a mouse" and the Settings entry "Trackpad & Mouse" under
  General. Neither deep-links to Pointer Animations directly.
- **Settings.app internal search** (after launching Settings):
  Returns "No Results" for `Pointer` specifically.

### Why this still doesn't unblock end-to-end keyboard nav

Even with Settings search returning rich results for many terms,
none of the terms tried so far surface the Pointer Animations
toggle directly. To reach it via keyboard, one must:

1. Search for a term that surfaces `Touch` or `Accessibility`
2. Use down-arrow keys to highlight that result
3. Press Enter to open the pane
4. Use Tab/arrow keys to navigate within the pane
5. Find Touch row, press Enter
6. Find Pointer Control row, press Enter
7. Find Pointer Animations toggle, press Space to flip

Steps 4-7 require Full Keyboard Access to be properly enabled
*and* working in Settings panes — Phase 63 enabled it but its
behaviour in Settings panes specifically has not been re-validated
on iPadOS 26.1.

Step 1 is also brittle: typing via `pikvm_type` interacts with
the keyboard autocorrect popup, sometimes losing keystrokes.

## Productive next steps

1. **User-side toggle remains the recommended path** (10 seconds,
   physical access to iPad).
2. If keyboard navigation is needed, the next attempt should:
   - Use slower per-key emit (single `pikvm_key` calls, not bulk
     `pikvm_type`) to avoid autocorrect interference.
   - Search for `Accessibility`, then validate that down-arrow
     moves focus into the result list (not yet tested).
   - If down-arrow moves focus, press Enter to open Accessibility,
     then explore Tab+arrow nav within the pane.
3. The detection layer + cursor-belief work shipped in v0.5.184
   to v0.5.191 has made the *foundation* honest. Pointer
   Animations remains the dominant ceiling on small-icon clicks,
   but the project no longer ships confidently-wrong detection.

## Status

- Tests: 668/668 pass at v0.5.191.
- Working tree clean.
- Settings search is more capable than previously documented;
  Pointer Animations toggle remains user-side.
- This document supersedes the prior Phase 194-H finding that
  "Settings search returns No Results" — it returns no results
  *for the term `Pointer` specifically*.
