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

### Increase Contrast (Pointer)
Makes the cursor visibly brighter against varied wallpapers; helps the
brightness filter in motion-as-probe cursor detection.

**How:** Settings → Accessibility → Display & Text Size → Increase Contrast → ON.

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

1. Lock the iPad (side button) and call `pikvm_ipad_unlock` — confirm
   home screen appears.
2. Call `pikvm_shortcut` with `["MetaLeft", "Space"]` — Spotlight should
   open.
3. Call `pikvm_type` with "Files" then `pikvm_key` with "Enter" — Files
   app should open.

If step 2 or 3 fails, the iPad may have keyboard input disabled for
external devices, or the PiKVM HID mouse profile is not correctly
exposing a keyboard channel.
