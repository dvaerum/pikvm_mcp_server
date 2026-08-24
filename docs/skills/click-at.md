# pikvm_mouse_click_at — Click at an Approximate Screen Pixel (Relative Mode)

> **iPad users — strongly prefer the keyboard-first workflow.**
> Most tasks (launching apps, navigating Settings, searching) are far
> more reliable via Cmd+Space / Cmd+F / type than via cursor clicks.
> See [ipad-keyboard-workflow.md](ipad-keyboard-workflow.md) for the
> recommended pattern. Use this tool only when no keyboard equivalent
> exists for the UI element you need to interact with.
>
> If you do need to click, also see [ipad-setup.md](ipad-setup.md) for
> recommended iPadOS settings (Reduce Motion ON, Auto-Lock ≥ 4 min).

## Purpose
On a PiKVM target in relative mouse mode (iPad), move the pointer to an approximate target pixel and click. Internally: `pikvm_mouse_move_to` → brief settle → `mouseClick`. Returns a post-click screenshot.

## Reliability (Phase 70-78 measurements, v0.5.69)

> **HONESTY NOTE (Phase 214/219/235/244, 2026-05-10, v0.5.211):**
> the rows below predate Phase 214's finding that prior measurements
> may have been against the App Switcher state (because Cmd+H doesn't
> dismiss the App Switcher — `pikvm_ipad_home` now exposes
> `forceHomeViaSwipe: true` for guaranteed home-screen state, with
> Phase 235 mid-screen cursor deposit baked in). Phase 244 added the
> Phase 197 locality-gate to the correction-pass; net effect is fewer
> confident-wrong template matches but more null detections. Recent
> short-N runs show ~20-33% within 35 px on first-attempt, but Phase
> 237's variance lesson means any single N=10 isn't conclusive. Treat
> the rates below as pre-Phase-214 historical numbers; the 50-100 px
> row in particular needs N≥30 re-measurement on a confirmed home
> screen. See `docs/troubleshooting/2026-05-10-phase-214-app-switcher-root-cause.md`
> and `2026-05-10-phase-244-correction-pass-locality-gate.md`.

| Target width | Per-attempt hit | 3-attempt hit | Examples |
|--------------|-----------------|---------------|----------|
| ≥ 200 px | ~80% | ~99% | Sidebar rows, large buttons |
| 100-200 px | ~70% | ~97% | App icons, search fields |
| 50-100 px | ~60% | **~50-60%** | Standard buttons, page tabs, ~70 px iPad icons (Phase 111 measured — pre-Phase-214; re-bench needed) |
| < 50 px | ~50% | ~88% | Back arrows, X buttons, toggles |

**Retry removed (2026-07-28)**: every click is now single-attempt — the old Phase 94/142 `maxRetries` auto-default was double-firing keypads, and positioning turned out to be single-shot-reliable (faded cursors are recovered by the built-in wake) so the retry loop's only remaining effect was harm. `maxRetries` is no longer accepted; the per-attempt rates in the table above are the actual end-to-end rates now.

**Silent failure remedy**: when click_at returns success but the post-click screenshot shows no UI change, the dominant cause is an iOS HDMI-blocked security popup (Apple Pay / Face ID / Low Battery / app permission) eating input. iPadOS deliberately blanks these from HDMI capture but keyboard input still reaches them. Call **`pikvm_dismiss_popup`** to fire the documented Escape → Enter recipe, then retry the click. Live-verified twice on Low Battery modals (10% and 5% — both dismissed cleanly with one Escape).

## Critical pre-flight

The iPad MUST be unlocked. Detect-then-move can't find the cursor against the lock-screen wallpaper. Options:

1. Take a `pikvm_screenshot` first to confirm not on lock screen.
2. Pass `autoUnlockOnDetectFail: true` (Phase 72) for opt-in self-recovery — note this calls `ipadGoHome` which exits any open app.
3. Just call `pikvm_ipad_unlock` first if you suspect it might be locked.

## Parameters (key ones)
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | Target X in HDMI screenshot pixels |
| y | number | *(required)* | Target Y in HDMI screenshot pixels |
| button | string | left | left / right / middle / up / down |
| autoUnlockOnDetectFail | boolean | false | Phase 72 opt-in lock-screen recovery |
| maxResidualPx | number | 15 (iPad) / unset (desktop) | Phase 88 (task #38 tightened the iPad default 25→15): skip the click if cursor lands more than N px from target — refuses imprecise clicks that risk hitting adjacent UI elements. Override via `PIKVM_CLICK_MAX_RESIDUAL_PX`. |
| verifyClick | boolean | true | Pre/post screenshot diff confirms click landed (advisory — never blocks the click itself) |
| strategy | string | detect-then-move | DO NOT use slam-then-move on iPad — re-locks via hot corner |

## Recommended call shapes

**Reliable iPad click on a known-unlocked iPad:**
```json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700 } }
```

**Self-recovering click (assumes iPad might be locked / faded):**
```json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700, "autoUnlockOnDetectFail": true } }
```

**Strict-target click (refuse to click on the wrong adjacent element):**
```json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700, "maxResidualPx": 25 } }
```
With `maxResidualPx: 25`, a click that lands more than 25 px from the target is skipped rather than fired (reported not-landed). Trades absolute hit rate for "I clicked the right thing" confidence — useful when the target is near other clickable elements that could be accidentally hit.

## When NOT to Use
- Tiny targets (< 30 px): hit rate drops below 80% and there's no retry to fall back on. Use keyboard navigation if available — see [ipad-keyboard-workflow.md](ipad-keyboard-workflow.md).
- Anywhere a keyboard shortcut exists: keyboard input is 100% reliable vs cursor's 80-99%.

## Tips
- Take a `pikvm_screenshot` first to confirm the target pixel is where the UI element actually is — icon positions change between app rearrangements and iOS versions.
- After the click, examine the returned screenshot: did the expected app open / dialog appear? If not, the click missed — retry or fall back to keyboard.
