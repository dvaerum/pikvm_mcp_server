# AGENTS.md - PiKVM MCP Server

## Project Overview

This project implements an MCP (Model Context Protocol) server that provides direct API access to PiKVM devices. This allows Claude Code and other MCP clients to control remote machines via PiKVM without going through browser automation.

## Why This Exists

Browser automation through PiKVM's web interface has keyboard input issues - special characters get mangled because the automation layer sends characters rather than proper key events. This MCP server communicates directly with PiKVM's REST API, which handles character-to-keycode conversion properly.

## Project Structure

```
pikvm_mcp_server/
├── AGENTS.md           # This file - instructions for AI agents
├── CONTEXT.md          # Background research and design notes
├── API_REFERENCE.md    # PiKVM API documentation
├── src/                # Source code
│   ├── index.ts        # Main MCP server entry point (tool + prompt handlers)
│   ├── config.ts       # Configuration handling
│   ├── pikvm/          # PiKVM API client and control modules
│   │   ├── client.ts           # REST API wrapper
│   │   ├── cursor-detect.ts    # Screenshot-diff cursor detection
│   │   ├── auto-calibrate.ts   # Absolute-mouse calibration
│   │   ├── ballistics.ts       # Relative-mouse ballistics measurement
│   │   ├── move-to.ts          # Corner-anchored move-to-pixel
│   │   ├── ipad-unlock.ts      # iPad lock-screen swipe gesture
│   │   └── lock.ts             # BusyLock for long-running ops
│   └── prompts/        # MCP prompt definitions
│       ├── types.ts    # PromptDefinition interface
│       ├── tool-guides.ts  # 14 individual tool guide prompts
│       ├── workflows.ts    # 7 multi-step workflow prompts
│       ├── skill-tools.ts  # Auto-generated skill_* tools from prompts
│       └── index.ts    # Barrel export + lookup function
├── docs/skills/        # Human-readable skill guides (mirrors prompts)
├── package.json
└── tsconfig.json
```

## Development Commands

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development
npm run dev

# Type checking
npm run typecheck
```

## Configuration

The server is configured via environment variables or a config file:

- `PIKVM_HOST` - PiKVM URL (e.g., `https://<your-pikvm-ip>`)
- `PIKVM_USERNAME` - Auth username (default: `admin`)
- `PIKVM_PASSWORD` - Auth password
- `PIKVM_VERIFY_SSL` - Whether to verify SSL certs (default: `false` for self-signed)
- `PIKVM_DEFAULT_KEYMAP` - Default keyboard layout (default: `en-us`)

## MCP Tools Provided

### Diagnostics
0. **`pikvm_version`** - Return the running pikvm-mcp-server version. Use to detect a stale deployment: query this and compare against the version on `main` (currently 0.5.35). If they differ, redeploy before trusting any iPad behavior — older servers lack critical iPad-safety fixes (e.g. `forbidSlamFallback`).
0a. **`pikvm_health_check`** - One-call deployment health report: server version, mouseAbsoluteMode + safety-guard implication, live HID profile, iPad bounds detection. Run FIRST after deployment to verify safety guards are active and the target is what you think it is. Surfaces stale deployments (version mismatch), failed startup detection (mouseAbsoluteMode at safe default), and target type (iPad portrait/landscape vs other).

### Display
1. **`pikvm_screenshot`** - Capture current screen as JPEG
2. **`pikvm_get_resolution`** - Get current screen resolution (useful for mouse coordinates)

### Keyboard
3. **`pikvm_type`** - Type text (handles special chars correctly via keymap)
4. **`pikvm_key`** - Send key/combo (e.g., Ctrl+Alt+Del)
5. **`pikvm_shortcut`** - Send keyboard shortcut (multiple keys pressed simultaneously)

### Mouse
6. **`pikvm_mouse_move`** - Move mouse cursor (absolute or relative)
7. **`pikvm_mouse_click`** - Click mouse button
8. **`pikvm_mouse_scroll`** - Scroll wheel

### Calibration (absolute-mouse targets)
9. **`pikvm_calibrate`** - Start mouse coordinate calibration (moves cursor to screen center)
10. **`pikvm_set_calibration`** - Set calibration correction factors after visual verification
11. **`pikvm_get_calibration`** - Get current calibration state
12. **`pikvm_clear_calibration`** - Clear calibration, revert to uncalibrated mode
13. **`pikvm_auto_calibrate`** - Vision-based auto-calibration (preferred)

### Relative-Mouse Targets (iPad, etc. — `mouse.absolute=false`)
14. **`pikvm_ipad_unlock`** - Unlock iPad via USB HID swipe-up gesture (800 px default). Verified on iPad portrait in 1920x1080 HDMI frame.
15. **`pikvm_mouse_move_to`** - Approximate move-to-pixel via slam-to-corner + delta emission. Returns screenshot for visual verification.
16. **`pikvm_mouse_click_at`** - `pikvm_mouse_move_to` + `mouseClick` + click verification (pre/post screenshot diff; returns `screenChanged: true|false`). Use the verdict to detect missed clicks instead of eyeballing screenshots; opt out via `verifyClick: false`.
17. **`pikvm_measure_ballistics`** - Characterise relative-mouse px/mickey via screenshot-diff sampling. Writes profile to `./data/ballistics.json`. Best-effort on iPad — fragile on the home screen due to animated widgets.

**Important on relative-mouse targets**: the absolute-mouse tools (`pikvm_mouse_move`, `pikvm_mouse_click` with x/y, all `pikvm_calibrate*`, `pikvm_auto_calibrate`) do NOT move the iPad pointer because iPadOS only accepts USB boot-mouse descriptor (relative deltas). Agents targeting an iPad should use the relative-mouse tools above.

**Strong recommendation for iPad targets: prefer keyboard workflows over cursor clicks.** USB HID keyboard input is reliable; cursor positioning is fragile because iPadOS pointer acceleration is non-disableable and varies run-to-run. Use `pikvm_shortcut(["MetaLeft","Space"])` + `pikvm_type(<app>)` + `pikvm_key("Enter")` to launch apps via Spotlight; `pikvm_shortcut(["MetaLeft","KeyF"])` to focus in-app search bars. Reserve `pikvm_mouse_click_at` for UI elements with no keyboard equivalent. See `docs/skills/ipad-keyboard-workflow.md` for the recommended pattern and `docs/skills/ipad-setup.md` for iPadOS-version-aware setup.

## MCP Prompts & Skill Tools

The server exposes skills as both MCP prompts (`prompts/list` / `prompts/get`) and read-only `skill_*` tools (`tools/list` / `tools/call`). The skill tools are auto-generated from prompt definitions for marketplace visibility (e.g. LobeHub indexes tools, not prompts).

**Total tools: 40** (19 `pikvm_*` hardware/diagnostic tools + 21 `skill_*` guidance tools = 14 tool-guide + 7 workflow).

### Tool Guides
| Prompt | Skill Tool | Covers |
|---|---|---|
| `take-screenshot` | `skill_take_screenshot` | pikvm_screenshot |
| `check-resolution` | `skill_check_resolution` | pikvm_get_resolution |
| `type-text` | `skill_type_text` | pikvm_type |
| `send-key` | `skill_send_key` | pikvm_key |
| `send-shortcut` | `skill_send_shortcut` | pikvm_shortcut |
| `move-mouse` | `skill_move_mouse` | pikvm_mouse_move |
| `click-element` | `skill_click_element` | pikvm_mouse_click |
| `auto-calibrate` | `skill_auto_calibrate` | pikvm_auto_calibrate |
| `scroll-page` | `skill_scroll_page` | pikvm_mouse_scroll |
| `detect-orientation` | `skill_detect_orientation` | pikvm_detect_orientation |
| `ipad-unlock` | `skill_ipad_unlock` | pikvm_ipad_unlock |
| `measure-ballistics` | `skill_measure_ballistics` | pikvm_measure_ballistics |
| `move-to` | `skill_move_to` | pikvm_mouse_move_to |
| `click-at` | `skill_click_at` | pikvm_mouse_click_at |

### Workflow Recipes
| Prompt | Skill Tool | Arguments | Description |
|---|---|---|---|
| `setup-session-workflow` | `skill_setup_session_workflow` | — | Initialize session: resolution, screenshot, calibrate |
| `calibrate-mouse-workflow` | `skill_calibrate_mouse_workflow` | — | Full mouse calibration procedure |
| `auto-calibrate-mouse-workflow` | `skill_auto_calibrate_mouse_workflow` | — | Vision-based auto-calibration |
| `click-ui-element-workflow` | `skill_click_ui_element_workflow` | element_description (required) | Find and click a UI element |
| `fill-form-workflow` | `skill_fill_form_workflow` | form_description (optional) | Fill in form fields |
| `ipad-keyboard-first-workflow` | `skill_ipad_keyboard_first_workflow` | goal (required) | Reliable keyboard-first iPad workflow that bypasses cursor positioning |
| `navigate-desktop-workflow` | `skill_navigate_desktop_workflow` | goal (required) | Navigate desktop with Observe-Plan-Act-Verify loop |

Implementation: `src/prompts/` (types.ts, tool-guides.ts, workflows.ts, skill-tools.ts, index.ts). Human-readable guides: `docs/skills/`.

## Key Implementation Notes

- PiKVM often uses self-signed SSL certificates - disable verification or add CA
- The `/api/hid/print` endpoint is the best way to type text - it handles keymap conversion
- Mouse coordinates are absolute (0-based, screen resolution dependent)
- Some operations may need delays between them for the target system to process
- **Calibration**: Mouse coordinates often need calibration at different resolutions. The calibration workflow is: call `pikvm_calibrate` to move cursor to center, take a screenshot to verify actual position, then call `pikvm_set_calibration` with correction factors. Calibration is automatically invalidated when resolution changes.

## Testing

### Unit tests (offline)

```bash
npm test           # vitest, ~12 s, 250+ tests
npm run typecheck  # tsc --noEmit
```

Tests live in `__tests__/` directories alongside the production
modules they cover:
- `src/__tests__/` — `loadConfig`
- `src/pikvm/__tests__/` — cursor detection, motion-diff, template
  matching, ballistics, orientation, iPad-unlock, move-to helpers
- `src/prompts/__tests__/` — prompt registries, MCP-skill-tool
  generation

Tests are TDD-style: production behaviour is pinned by the test,
so a refactor that changes behaviour fails fast. PiKVMClient-using
helpers are tested with a recorded-call mock client — no network
access required.

Behaviour-change tests follow red→green: write the failing test
that captures the desired new behaviour, then change production
until it passes. Test names beginning `REGRESSION:` document a
specific bug the test was added to catch.

### Live tests (requires real PiKVM)

Test against a real PiKVM device:
- URL: `https://<your-pikvm-ip>`
- Access via: PiKVM web interface at `/kvm/`

The `test-client.ts` script (gitignored) drives the local source
against a live PiKVM, useful for debugging cursor-detection
issues that don't reproduce in unit tests. Modes include:
`smoke`, `full`, `moveto`, `click`, `bench`, `latency-probe`,
`unlock-and-click`. See the file's mode dispatcher for the full
list.

For iPad-specific cursor-detection troubleshooting, see
`docs/troubleshooting/ipad-cursor-detection.md` — captures the
phase-by-phase progression from "phantom cursor" to the latency
root cause to the current opt-in `progressiveOpenLoop` mode.

## References

- See `CONTEXT.md` for background research
- See `API_REFERENCE.md` for PiKVM API details
- PiKVM GitHub: https://github.com/pikvm/kvmd
- MCP SDK: https://github.com/modelcontextprotocol
