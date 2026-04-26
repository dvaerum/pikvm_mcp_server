# iPad setup for reliable PiKVM MCP control

One-time iPad-side checklist. Settings live on the iPad itself, not in the
MCP server config.

## Recommended for all iPadOS versions

### Auto-Lock ≥ 4 minutes (or Never for active sessions)
USB HID mouse input does **not** reset iPadOS's auto-lock timer.
30-second / 2-minute auto-lock will lock the iPad mid-sequence and
silently drop subsequent clicks. `pikvm_ipad_unlock` can recover, but
better to avoid the lock-out in the first place.

**How:** Settings → Display & Brightness → Auto-Lock → 5 Minutes (or Never).

### Display brightness HIGH (and Auto-Brightness OFF)
Phase 37/38 (v0.5.22+, live-verified 2026-04-26): if the iPad's
display is dimmed (mean RGB brightness below ~50/255), cursor
detection RELIABLY FAILS — every motion-diff probe returns no cursor
pair. The MCP server now refuses click_at calls in this state
(`pikvm_health_check` reports the brightness level).

The iPad's auto-brightness reduces the display in low ambient light
or after inactivity, and software-side gestures (swipe, key input)
do NOT restore it. Manual adjustment is required.

**How:**
- Settings → Display & Brightness → drag Brightness slider to 75–100%.
- Settings → Accessibility → Display & Text Size → Auto-Brightness → OFF.

If `pikvm_mouse_click_at` returns "screen too dim for cursor
detection (mean=X/255)", this is the setting to check first.

### Increase Contrast (Pointer)
Makes the cursor visibly brighter against varied wallpapers; helps the
brightness filter in motion-as-probe cursor detection.

**How:** Settings → Accessibility → Display & Text Size → Increase Contrast → ON.

### Trackpad Inertia OFF (CRITICAL for cursor precision)

When Trackpad Inertia is ON, the cursor "coasts" briefly after motion
input stops — it continues moving for a few hundred milliseconds. This
makes cursor position non-deterministic at click-time: the algorithm
emits delta D, expects cursor at position X, but cursor coasts past X
to X+30. The 28-32 px residuals observed in cursor click_at benches
match this coasting drift exactly.

**Turning Trackpad Inertia OFF is the single most impactful iPad
configuration change for `pikvm_mouse_click_at` reliability.** Without
inertia, the cursor stops EXACTLY where the last delta-emit landed it,
removing the variance that bounds the icon-tolerance ceiling.

**How:** Settings → Accessibility → Pointer Control → Trackpad Inertia → OFF.

### Tracking Speed: slowest

iPadOS's pointer-acceleration curve (relative-mouse mode applies a
non-disableable curve on top of the raw HID delta) is more aggressive
at higher tracking speeds. Setting Tracking Speed to its slowest
position keeps the curve in its near-1:1 region for typical small
delta emits, so per-mickey pixel variance is bounded.

**How:** Settings → General → Trackpad & Mouse → Tracking Speed →
drag slider all the way LEFT (slowest).

## Version-specific guidance for cursor detection

The MCP server's `pikvm_mouse_move_to` and `pikvm_mouse_click_at` rely on
diff-based cursor detection in screenshots. Animated UI noise (icon
hover/scale, widget animations) can confuse the detector.

### iPadOS 17 / 18 (older)

Disable cursor morphing so the cursor stays a circular dot over all UI
contexts:

**Settings → Accessibility → Pointer Control → Pointer Animations → OFF**

### iPadOS 26+ (current)

The "Pointer Animations" toggle was **removed in iPadOS 26**. The cursor
was redesigned to a permanent arrow that no longer morphs into pills /
I-beams, so the toggle is no longer needed for cursor shape stability.

However, *icon hover/scale animations* still exist — when the cursor
passes over an app icon, the icon grows and highlights, producing large
diff clusters that can be mistaken for the cursor itself.

To minimise that noise:

**Settings → Accessibility → Motion → Reduce Motion → ON**

This dampens system-wide animations, including most pointer-effect
icon scaling. Strongly recommended if you'll be using
`pikvm_mouse_click_at` on the home screen.

## Strongly preferred: keyboard-first workflows

**Skip cursor clicking entirely whenever possible.** USB keyboard input
on iPadOS is far more reliable than the relative-mouse-coordinate dance.
See [ipad-keyboard-workflow.md](ipad-keyboard-workflow.md) for the
recommended pattern (Spotlight + Cmd+F + type) which bypasses all the
cursor precision concerns.

## Verification

After making the changes, run a quick test:

1. Call `pikvm_health_check` (v0.5.19+) — verify:
   - Server version matches `main` (redeploy if stale; older servers
     lack the iPad safety guards).
   - `mouseAbsoluteMode: false` (iPad is in relative-mouse mode).
   - HID profile reports mouse + keyboard online.
   - iPad bounds detected as `portrait`.
   - Screen brightness ≥ 80 with no `⚠ DIM` warning. If you see
     `⚠ VERY DIM`, fix the iPad brightness setting before going on.
2. Lock the iPad (side button) and call `pikvm_ipad_unlock` — confirm
   home screen appears.
3. Call `pikvm_shortcut` with `["MetaLeft", "Space"]` — Spotlight should
   open.
4. Call `pikvm_type` with "Files" then `pikvm_key` with "Enter" — Files
   app should open.

If step 3 or 4 fails, the iPad may have keyboard input disabled for
external devices, or the PiKVM HID mouse profile is not correctly
exposing a keyboard channel.
