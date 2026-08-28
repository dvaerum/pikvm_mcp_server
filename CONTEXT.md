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

The server has grown well past the original 6-tool sketch above (keyboard,
click, move, scroll, screenshot). **AGENTS.md's "Project Structure" and "Tool
Guides"/"Workflow Recipes" tables are the exhaustive, test-anchored list of
every `pikvm_*` tool and prompt** — `agents-doc-freshness.test.ts` fails CI if
that list drifts from `src/index.ts`, so it's the source of truth, not this
file. What follows here is the domain model those tools sit on top of —
useful for orienting a new contributor, not a tool catalog:

- **HID mode** (`hid-mode.ts`) — the appliance reports `ipad` (relative
  mouse) or `desktop` (absolute mouse) over an authenticated `/hidmode`
  endpoint; the server derives its own move/click behavior from that, never
  holding a second copy of the mode. See ADR 0002.
- **Slam + anchor** (`cursor-anchor.ts`, `ballistics.ts`'s `slamToCorner`) —
  driving the relative-mouse cursor hard into a screen corner to establish a
  known origin, then verifying it actually landed there before trusting
  subsequent relative deltas. `anchorCursor()` is the unified verify/recover
  primitive several call sites (`move-to.ts`, `ipad-unlock.ts`) share.
- **Ballistics** (`ballistics.ts`) — iPadOS applies non-disableable pointer
  acceleration to relative USB HID deltas, so 1 emitted mickey ≠ 1 moved
  pixel; this module measures and persists the empirical
  pixels-per-mickey curve movers rely on to hit a target pixel.
- **Cursor detection / belief** (`cursor-detect.ts`, `cursor-locator.ts`,
  `cursor-belief.ts`) — screenshot-diff / ML / template detectors that answer
  "where is the cursor right now?", unified behind `CursorLocator`'s named
  profiles (see ADR 0003) and tracked over time by `CursorBelief`.
- **Mover strategies** (`move-to.ts`, `curve-mover.ts`, `click-at.ts`) —
  `curve-one-shot` (the shipped default, calibrated open-loop emit) vs
  `detect-then-move` (iterative closed-loop correction, desktop/absolute
  default) — see each module's own header comment for the trade-off.

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

The original 6-tool sketch above is long superseded — see AGENTS.md for the
current, test-anchored tool/prompt count and catalog. Both absolute-mouse
(desktop, calibration-based) and relative-mouse (iPad, ballistics-based)
targets are supported end-to-end, hardware-gated on real devices before each
merge (see the architecture-decision docs under `docs/adr/` for the design
history of the mode-derivation, slam/anchor, and cursor-locator subsystems).
