# pikvm_ipad_unlock — Unlock the iPad from Lock Screen

## Purpose
iPadOS requires a swipe-up-from-bottom gesture to dismiss the lock screen. With a USB HID mouse (which is what PiKVM provides when `mouse.absolute=false`), this translates to: position cursor → press → rapid upward drag → release. This tool packages the verified gesture parameters so agents don't have to reinvent them.

## Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| slamFirst | boolean | true | Slam to top-left first for a known origin |
| startX | number | 955 | HDMI X of swipe start (iPad portrait center) |
| startY | number | 1035 | HDMI Y of swipe start (just above home indicator) |
| dragPx | number | 800 | Total upward drag distance |
| chunkMickeys | number | 30 | Per-call mickey size (smaller = faster motion) |

## Example Call
```json
{ "name": "pikvm_ipad_unlock", "arguments": {} }
```

## When to Use
- Before any click/move operation if a fresh screenshot shows the lock screen.
- After a long period of inactivity (iPadOS auto-locks after 30 s – 2 min by default).

## Side Effects on Already-Unlocked iPads
This tool emits the iPadOS swipe-up-from-home-indicator gesture. iPadOS interprets it differently depending on state:

| State | Result |
|---|---|
| Lock screen | Unlocks → home screen (intended use) |
| Home screen | No-op ("go home" is idempotent when already home) |
| **Inside an app** | **Closes the app** and returns to home screen |

**Check with `pikvm_screenshot` first** if there's a risk the iPad is inside an app you don't want to dismiss.

## Tips
- **Check the returned screenshot.** If the iPad is still on the lock screen, call again with `dragPx: 1000` or `1200`.
- If the swipe consistently fails, the iPad's letterbox offset may differ on your device. Measure where the home indicator actually is in your screenshots and override `startX`/`startY`.
- Empirically verified on the reference iPad: 400 px drag does NOT unlock; 800 px does. Speed matters less than total distance.
