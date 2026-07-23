# Desktop-support gap analysis (offline)

**Goal (project):** "give AI agents hands on a physical machine." The server began
desktop-focused (absolute-mouse calibration) and then specialised hard for iPad
(relative mouse). This is an offline audit of *what the MCP server needs to
reliably drive a generic desktop vs an iPad* — the code-side gaps, for the
iPad-equipped / desktop-HDMI node to then live-verify.

Author: pikvm-mcp-server@nixos-developer-system (offline). Live desktop side is
scoped in parallel by @georgs-mac-mini — compare/merge.

---

## TL;DR

The server is **~80% desktop-ready today** through the **absolute-mouse path**,
which is largely cursor-agnostic and free of iPad assumptions. The real gaps are
**verification** (no desktop e2e has ever been run — reliability is unmeasured),
a few **always-run helpers that assume an iPad letterbox**, and **missing
desktop workflow docs**. No large rebuild is needed; it's audit + verify + document.

The two regimes are already cleanly separated by one flag:

| | **iPad** (`--target ipad`, `mouse.absolute=false`) | **Desktop** (`--target desktop`, `mouse.absolute=true`) |
|---|---|---|
| HID | relative deltas (boot-mouse, non-disableable pointer accel) | absolute pixel positioning |
| Positioning | detect cursor + emit deltas (curve-one-shot / ballistics) | `mouse_move(x,y)` — exact, calibrated |
| Cursor detection | orange-cursor ML cascade + motion-diff + template | motion-diff only (for calibration); none for positioning |
| Calibration | `measure_ballistics` (px/mickey) | `auto_calibrate` (absolute factors) |

`mouseAbsoluteMode` (set by `--target`) already flips every relevant default:
strategy `curve-one-shot`→`detect-then-move`, `forbidSlamFallback` false,
brightness gate off, retries 0 (single-shot). (`src/index.ts` ~1247/1277/1322.)

---

## Already desktop-ready (absolute path)

- **Positioning is general and exact.** `client.pixelToNormalized` maps a
  screenshot pixel → HID signed-16-bit absolute range purely from `resolution` +
  calibration factors — **no iPad assumption**. `pikvm_mouse_move(x,y)` /
  `pikvm_mouse_click(x,y)` therefore work on any absolute-mode target.
- **Calibration is cursor-agnostic.** `pikvm_auto_calibrate` finds the cursor by
  `diffScreenshots`/`findClusters` (what *moved* between two frames), not by
  colour/shape — so it works with a black desktop arrow, unlike the orange-cursor
  ML cascade. No ML/letterbox/orange refs in `auto-calibrate.ts`.
- **Keyboard is fully general.** `pikvm_type` / `pikvm_key` / `pikvm_shortcut`
  are plain USB-HID — identical on desktop and iPad.
- **Screenshot / resolution** — general.
- **The high-accuracy mover degrades sanely.** On desktop, `move_to`/`click_at`
  default to `detect-then-move` (motion-diff, cursor-agnostic), not the iPad
  `curve-one-shot` (ML). Basic desktop control doesn't even need the mover —
  absolute `mouse_move(x,y)` after `auto_calibrate` is the clean flow.

## iPad-specific (not needed / not usable on desktop, but harmless)

- **Orange-cursor ML cascade** (`crop-heatmap`/v12, `findCursorByV8FullFrame`) —
  trained on the iPad's orange pointer; will not detect a desktop cursor. Only
  reached by `curve-one-shot`/`openLoopShape` (iPad-default paths). Desktop's
  `detect-then-move` uses motion-diff instead, so **no desktop dependency** — but
  forcing `strategy:curve-one-shot` on desktop would fail (the default avoids it).
- **Relative mover stack** — `curve-mover`, `ballistics`, `pointer-accel`,
  `open-loop-planner`: all model iPad pointer acceleration; unused in absolute mode.
- **iPad app-control tools** — `ipad_unlock`/`home`/`app_switcher`/`launch_app`:
  iPad-only; a desktop caller simply never invokes them (no interference).

---

## Gaps & risks (ranked)

1. **Unmeasured reliability — no desktop e2e exists.** Every bench targets the
   iPadCollector; the absolute path has no ground-truth harness and is far less
   exercised than the iPad path (likely bit-rot). *This is the #1 gap.* We don't
   actually know today's desktop click accuracy.
2. **Always-run helpers assume an iPad letterbox.** `detectIpadBounds` runs in
   `pikvm_health_check` and inside `pikvm_mouse_click_at` (brightness gate + slam
   guard). On a full-frame desktop (no letterbox) it returns full-frame or fails.
   `health_check` handles the fail gracefully; the `click_at` paths *should*
   degrade (slam is allowed on desktop via `forbidSlamFallback:false`, brightness
   gate is 0 on non-iPad) but this is **assumed, not verified** — needs an audit
   that a full-frame desktop doesn't trip a false abort.
3. **motion-diff params are iPad-tuned.** `locateCursor`'s cluster sizes, the
   brightness floor (~100), and wake-nudge magnitudes were calibrated on the iPad
   cursor/screen. On a desktop (small black cursor on a light UI) the diff
   sensitivity may differ. Only matters if `click_at` is used on desktop —
   absolute `mouse_move` needs no detection — but should be tuned/validated if we
   want the high-accuracy mover to work there.
4. **No desktop workflow / docs.** iPad has a keyboard-first workflow skill; there
   is no desktop guidance. The clean desktop flow (`auto_calibrate` → absolute
   `mouse_move`/`click`, skip the relative mover) is undocumented — a user would
   likely mis-reach for the iPad tools.
5. **Startup default is iPad-safe, not desktop-safe.** `mouseAbsoluteMode`
   defaults `false` (iPad) and `--target` is required; a desktop user must pass
   `--target desktop`. Correct + safe, but worth surfacing in desktop docs.

## Recommended next steps

- **(offline, me)** Write a desktop e2e harness skeleton: `auto_calibrate` →
  `mouse_move(x,y)` at N targets → screenshot-diff verify the cursor landed →
  `click` → verify screen change. Parameterise so a desktop-HDMI node just runs it.
- **(offline, me)** Audit the `click_at` always-run path for a full-frame desktop
  (confirm no false brightness-abort / no slam-forbid) and fix any letterbox
  assumption to degrade cleanly. Small, targeted.
- **(offline, me)** Add a `docs/skills/desktop-workflow.md` (absolute-path flow).
- **(live, desktop-HDMI node — @georgs to scope)** Run the e2e against a real
  desktop behind the PiKVM: measure absolute click accuracy after `auto_calibrate`;
  confirm motion-diff finds a desktop cursor if `click_at` is exercised.

**Bottom line:** desktop support is a *verify-and-polish* effort on an
already-present absolute path, not a rebuild. The one thing we cannot answer
offline — *does it actually work on a real desktop today?* — is the first thing
to measure.
