# PiKVM API Reference

This document details the PiKVM REST API endpoints needed for the MCP server implementation.

## Base URL

All API endpoints are prefixed with `/api/` when accessed via HTTP(S) on ports 80/443.
When using the Unix socket directly (`/run/kvmd/kvmd.sock`), omit the `/api/` prefix.

Example: `https://<pikvm-ip>/api/hid/print`

## Authentication

PiKVM supports multiple authentication methods:

### Method 1: Custom Headers (Recommended for API use)

```bash
curl -k \
  -H "X-KVMD-User: admin" \
  -H "X-KVMD-Passwd: yourpassword" \
  https://<pikvm-ip>/api/auth/check
```

### Method 2: HTTP Basic Auth

```bash
curl -k -u admin:yourpassword https://<pikvm-ip>/api/auth/check
```

### Method 3: Token-Based (Session Cookie)

1. Login to get token:
```bash
curl -k -c cookies.txt -X POST \
  --data "user=admin" \
  --data "passwd=yourpassword" \
  https://<pikvm-ip>/api/auth/login
```

2. Use token in subsequent requests:
```bash
curl -k -b cookies.txt https://<pikvm-ip>/api/info
```

### Authentication Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/check` | GET | Check if authenticated (200 = yes, 401/403 = no) |
| `/api/auth/login` | POST | Login with `user` and `passwd` form data |
| `/api/auth/logout` | POST | Invalidate current session |

---

## HID (Keyboard/Mouse) API

### Get HID State

```
GET /api/hid
```

Returns current HID device state including keyboard/mouse connection status.

### Configure HID

```
POST /api/hid/set_params
```

**Parameters:**
- `keyboard_output` - Keyboard output mode
- `mouse_output` - Mouse output mode
- `jiggler` - Enable mouse jiggler to prevent sleep

### Reset HID

```
POST /api/hid/reset
```

Resets the HID device. Useful if keyboard/mouse becomes unresponsive.

### Get Available Keymaps

```
GET /api/hid/keymaps
```

Returns list of available keyboard layout mappings (e.g., `en-us`, `de`, `fr`).

---

## Keyboard API

### Type Text (Paste as Keys) - MOST IMPORTANT

```
POST /api/hid/print
```

**Parameters:**
- `text` (body) - The text to type
- `limit` - Maximum characters (default: 1024)
- `keymap` - Keyboard layout (default: `en-us`)
- `slow` - Use slow typing mode (boolean)
- `delay` - Delay between keystrokes in ms (0-200)

**Example:**
```bash
curl -k -u admin:admin \
  -X POST \
  -H "Content-Type: text/plain" \
  -d "Hello World!" \
  "https://<pikvm-ip>/api/hid/print?keymap=en-us"
```

This endpoint handles special character conversion properly via the keymap.

### Send Key Event

```
POST /api/hid/events/send_key
```

**Parameters:**
- `key` - Key code (e.g., `KeyA`, `Enter`, `ShiftLeft`)
- `state` - `true` = press, `false` = release, omit = press+release

**Key Codes:** Use standard JavaScript key codes:
- Letters: `KeyA`, `KeyB`, ... `KeyZ`
- Numbers: `Digit0`, `Digit1`, ... `Digit9`
- Function: `F1`, `F2`, ... `F12`
- Modifiers: `ShiftLeft`, `ShiftRight`, `ControlLeft`, `ControlRight`, `AltLeft`, `AltRight`, `MetaLeft`, `MetaRight`
- Special: `Enter`, `Escape`, `Backspace`, `Tab`, `Space`, `Delete`, `Insert`, `Home`, `End`, `PageUp`, `PageDown`
- Arrows: `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`

**Example - Ctrl+Alt+Delete:**
```bash
# Press Ctrl
curl -k -u admin:admin -X POST "https://<pikvm-ip>/api/hid/events/send_key?key=ControlLeft&state=true"
# Press Alt
curl -k -u admin:admin -X POST "https://<pikvm-ip>/api/hid/events/send_key?key=AltLeft&state=true"
# Press and release Delete
curl -k -u admin:admin -X POST "https://<pikvm-ip>/api/hid/events/send_key?key=Delete"
# Release Alt
curl -k -u admin:admin -X POST "https://<pikvm-ip>/api/hid/events/send_key?key=AltLeft&state=false"
# Release Ctrl
curl -k -u admin:admin -X POST "https://<pikvm-ip>/api/hid/events/send_key?key=ControlLeft&state=false"
```

### Send Shortcut

```
POST /api/hid/events/send_shortcut
```

**Parameters:**
- `keys` - Array of key codes to press simultaneously

**Example:**
```bash
curl -k -u admin:admin \
  -X POST \
  -H "Content-Type: application/json" \
  -d '["ControlLeft", "AltLeft", "Delete"]' \
  https://<pikvm-ip>/api/hid/events/send_shortcut
```

---

## Mouse API

### Coordinate System

**IMPORTANT:** PiKVM uses a **normalized coordinate system** internally:
- Absolute coordinates: Range `-32768` to `32767` (signed 16-bit integer)
- Relative deltas: Range `-127` to `127` (signed 8-bit integer)

The coordinate `(0, 0)` maps to the center of the screen in the internal system, but the MCP server converts pixel coordinates automatically.

**Conversion formula** (pixel to PiKVM):
```
pikvm_x = remap(pixel_x, 0, screen_width - 1, -32768, 32767)
pikvm_y = remap(pixel_y, 0, screen_height - 1, -32768, 32767)
```

### Get Screen Resolution

```
GET /api/streamer
```

**Returns:** JSON with `result.source.resolution.width` and `result.source.resolution.height`

### Move Mouse (Absolute)

```
POST /api/hid/events/send_mouse_move
```

**Parameters:**
- `to_x` - X coordinate (range: -32768 to 32767)
- `to_y` - Y coordinate (range: -32768 to 32767)

**Note:** The MCP server's `pikvm_mouse_move` tool accepts pixel coordinates and converts them automatically.

### Move Mouse (Relative)

```
POST /api/hid/events/send_mouse_relative
```

**Parameters:**
- `delta_x` - Horizontal movement (range: -127 to 127, negative = left, positive = right)
- `delta_y` - Vertical movement (range: -127 to 127, negative = up, positive = down)

### Mouse Button

```
POST /api/hid/events/send_mouse_button
```

**Parameters:**
- `button` - `left`, `right`, `middle`, `up`, or `down` (up/down are scroll wheel buttons)
- `state` - `true` = press, `false` = release, omit = click

**Example - Right click:**
```bash
curl -k -u admin:admin -X POST "https://<pikvm-ip>/api/hid/events/send_mouse_button?button=right"
```

### Mouse Wheel

```
POST /api/hid/events/send_mouse_wheel
```

**Parameters:**
- `delta_x` - Horizontal scroll
- `delta_y` - Vertical scroll (negative = up, positive = down)

---

## Streamer (Video/Screenshot) API

### Get Streamer State

```
GET /api/streamer
```

Returns current video streamer state.

### Take Screenshot

```
GET /api/streamer/snapshot
```

**Parameters:**
- `preview` - Generate preview image (boolean)
- `preview_max_width` - Max width in pixels
- `preview_max_height` - Max height in pixels
- `preview_quality` - JPEG quality (1-100)
- `allow_offline` - Allow capture even if no video signal (boolean)
- `ocr` - Perform OCR on image (boolean)
- `ocr_langs` - OCR languages (comma-separated)
- `ocr_left`, `ocr_top`, `ocr_right`, `ocr_bottom` - OCR region

**Example - Get screenshot:**
```bash
curl -k -u admin:admin \
  -o screenshot.jpg \
  "https://<pikvm-ip>/api/streamer/snapshot"
```

**Example - Get resized preview:**
```bash
curl -k -u admin:admin \
  -o preview.jpg \
  "https://<pikvm-ip>/api/streamer/snapshot?preview=1&preview_max_width=800&preview_quality=80"
```

**Response:** Returns JPEG image data directly (Content-Type: image/jpeg)

### Delete Stored Snapshot

```
DELETE /api/streamer/snapshot
```

---

## System Info API

### Get System Info

```
GET /api/info
```

Returns system information including hardware, software versions, etc.

---

## Error Handling

- **200** - Success
- **400** - Bad request (invalid parameters)
- **401** - Unauthorized (not authenticated)
- **403** - Forbidden (authenticated but not allowed)
- **404** - Not found
- **413** - Payload too large (text too long for /hid/print)
- **500** - Internal server error

Error responses are JSON:
```json
{
  "ok": false,
  "result": {
    "error": "Error description"
  }
}
```

---

## SSL/TLS Notes

PiKVM typically uses self-signed certificates. Options:
1. Use `-k` flag with curl to skip verification
2. Add PiKVM's CA to your trust store
3. Set `rejectUnauthorized: false` in Node.js HTTPS agent

---

## References

- [PiKVM HTTP API Reference](https://docs.pikvm.org/api/)
- [PiKVM Authentication](https://docs.pikvm.org/auth/)
- [PiKVM GitHub - kvmd](https://github.com/pikvm/kvmd)
