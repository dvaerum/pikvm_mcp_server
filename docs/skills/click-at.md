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

| Target width | Per-attempt hit | 3-attempt hit | Examples |
|--------------|-----------------|---------------|----------|
| ≥ 200 px | ~80% | ~99% | Sidebar rows, large buttons |
| 100-200 px | ~70% | ~97% | App icons, search fields |
| 50-100 px | ~60% | ~94% | Standard buttons, page tabs |
| < 50 px | ~50% | ~88% | Back arrows, X buttons, toggles |

**Set `maxRetries: 2` for iPad targets** — turns ~50% per-attempt into ~88% reliable end-to-end for tiny targets.

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
| maxRetries | number | 0 | **Recommended 2** on iPad |
| autoUnlockOnDetectFail | boolean | false | Phase 72 opt-in lock-screen recovery |
| verifyClick | boolean | true | Pre/post screenshot diff confirms click landed |
| strategy | string | detect-then-move | DO NOT use slam-then-move on iPad — re-locks via hot corner |

## Recommended call shapes

**Reliable iPad click on a known-unlocked iPad:**
```json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700, "maxRetries": 2 } }
```

**Self-recovering click (assumes iPad might be locked / faded):**
```json
{ "name": "pikvm_mouse_click_at", "arguments": { "x": 1060, "y": 700, "maxRetries": 2, "autoUnlockOnDetectFail": true } }
```

## When NOT to Use
- Tiny targets (< 30 px): even with retries, hit rate drops below 80%. Use keyboard navigation if available — see [ipad-keyboard-workflow.md](ipad-keyboard-workflow.md).
- Anywhere a keyboard shortcut exists: keyboard input is 100% reliable vs cursor's 80-99%.

## Tips
- Take a `pikvm_screenshot` first to confirm the target pixel is where the UI element actually is — icon positions change between app rearrangements and iOS versions.
- After the click, examine the returned screenshot: did the expected app open / dialog appear? If not, the click missed — retry or fall back to keyboard.
