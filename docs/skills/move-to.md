# pikvm_mouse_move_to — Approximate Move to a Screen Pixel (Relative Mode)

> **iPad users — keyboard-first is usually better.**
> Cursor positioning on iPad is fundamentally fragile due to non-disableable
> pointer acceleration. Most agent tasks can be done end-to-end via the
> keyboard pattern in
> [ipad-keyboard-workflow.md](ipad-keyboard-workflow.md). Reach for this
> tool only when keyboard navigation can't reach the UI element you need.
>
> See [ipad-setup.md](ipad-setup.md) for recommended iPadOS settings
> when you do need cursor positioning.

## Purpose
Move the pointer to an approximate target pixel on a PiKVM target in relative mouse mode (iPad, etc.). The tool slams the pointer to the top-left corner to establish a known origin, emits a calculated delta sequence using a ballistics profile (if any) or a default `1.0` px/mickey, then returns a post-move screenshot.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | Target X in HDMI screenshot pixels |
| y | number | *(required)* | Target Y in HDMI screenshot pixels |
| slamFirst | boolean | true | Slam to top-left before moving (establishes origin) |
| slamOriginX | number | 625 | HDMI X of post-slam origin (iPad portrait letterbox) |
| slamOriginY | number | 65 | HDMI Y of post-slam origin |
| fallbackPxPerMickey | number | 1.0 | px/mickey used when no profile |
| chunkMagnitude | number | 127 | Per-call delta size |
| chunkPaceMs | number | 20 | Pace between chunked calls (ms) |
| deadZoneMickeys | number | 0 | Extra mickeys to compensate for edge absorption |

## Expected Accuracy
Open-loop: within **~50–200 pixels** of target on iPad. The iPad's pointer acceleration is non-linear and varies run-to-run, so fully precise targeting requires a closed-loop correction:

1. Call `pikvm_mouse_move_to` to get near the target.
2. In the returned screenshot, locate the cursor (small arrow, usually on wallpaper).
3. Compute pixel error (actual - target).
4. Issue a correction with `pikvm_mouse_move` in relative mode: delta ≈ -(error_x, error_y) mickeys.
5. Screenshot again; repeat if needed.

## Example Calls
```json
{ "name": "pikvm_mouse_move_to", "arguments": { "x": 960, "y": 540 } }

{ "name": "pikvm_mouse_move_to", "arguments": { "x": 1200, "y": 800, "slamOriginX": 500, "slamOriginY": 60 } }
```

## Tips
- The default slam origin (625, 65) is tuned for an iPad displayed portrait in a 1920×1080 HDMI frame. If your letterbox differs, measure once and override.
- Prefer `pikvm_mouse_click_at` for "move + click in one step".
- On an iPad that is locked, call `pikvm_ipad_unlock` first — move-to can move the cursor on a locked iPad but clicks will not trigger app behavior.
