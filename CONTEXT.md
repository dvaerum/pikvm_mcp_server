# PiKVM MCP Server - Project Context

## Background

This project was born from attempting to use Claude Code's browser automation tools to interact with a PiKVM web interface. The browser automation approach had issues with keyboard input - special characters like `()` were being sent incorrectly because:

1. PiKVM's web interface captures browser **key events** (keydown/keyup with key codes like "Digit9", "ShiftLeft") and translates them to USB HID codes
2. Browser automation sends **characters** directly rather than simulating proper key press sequences
3. For example, `(` requires **Shift + 9**, but automation sent just the character which PiKVM interpreted as the `9` key without Shift modifier

## Solution: Direct PiKVM API Integration

A dedicated MCP server that communicates directly with PiKVM's REST API will bypass these issues entirely.

## PiKVM Architecture Overview

### HID Emulation Methods

PiKVM supports several HID (Human Interface Device) emulation methods:

1. **USB OTG HID** (Native - V2+ platforms) - Uses Raspberry Pi's built-in USB OTG controller
2. **Pico HID** (External) - For V1 platform or PS/2 emulation needs
3. **Bluetooth HID** - For mobile/wireless scenarios

### Key API Endpoints

Based on research, PiKVM exposes these REST API endpoints:

- **`/api/hid/print`** - "Paste as Keys" - sends text with server-side keymap conversion
- **`/api/hid/events/send_key`** - Send individual key events with HID codes
- **`/api/hid/events/send_mouse_button`** - Mouse button events
- **`/api/hid/events/send_mouse_move`** - Mouse movement (absolute positioning)
- **`/api/hid/events/send_mouse_relative`** - Mouse movement (relative)
- **`/api/hid/events/send_mouse_wheel`** - Scroll wheel
- **`/api/streamer/snapshot`** - Capture screenshot from video stream

### Authentication

PiKVM uses HTTP Basic Authentication or token-based auth. The API requires proper credentials.

### Keymaps

PiKVM supports multiple keyboard layouts (keymaps) for the paste-as-keys feature:
- en-us (default)
- Various international layouts

## MCP Server Design

### Implemented Tools

1. **`pikvm_screenshot`**
   - Capture current screen from video stream
   - Returns image for visual analysis
   - Endpoint: `/api/streamer/snapshot`

2. **`pikvm_type`**
   - Type text using paste-as-keys API
   - Handles special characters correctly via server-side keymap
   - Parameters: text, keymap (optional), delay (optional)
   - Endpoint: `/api/hid/print`

3. **`pikvm_key`**
   - Send individual key or key combination
   - Parameters: key code, modifiers (ctrl, alt, shift, meta)
   - Endpoint: `/api/hid/events/send_key`

4. **`pikvm_mouse_move`**
   - Move mouse to coordinates
   - Parameters: x, y (absolute or relative)
   - Endpoint: `/api/hid/events/send_mouse_move` or `send_mouse_relative`

5. **`pikvm_mouse_click`**
   - Click mouse button
   - Parameters: button (left, right, middle), x, y (optional)
   - Endpoint: `/api/hid/events/send_mouse_button`

6. **`pikvm_mouse_scroll`**
   - Scroll wheel
   - Parameters: delta_x, delta_y
   - Endpoint: `/api/hid/events/send_mouse_wheel`

### Configuration

The MCP server will need:
- PiKVM host URL (e.g., `https://<your-pikvm-ip>`)
- Authentication credentials (username/password or API token)
- Default keymap setting
- SSL certificate verification settings (PiKVM often uses self-signed certs)

### Technology Stack

TypeScript/Node.js was chosen for the implementation, using the official MCP SDK (`@modelcontextprotocol/sdk`), `undici` for HTTP requests, and `image-size` for screenshot dimension detection.

## Research Sources

- [PiKVM Handbook - Pico HID](https://docs.pikvm.org/pico_hid/)
- [PiKVM Handbook - FAQ](https://docs.pikvm.org/faq/)
- [PiKVM GitHub - kvmd](https://github.com/pikvm/kvmd)
- [DeepWiki - PiKVM HID](https://deepwiki.com/pikvm/kvmd/4.1-hid-(human-interface-devices))
- [DeepWiki - Web UI](https://deepwiki.com/pikvm/kvmd/6-web-user-interface)

## Implementation Status

All planned tools have been implemented and tested:

1. Screenshot capture with automatic coordinate scaling
2. Text typing via paste-as-keys API with keymap support
3. Individual key events and keyboard shortcuts
4. Mouse movement (absolute and relative), clicking, and scrolling
5. Mouse coordinate calibration system for resolution-dependent correction
6. Tested successfully across multiple resolutions (640x480, 800x600, 1280x1024, 1920x1080)
