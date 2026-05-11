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
0. **`pikvm_version`** - Return the running pikvm-mcp-server version. Use to detect a stale deployment: query this and compare against the version on `main` (currently 0.5.40). If they differ, redeploy before trusting any iPad behavior — older servers lack critical iPad-safety fixes (e.g. `forbidSlamFallback`).

Current version on `main`: 0.5.64 (Phase 73 — refreshed click-at skill prompt with bench-backed reliability matrix. Phase 65-72 chain: tighter linear correction config, progressive-wake template-match retries, removed legacy probeDelta override, opt-in lock-screen auto-recovery via `autoUnlockOnDetectFail`).
0a. **`pikvm_health_check`** - One-call deployment health report: server version, mouseAbsoluteMode + safety-guard implication, **streamer source state (Phase 189: distinguishes "PiKVM down" from "device behind HDMI is off")**, live HID profile, iPad bounds detection, screen brightness. Run FIRST after deployment to verify safety guards are active and the target is what you think it is. Surfaces stale deployments (version mismatch), failed startup detection (mouseAbsoluteMode at safe default), source-side outages (e.g. iPad battery dead → `Streamer source: OFFLINE`), and target type (iPad portrait/landscape vs other). **Run this FIRST when `pikvm_screenshot` returns 503** — it tells you whether the issue is PiKVM or the source device.

### Display
1. **`pikvm_screenshot`** - Capture current screen as JPEG
2. **`pikvm_get_resolution`** - Get current screen resolution (useful for mouse coordinates)

### Keyboard
3. **`pikvm_type`** - Type text (handles special chars correctly via keymap)
4. **`pikvm_key`** - Send key/combo (e.g., Ctrl+Alt+Del)
5. **`pikvm_shortcut`** - Send keyboard shortcut (multiple keys pressed simultaneously)
5a. **`pikvm_dismiss_popup`** - Run the hidden-popup-dismiss recipe (Escape → Enter). Use when click_at returns success but the screenshot shows no UI change — the dominant cause is an iOS HDMI-blocked security popup (Apple Pay / Face ID / Low Battery / app permission) eating the input. Live-verified twice on Low Battery modals (10% and 5% — both dismissed cleanly with one Escape).

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
14. **`pikvm_ipad_unlock`** - Unlock iPad. Phase 217 (v0.5.205): sends Esc + Enter + Space first; Enter is the actual unlock key on iPadOS 26 lock screens (Space alone stopped working between Phase 210 and 2026-05-10). The 1500-px swipe-up gesture (Phase 209 default) only runs when keys fail or `swipeOnKeyPressFailure: false` (Phase 219 v0.5.206). Verified live on iPad portrait — bounds detection adapts to whatever HDMI capture resolution is in use (verified at both 1920×1080 and 1680×1050).
14a. **`pikvm_ipad_home`** - Return to the iPad home screen via Cmd+H. Idempotent on the home screen; dismisses any foreground app. **Cmd+H does NOT dismiss the App Switcher** — pass `forceHomeViaSwipe: true` (Phase 214 v0.5.202) for guaranteed home-screen state when the iPad may be in App Switcher mode. The swipe path also sends defensive Esc+Enter (Phase 231 v0.5.207, undoes accidental re-lock) followed by 6×100 px chunked Y emits (Phase 235 v0.5.208, deposits cursor mid-screen — the swipe alone leaves cursor pinned at the top edge, blocking subsequent moveToPixel calls to bottom-half targets). Does NOT unlock the lock screen — call `pikvm_ipad_unlock` first.
14b. **`pikvm_ipad_app_switcher`** - Open the iPad app-switcher (Cmd+\\ or hardware home gesture). Useful to verify which app is foreground or to switch between apps.
14c. **`pikvm_ipad_launch_app`** - Launch any iPad app via the verified keyboard-first pipeline (unlock → Cmd+Space Spotlight → type → Enter). 100% reliable across Settings, Files, App Store, Maps, Safari (live-validated). Far more reliable than clicking icons.
15. **`pikvm_mouse_move_to`** - Approximate move-to-pixel via slam-to-corner + delta emission. Returns screenshot for visual verification.
16. **`pikvm_mouse_click_at`** - `pikvm_mouse_move_to` + `mouseClick` + click verification (pre/post screenshot diff; returns `screenChanged: true|false`). Use the verdict to detect missed clicks instead of eyeballing screenshots; opt out via `verifyClick: false`.
17. **`pikvm_measure_ballistics`** - Characterise relative-mouse px/mickey via screenshot-diff sampling. Writes profile to `./data/ballistics.json`. Best-effort on iPad — fragile on the home screen due to animated widgets.
18. **`pikvm_seed_cursor_template`** - Bootstrap a cursor template for Phase 51 pre-click verification. Wakes the cursor with a small relative emit, diffs before/after to find it, and persists a 24×24 template (gated by `looksLikeCursor`). Use ONCE after a fresh deployment or after clearing `data/cursor-templates/`. Subsequent clicks accumulate templates automatically. Safe on iPad — uses small relative emits only, never slams to corner.

**Important on relative-mouse targets**: the absolute-mouse tools (`pikvm_mouse_move`, `pikvm_mouse_click` with x/y, all `pikvm_calibrate*`, `pikvm_auto_calibrate`) do NOT move the iPad pointer because iPadOS only accepts USB boot-mouse descriptor (relative deltas). Agents targeting an iPad should use the relative-mouse tools above.

**Strong recommendation for iPad targets: prefer keyboard workflows over cursor clicks.** USB HID keyboard input is reliable; cursor positioning is fragile because iPadOS pointer acceleration is non-disableable and varies run-to-run. Use `pikvm_shortcut(["MetaLeft","Space"])` + `pikvm_type(<app>)` + `pikvm_key("Enter")` to launch apps via Spotlight; `pikvm_shortcut(["MetaLeft","KeyF"])` to focus in-app search bars. Reserve `pikvm_mouse_click_at` for UI elements with no keyboard equivalent. See `docs/skills/ipad-keyboard-workflow.md` for the recommended pattern and `docs/skills/ipad-setup.md` for iPadOS-version-aware setup.

**Phase 61/62 finding (2026-04-26)** — iPad Settings sidebar IS keyboard-navigable: `pikvm_key("Escape")` walks UP the navigation stack (sub-page → category → root); `pikvm_key("ArrowDown"/"ArrowUp")` walks the sidebar list; the right pane updates automatically as selection moves. **Caveat (Phase 62)**: in-pane Tab/Return navigation requires iPadOS's *Full Keyboard Access* to be enabled (one-time setup at Settings → Accessibility → Keyboards → Full Keyboard Access — needs ONE coordinate-based click to flip). Without FKA, only the sidebar is keyboard-reachable. See `docs/troubleshooting/ipad-cursor-detection.md` § Phase 61/62 for the verified trace.

**iPad click-accuracy by target size (Phase 65 + retries=2, bench n=10)**:

**iPad must be UNLOCKED before bench/click_at use.** Lock-screen frames have no cursor, all detect-then-move calls fail. After Phases 65/68/69 + clean state:

> **HONESTY NOTE (Phase 214/235/244/248-249, 2026-05-11, v0.5.214):** the
> rates below predate Phase 214's App Switcher root-cause finding,
> Phase 235's chunked mid-screen cursor deposit, Phase 244's
> correction-pass locality gate, and Phase 248/249's opt-in
> `useKnownFpBlocklist`. Phase 248 first N=20 looked like 25% → 40%
> with-blocklist, but second N=20 regressed to 5%; cumulative N=40
> with blocklist is 22.5% vs baseline 25% — within Phase 237 variance.
> Per Phase 237's lesson: ALL the rates below need an N≥30 re-bench
> before being trusted. See `docs/troubleshooting/ipad-cursor-detection.md`
> § "Phase 244" for the latest architectural state and
> `2026-05-11-phase-248-fp-blocklist.md` for the Phase 248 cumulative data.

| Target width | Hit rate (per attempt) | Hit rate (3 attempts) | Examples |
|--------------|------------------------|----------------------|----------|
| ≥ 200 px     | ~80% (residual ≤ 100 px) | ~99% | Sidebar rows, large buttons, full-width banners |
| 100-200 px   | ~70% (residual ≤ 100 px) | ~97% | App icons (~100 px), search-bar fields |
| 50-100 px    | ~60% (residual ≤ 50 px)  | **~50-60%** | Standard buttons, page tabs, **~70 px icons (Phase 111 measured)** |
| < 50 px      | ~50% (residual ≤ 25 px)  | ~88% | Back arrows, X buttons, toggles |

(Measured Phase 69 + iPad unlocked, bench n=10: `5/10 ≤25 px` per-attempt; 1/10 detect-failure. Sample residuals: 8, 11, 7, 20, 11 px.) `pikvm_mouse_click_at` is now production-reliable for tiny targets WITH retries — was ~27% 3-attempt rate pre-Phase-68, now ~88%.

**Important nuance**: `screenChanged: true` means a click happened SOMEWHERE clickable, not that the intended target was hit. Live verified 2026-04-27: a click 60 px off landed on a SIDEBAR row instead of the targeted right-pane row — both produce `screenChanged: true`. For automation that depends on hitting the RIGHT element, EITHER (a) verify via post-click screenshot inspection, OR (b) pass `maxResidualPx: 25` (Phase 88, v0.5.79+) so attempts landing more than 25 px from target are refused at the source — trades absolute hit rate for correct-element confidence.

The numbers are derived from observed median residual ~50-80 px on iPad with iPadOS 26, where motion-diff fails to detect the cursor entirely on 20-40% of attempts (counted as misses). For targets ≥ 200 px, the algorithm is highly reliable with retries; for tiny targets, miss rate is high. **For tiny targets (toggles, back arrows): prefer keyboard workflows when available** — see Phase 61/62 sidebar-arrow-key navigation. Reproducible bench: `bench-clickretry.ts`.

**v0.5.97+ cursor-verification update** (Phase 102-107 chain): the cursor-template cache was found to be 87.5% contaminated with letter glyphs from the iPad's "GS" Apple Account avatar — every `findCursorByTemplateSet` call had been mostly false-positive matching letters on screen. Phase 106 architectural fix (mask-based template extraction) restored template-match to a useful state. Post-Phase-107 bench (n=10 on iPad Settings): cursor-verification rate jumped from 60-70% to 100%; Phase 65 micro-step config achieves 9/10 trials within 25 px (median residual 6 px). The Phase 87 "Important nuance" wrong-element-hit risk specifically due to false-positive template matches is materially reduced — `maxResidualPx: 25` becomes more useful because cursor positions are now reliably verified before the gate fires.

**Phase 109-115: click-success ceiling on tiny iPad icons + the user-side fix**: Phase 109-114 measured click-success at ~50-60% on ~70 px icon-sized targets via N=15 across multiple modes (single-shot, retries, micro-step, 300ms settle, 5-position dither). Cursor verification is 100% but iPadOS pointer-effect snap-zone heuristic doesn't reliably register synthetic-mouse clicks. **Phase 115 user-side recommendation**: enabling **Settings → Accessibility → Motion → Reduce Motion** on the iPad disables pointer-effect snap, after which click-success should track cursor-positioning accuracy (~95%+ with retries). It's a user-side toggle with broader UX implications (no widget/app animations) — see `docs/troubleshooting/ipad-cursor-detection.md` § Phase 115 for context.

## MCP Prompts & Skill Tools

The server exposes skills as both MCP prompts (`prompts/list` / `prompts/get`) and read-only `skill_*` tools (`tools/list` / `tools/call`). The skill tools are auto-generated from prompt definitions for marketplace visibility (e.g. LobeHub indexes tools, not prompts).

**Total tools: 46** (25 `pikvm_*` hardware/diagnostic tools + 21 `skill_*` guidance tools = 14 tool-guide + 7 workflow).

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
