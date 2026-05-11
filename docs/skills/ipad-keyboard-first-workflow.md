# ipad-keyboard-first-workflow

Reliable keyboard-first iPad workflow that bypasses cursor positioning.

## Why this skill exists

Live-validated 2026-04-26: app launches via Spotlight (`Cmd+Space` →
type app name → Enter) succeed 100% of the time across Settings,
Files, App Store. By contrast, `pikvm_mouse_click_at` on iPad has a
per-attempt hit rate of ~50% at icon tolerance (≤25 px residual) for
tiny targets and ~70-80% for large rows/buttons (Phase 70 bench,
post-Phase 65/68/69 improvements). The Phase 94/142 iPad default
`maxRetries: 3` (4 attempts — bumped from 2 to 3 in Phase 142 for
Phase 141's hidden-popup-dismiss-recipe headroom; auto-applied) gets
cumulative hit rate ~88% for tiny targets and ~99% for large ones.
iPadOS pointer-acceleration variance (~6× run-to-run) and motion-diff
noise on animated UI are the underlying limits — see
`docs/troubleshooting/ipad-cursor-detection.md` § "Current state".

> **HONESTY NOTE (Phase 214/244/248-249, 2026-05-11, v0.5.214):** the Phase 70
> numbers above predate Phase 214's App Switcher finding, Phase 235's
> chunked-deposit fix, Phase 244's locality gate extension, and
> Phase 248/249's opt-in fp-blocklist. Recent post-Phase-244 cumulative
> N=60 runs show ~22-25% per-attempt within 35 px on the cursor path
> regardless of whether useKnownFpBlocklist is enabled (first N=20
> with-blocklist showed 40% but second N=20 regressed to 5% —
> cumulative within Phase 237 variance). Treat the rates above as
> pre-Phase-214 historical numbers; the underlying recommendation
> (prefer keyboard over cursor) is still correct and is even more
> compelling now that the cursor-path ceiling is empirically ~25%.

**Prefer this pattern over `pikvm_mouse_click_at` for any iPad
target where a keyboard equivalent exists.** Reach for cursor clicks
only when no keyboard equivalent exists; the iPad-default
`maxRetries: 3` is auto-applied and post-click screenshot inspection
is mandatory.

## Primitives (live-validated)

| Operation | Tool / shortcut | Reliability |
|---|---|---|
| Unlock from lock screen | `pikvm_ipad_unlock` | High (Phase 217: Esc + Enter + Space; swipe is opt-in fallback) |
| Return to home | `pikvm_ipad_home` (Cmd+H) | High from a foreground app. **Does NOT dismiss the App Switcher** — pass `forceHomeViaSwipe: true` (Phase 214; Phase 231 v0.5.207 adds defensive Esc+Enter for re-lock recovery; Phase 235 v0.5.208 chunked-deposits cursor mid-screen so subsequent moveToPixel calls aren't blocked by top-edge pinning) for guaranteed home-screen state. |
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
