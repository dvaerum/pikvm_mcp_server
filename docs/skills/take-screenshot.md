# take-screenshot

> MCP Prompt: `take-screenshot`

Guide for capturing screenshots with `pikvm_screenshot`.

## Purpose

Capture the current screen of the remote machine as a JPEG image. This is your primary way to **see** what is on screen.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| maxWidth | number | *(native)* | Maximum width in pixels — image is scaled down if the screen is wider |
| maxHeight | number | *(native)* | Maximum height in pixels — image is scaled down if the screen is taller |
| quality | number | 80 | JPEG quality (1-100) |
| keepCursorAlive | boolean | false | **Phase 202/246 (v0.5.197/v0.5.212):** emit a ±1 px mouse wake nudge immediately before the snapshot so the iPad cursor stays visible. iPadOS fades stationary cursors after a few seconds; without this flag your post-action screenshots may not show where the cursor actually landed. Net displacement is zero, so no UI side effects. |

Scaling preserves aspect ratio. When you scale a screenshot, the server tracks the scale factor so that mouse coordinates you derive from the image are automatically mapped back to native resolution.

## Example Call

```json
{
  "name": "pikvm_screenshot",
  "arguments": { "maxWidth": 1280, "quality": 70 }
}
```

To verify cursor position after a click_at miss on iPad:

```json
{
  "name": "pikvm_screenshot",
  "arguments": { "keepCursorAlive": true }
}
```

## Tips

- Omit maxWidth/maxHeight to get the full native resolution — best for reading small text.
- Use lower quality (50-60) when you only need layout/position information to save bandwidth.
- Always take a screenshot **after** performing an action to verify the result.
- The response includes a text line describing dimensions and any scaling that was applied.
- **On iPad, pass `keepCursorAlive: true`** if your screenshot needs to show where the cursor is — otherwise iPadOS will likely have faded it by capture time (Phase 242 documented this clearly).
