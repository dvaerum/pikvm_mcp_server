# iPad safety guards in moveToPixel

This document describes the layered defenses against accidentally
re-locking an iPad mid-session via the iPadOS hot-corner gesture.
If you're touching `move-to.ts` or designing a new high-level tool
that uses `moveToPixel`, read this first.

## Why the iPad-lock failure mode exists

PiKVM in `mouse.absolute=false` (relative-mouse mode, required for
iPad — see `pikvm-server-changes.md`) cannot teleport the cursor to
a known position. The only way to anchor cursor position is to
"slam" — emit ~30 consecutive `mouseMoveRelative(-127, -127)` calls,
which saturates the cursor at the top-left corner of whatever
screen iPadOS is rendering.

iPadOS treats the top-left corner as a hot corner. When the cursor
saturates there for >~150 ms, the iPadOS gesture engine triggers
"go to lock screen" — the same gesture as a swipe-down from the
top-left. The screen locks. Subsequent mouse input is dropped (the
lock screen ignores cursor) and the test session is destroyed.

This is non-recoverable from inside `moveToPixel` — you have to
call `pikvm_ipad_unlock` (which is itself slam+swipe-up, but on a
LOCKED iPad the hot-corner gesture is inactive).

## The defense layers

### Layer 1: `forbidSlamFallback` (Phase 11, v0.5.x)

Added to MoveToOptions. When `strategy='detect-then-move'` fails
(no cursor found via probe-and-diff or template match), the legacy
behaviour was to silently fall back to `slam-then-move` and try
again from a known-anchored position. On iPad this re-locked the
screen.

**Layer 1 throws an explicit error instead of slamming**, allowing
the caller to handle the failure (e.g. wake the iPad, call
`pikvm_ipad_unlock`, retry). The MCP tool layer sets it true when
the target reports `mouse.absolute=false`.

### Layer 2: `forbidSlamOnIpad` (Phase 32, v0.5.16)

Layer 1 only protected the auto-fallback path. **An LLM caller
explicitly passing `strategy='slam-then-move'` still slammed and
locked the iPad.** This was live-verified 2026-04-26: a single
explicit `pikvm_mouse_click_at(x, y, strategy='slam-then-move')`
call locked the iPad mid-session.

Layer 2 detects iPad-portrait letterbox before the slam path runs
(via `detectIpadBounds`). If detected, refuses with a clear error.

### Layer 3: Phase 32a fail-safe (v0.5.17)

Layer 2 only triggered when bounds were detected as portrait. If
bounds detection failed (e.g. dark-mode iPad with all-black
canvas, no content brighter than the letterbox), the guard let the
slam through — even though `moveToPixel` then fell back to
`LEGACY_PORTRAIT_SLAM_ORIGIN`, which is itself an iPad hint.

**Layer 3 refuses unless EITHER:**
- Bounds were detected AND show landscape orientation (clearly not
  iPad-letterbox), OR
- The caller explicitly passed `slamOriginPx` (taking responsibility
  for where to slam to), OR
- The caller opted out via `forbidSlamOnIpad: false`.

If we can't tell what the target is, we don't slam. This trades a
small false-positive rate (refusing slam on ambiguous non-iPad
targets) for absolute safety against the iPad-lock failure mode.

### Layer 4 (intentionally absent): `pikvm_ipad_unlock`

`ipad-unlock.ts` calls `slamToCorner(top-left)` directly. This
bypasses all the above layers BY DESIGN: when the iPad is locked,
the hot-corner gesture is inactive (no home screen to dismiss to),
so slamming is safe. The unlock flow then immediately drags upward
which dismisses any in-progress gesture state.

If `pikvm_ipad_unlock` is called when the iPad is already
unlocked, the slam may briefly trigger the hot-corner state but the
following swipe-up dismisses it before the lock fires. Empirically
verified safe across many iterations.

## How to write a tool that drives `moveToPixel` safely on iPad

1. Default to `strategy='detect-then-move'` and let layer 1 handle
   detection failures with a thrown error you can catch.
2. If you need an explicit anchored origin (rare), use
   `strategy='slam-then-move'` AND pass `slamOriginPx` explicitly so
   layer 3's fail-safe yields. Be aware: the slam will still hit
   the iPad's top-left and risk the hot corner — only do this if
   you've verified the iPad has hot-corners disabled.
3. Never set `forbidSlamFallback: false` or `forbidSlamOnIpad:
   false` in production code paths. Those exist only for tests
   that intentionally exercise the slam path with synthetic frames
   the bounds detector can't read.

## How to extend the safety surface

If a future change introduces a new code path that emits
`mouseMoveRelative(-127, -127)` >5 times in a row on an iPad, that
path needs its own version of the guard. Search for `slamToCorner`
to find all current call sites.

## Related docs

- `pikvm-server-changes.md` — why PiKVM is in relative-mouse mode
- `ipad-cursor-detection.md` — detection-pipeline architecture
- `ipad-touchscreen-hid-dead-end.md` — closed avenue: USB
  touchscreen HID descriptor is rejected by iPadOS
