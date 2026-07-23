# desktop-workflow

> MCP Prompt: `desktop-workflow`

Set up a generic desktop (Windows / macOS / Linux) for **reliable mouse control**
through the PiKVM MCP server. This is the SETUP + POSITIONING counterpart to the
iPad path; for app navigation once the mouse is reliable, use
[`navigate-desktop-workflow`](./navigate-desktop-workflow.md).

## Arguments

None.

## Why a separate desktop flow

A desktop uses **absolute** mouse positioning; the iPad path uses **relative**
deltas (boot-mouse + non-disableable pointer acceleration). The regimes are
picked by the server's `--target` flag — there is no auto-detect — and mixing
them fails. See [desktop-support gap analysis](../desktop-support-gap-analysis.md).

## Steps

1. **Run the server in desktop mode.** Start with `--target desktop`
   (NixOS: `services.pikvm-mcp.target = "desktop"`). Confirm the mouse is in
   absolute mode with `pikvm_health_check`.
2. **Calibrate once** with `pikvm_auto_calibrate` — cursor-agnostic (diffs
   screenshots to find *what moved*, so it works on a black desktop arrow). See
   [`auto-calibrate-mouse-workflow`](./auto-calibrate-mouse-workflow.md).
   Recalibrate if the resolution changes.
3. **Position with absolute moves** — the reliable default:
   `pikvm_mouse_move(x, y)` (exact, no cursor detection) then
   `pikvm_mouse_click`, then `pikvm_screenshot` to verify.
   - `pikvm_mouse_click_at` (high-accuracy detect-then-move) degrades cleanly on
     desktop, but its motion-diff probe constants are iPad-tuned and can miss on a
     linear absolute-mouse desktop — prefer plain absolute move/click; use
     `click_at` only when you need a cursor-verified landing.
4. **Keyboard is fully general** — `pikvm_type` / `pikvm_key` / `pikvm_shortcut`
   are plain USB-HID, identical on desktop and iPad.
5. **Don't reach for the iPad tools** — `pikvm_ipad_unlock` / `pikvm_ipad_home` /
   app-switcher / launch-app are iPad-only and irrelevant on a desktop.
6. **Navigate, then measure** — for opening apps / finding files switch to
   [`navigate-desktop-workflow`](./navigate-desktop-workflow.md); to measure this
   machine's click accuracy run the desktop e2e harness (`benches/desktop-e2e.ts`,
   auto-calibrate → absolute moves at a grid → residual p50/p90).

## Related

- [click_at full-frame audit](../desktop-click-at-fullframe-audit.md) — how the
  high-accuracy mover degrades on a full-frame desktop.
- [desktop-support gap analysis](../desktop-support-gap-analysis.md).
