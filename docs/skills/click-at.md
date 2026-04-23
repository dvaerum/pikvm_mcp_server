# pikvm_mouse_click_at — Click at an Approximate Screen Pixel (Relative Mode)

> **iPad users:** read [ipad-setup.md](ipad-setup.md) first. Pointer Animations
> MUST be disabled for reliable operation.

## Purpose
On a PiKVM target in relative mouse mode (iPad), move the pointer to an approximate target pixel and click. Internally: `pikvm_mouse_move_to` → brief settle → `mouseClick`. Returns a post-click screenshot.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | Target X in HDMI screenshot pixels |
| y | number | *(required)* | Target Y in HDMI screenshot pixels |
| button | string | left | left / right / middle / up / down |
| slamFirst | boolean | true | Slam to top-left before moving |
| slamOriginX | number | 625 | HDMI X of post-slam origin |
| slamOriginY | number | 65 | HDMI Y of post-slam origin |

## When to Use
- Tapping an iPad app icon whose bounding box is ≥100×100 px — the ~50–200 px accuracy is often inside the hit target.
- Any coarse click where an error of tens of pixels is acceptable.

## When NOT to Use
- Sub-50 px precision (e.g. tapping a single character in a text field). Use the closed-loop pattern from the [move-to](move-to.md) guide: move-to, check screenshot, issue a corrective relative move, then `pikvm_mouse_click`.

## Example Calls
```json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700 } }

{ "name": "pikvm_mouse_click_at", "arguments": { "x": 400, "y": 400, "button": "right" } }
```

## Tips
- Take a `pikvm_screenshot` first to confirm the target pixel is where the UI element actually is — icon positions change between app rearrangements and iOS versions.
- **If the iPad is locked, call `pikvm_ipad_unlock` first** — clicks on the lock screen don't open apps.
- After the click, examine the returned screenshot: did the expected app open / dialog appear? If not, the click missed — retry with the closed-loop correction from [move-to](move-to.md).
