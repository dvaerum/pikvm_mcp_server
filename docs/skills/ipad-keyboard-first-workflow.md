# ipad-keyboard-first-workflow

Reliable keyboard-first iPad workflow that bypasses cursor positioning.

## Why this skill exists

Live-validated 2026-04-26: app launches via Spotlight (`Cmd+Space` →
type app name → Enter) succeed 100% of the time across Settings,
Files, App Store. By contrast, `pikvm_mouse_click_at` on iPad has a
per-attempt hit rate of ~50% at icon tolerance (≤25 px residual) for
tiny targets and ~70-80% for large rows/buttons (Phase 70 bench,
post-Phase 65/68/69 improvements). With `maxRetries: 2` (3 attempts —
Phase 94 default on iPad, automatic) the cumulative hit rate climbs
to ~88% for tiny targets and ~99% for large ones. iPadOS pointer-acceleration variance (~6× run-to-run)
and motion-diff noise on animated UI are the underlying limits — see
`docs/troubleshooting/ipad-cursor-detection.md` § "Current state".

**Prefer this pattern over `pikvm_mouse_click_at` for any iPad
target where a keyboard equivalent exists.** Reach for cursor clicks
only when no keyboard equivalent exists, and use `maxRetries: 2`
plus post-click screenshot inspection.

## Primitives (live-validated)

| Operation | Tool / shortcut | Reliability |
|---|---|---|
| Unlock from lock screen | `pikvm_ipad_unlock` | High |
| Return to home | `pikvm_ipad_home` (Cmd+H) | High |
| Launch app | `pikvm_ipad_launch_app(name)` | High (4 apps verified) |
| Focus in-app search | `pikvm_shortcut(["MetaLeft","KeyF"])` | App-dependent |
| Cycle focus | `pikvm_key("Tab")` | App-dependent |
| Dismiss modal | `pikvm_key("Escape")` | High |
| Type text | `pikvm_type(text)` | High |
| Confirm/activate | `pikvm_key("Enter")` | High |

## Worked examples

### Open Settings and search for "Wi-Fi"

```
pikvm_ipad_launch_app(appName: "Settings")
pikvm_shortcut(["MetaLeft", "KeyF"])
pikvm_type(text: "Wi-Fi")
pikvm_key("Enter")
pikvm_screenshot
```

### Open Files

```
pikvm_ipad_launch_app(appName: "Files")
pikvm_screenshot
```

### Dismiss any modal

```
pikvm_screenshot                # see what's on screen
pikvm_key("Escape")             # most modals respond to Escape
pikvm_screenshot                # confirm dismissed
```

If Escape doesn't dismiss a particular modal, fall back to
`pikvm_mouse_click_at` for the close button — modal backdrops
(quiet scrim) tend to make cursor clicks more reliable than home-
screen clicks.

## Decision flow

1. Is iPad on lock screen? → `pikvm_ipad_unlock`
2. Need to launch an app? → `pikvm_ipad_launch_app(name)`
3. Already in an app, need to navigate?
   - Search: `Cmd+F`
   - Focus next: `Tab`
   - Activate: `Enter` or `Space`
   - Dismiss: `Escape`
   - Back: `Cmd+[` (in stock apps)
   - Home: `pikvm_ipad_home`
4. Only cursor click? → `pikvm_mouse_click_at` with
   `verifyClick: true` and `maxRetries: 3`. Inspect post-click
   screenshot.

## What this skill does NOT do

- Click small icons on the home screen (cursor problem unsolvable
  in software — see troubleshooting doc).
- Drag and drop (cursor coordination required).
- Pinch / multi-touch gestures (HID mouse can't emulate them).

For these, the calling agent must accept some unreliability and
verify outcomes via post-action screenshots.
