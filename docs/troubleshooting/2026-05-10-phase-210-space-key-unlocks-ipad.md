# Phase 210 (v0.5.199) — Space key press unlocks iPad reliably; HID-mouse swipe doesn't work on this iPad

**Date:** 2026-05-10
**Discovery:** Critical production reliability finding via live test.

> **SUPERSEDED by Phase 217 (2026-05-10, v0.5.205) and Phase 219 (v0.5.206).**
> The `Space` key alone stopped unlocking iPadOS 26 lock screens later
> the same day. Current `unlockIpad` sequence is **Esc → Enter →
> Space**, with `Enter` being the actual unlock key. The follow-up
> swipe is now SKIPPED by default (`swipeOnKeyPressFailure: true`)
> because running the swipe on an already-unlocked home screen
> takes the iPad back to the lock screen. See:
> - `2026-05-10-phase-217-enter-key-unlocks-ipad.md`
> - `2026-05-10-phase-219-unlock-from-home-locks-ipad.md`
>
> This Phase 210 doc is preserved as historical record.

## Background

`pikvm_ipad_unlock` previously relied entirely on a HID-mouse swipe
gesture (cursor move + button hold + upward drag + button release).
Documented to work with `dragPx=800` empirically.

## What the live test showed

After `pikvm_mouse_click_at` accidentally locked the iPad via
hot-corner (Phase 208), tried to unlock with default settings:

| Attempt | dragPx | startY | slamFirst | Result |
|:--------|:------:|:------:|:---------:|:-------|
| 1 | 800 (default) | auto | true | Lock screen unchanged |
| 2 | 1200 | auto | true | Lock screen unchanged |
| 3 | 1500 | auto | true | Lock screen unchanged |
| 4 | 2000 | auto | false | Lock screen unchanged |
| 5 | 1000 | 960 (manual) | false | Lock screen unchanged |
| 6 | n/a | n/a | n/a | **Space key press → UNLOCKED** |

The HID swipe was being emitted correctly each time (tool reported
correct chunk counts and durations) but iPadOS didn't recognize it
as the unlock gesture. Likely an iPadOS 26+ behavior change where
HID-mouse swipes no longer clear the lock (or this iPad has stricter
unlock requirements).

A simple `Space` key press woke the iPad immediately, which then
resolved into the home screen after a brief app-switcher
transition.

## The fix (Phase 210, v0.5.199)

`unlockIpad` now tries a Space key press FIRST before any swipe:

```ts
if (options.tryKeyPressFirst !== false) {
  try {
    await client.sendKey('Space');
    await sleep(600);
  } catch { /* fall through to swipe */ }
}
// ... existing swipe path runs as fallback
```

The swipe path is preserved as fallback — for iPads where Space
might have a different effect (locked into Camera, etc.) the
swipe still runs. The keypress is opt-out via
`tryKeyPressFirst: false`.

## Risk assessment

If the iPad is **already unlocked** when `unlockIpad` is called:
- Space key COULD insert a space character into a focused text field
- Documented risk; the function's docstring already says it's
  intended for the lock screen

If the iPad is on the **lock screen**:
- Space wakes it (tested successful)
- Swipe path then runs as no-op (iPad already woken)

Net behavior: more reliable unlock, slightly more aggressive
input emission when called incorrectly. Acceptable trade-off
given the previous behavior failed completely on this iPad.

## Practical impact

Users who saw `pikvm_ipad_unlock` "succeed" but the iPad still
on lock screen will now see actual successful unlocks. The Phase
209 dragPx default bump was insufficient on its own — the
underlying mechanism (mouse swipe → unlock gesture) is broken
on this iPadOS version.

## Why a key press was never tried before

The codebase has been optimizing the swipe gesture (chunkSize,
startY auto-detect, dragPx tuning) but never questioned the
fundamental approach. Sometimes the simpler tool is the right
one. This was discovered only by running the live tool, seeing
it fail, and trying alternatives until one worked.

## State at v0.5.199

- 673/673 tests pass
- nix build green
- Working tree clean
- All pushed
- iPad currently unlocked and on home screen (validated via
  screenshot 2026-05-10 08:07)
