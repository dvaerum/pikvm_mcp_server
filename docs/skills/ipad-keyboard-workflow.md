# iPad keyboard-first workflow

**Use this pattern instead of cursor clicks whenever possible.**

The iPad's USB HID keyboard channel is fast, deterministic, and not
subject to the cursor-acceleration / cursor-detection fragility that
plagues `pikvm_mouse_click_at` on iPad. Most agent tasks on an iPad —
launch app, search, navigate Settings, open a file — can be done end to
end with `pikvm_ipad_unlock`, `pikvm_shortcut`, `pikvm_type`, and
`pikvm_key` alone.

## Why prefer keyboard

- **No cursor detection.** No pixel-precision click; no risk of clicking
  the wrong icon because acceleration drifted.
- **No iPadOS auto-lock surprises.** Keyboard activity registers as user
  input on iPadOS the same way external Apple Magic Keyboard input does.
- **No re-lock from hot-corner gestures.** Slamming the cursor to
  top-left can re-lock the iPad on iPadOS 26 — keyboard skips that
  whole class of failure.
- **Cmd+Space + type matches the shortest human path.** Anyone familiar
  with macOS Spotlight already knows the gesture.

## The core pattern

```
pikvm_ipad_unlock                              # iPad on home screen
pikvm_shortcut(["MetaLeft", "Space"])          # Spotlight
pikvm_type("<app name>")                       # type the app name
pikvm_key("Enter")                             # launch
```

`pikvm_shortcut` emits the modifier-then-action sequence with the
correct ~40 ms inter-event spacing that iPadOS needs to recognise the
modifier as held. `pikvm_type` handles special characters via the
keymap. `pikvm_key("Enter")` is a single tap.

## Worked examples

### Launch the Files app

```
pikvm_ipad_unlock
pikvm_shortcut(["MetaLeft", "Space"])
pikvm_type("Files")
pikvm_key("Enter")
pikvm_screenshot                               # confirm Files is open
```

### Launch Settings and search for "Wi-Fi"

```
pikvm_ipad_unlock
pikvm_shortcut(["MetaLeft", "Space"])
pikvm_type("Settings")
pikvm_key("Enter")
# Now in Settings:
pikvm_shortcut(["MetaLeft", "KeyF"])           # focus the in-app search
pikvm_type("Wi-Fi")
pikvm_screenshot                               # filtered results visible
```

From the filtered results you can navigate via arrow keys and Enter, or
fall back to `pikvm_mouse_click_at` on a list row that's a much larger
target than an app icon (and easier to hit accurately).

### Switch between running apps

```
pikvm_shortcut(["MetaLeft", "Tab"])            # App Switcher
# Then arrow keys + Enter, or release MetaLeft to dismiss.
```

### Navigate the Settings sidebar with arrow keys (Phase 61)

The iPad Settings sidebar IS keyboard-navigable on any iPad — no
Full Keyboard Access required. The right pane updates automatically
as the sidebar selection moves.

```
# Start anywhere in Settings (sub-page or category):
pikvm_key("Escape")                            # walk UP the nav stack
pikvm_key("Escape")                            # repeat until at root
pikvm_key("ArrowDown")                         # next sidebar row
pikvm_key("ArrowDown")
# ... arrow until target category is highlighted; right pane updates live
pikvm_screenshot                               # verify
```

**For deeper-than-sidebar interaction** (toggling a switch, tapping a
sub-row in the right pane): iPadOS's Full Keyboard Access must be ON
(Settings → Accessibility → Keyboards → Full Keyboard Access — one-
time setup). With FKA on, `pikvm_key("Tab")` walks in-pane focus and
`pikvm_key("Enter")` activates / toggles. Without FKA, only the
sidebar is keyboard-reachable; in-pane interactions still need
`pikvm_mouse_click_at`. See `docs/troubleshooting/ipad-cursor-detection.md`
§ Phase 61/62/63 for the full finding.

### Lock the iPad

iPadOS doesn't expose a "lock" keyboard shortcut over USB HID; the
side button is the only reliable way. To dismiss an app and return to
home screen instead, swipe up from the home indicator (drag) or use
`pikvm_ipad_unlock` (idempotent — closes any foreground app).

## When you still need a cursor click

Some UI elements have no keyboard equivalent: scattered toggles in some
in-app preference panes, custom on-screen buttons, etc. For those, fall
back to `pikvm_mouse_click_at` — but try search-and-navigate first.

If you must click, target the **largest possible** clickable region (a
whole list row beats a small icon), and always inspect the returned
screenshot to verify the click landed.

## Known limitations

- **`pikvm_shortcut` requires modifier-first ordering.** Pass modifiers
  first, then the action key as the last element. The implementation
  presses everything except the last key in order, taps the last key,
  then releases modifiers in reverse — matching macOS shortcut
  convention.
- **Some iPadOS shortcuts are reserved by hardware accessibility
  features.** If a shortcut behaves unexpectedly (e.g. the screen
  zooms or VoiceOver activates), check Settings → Accessibility for
  conflicting bindings.
- **External-keyboard layout matters for `pikvm_type`.** The default
  keymap is `en-us`. If the iPad is configured for a non-US layout,
  override `keymap` in the `pikvm_type` call.
