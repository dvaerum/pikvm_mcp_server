# iPad setup for reliable PiKVM MCP control

This is a one-time checklist on the iPad itself (not in the MCP server
config). All settings here address specific failure modes observed when
trying to drive the iPad pointer via USB HID:

## Required

### Disable Pointer Animations
**Why:** iPadOS morphs the cursor over different UI contexts — it becomes
a pill/highlight over icons, an I-beam over text fields, and so on. It
also triggers scale/lift animations on whatever it hovers. The diff-based
cursor detector used by `pikvm_mouse_move_to` and `pikvm_mouse_click_at`
cannot reliably distinguish the cursor from these pointer-effect
animations on a busy home screen. Disabling Pointer Animations locks the
cursor in a single circular shape and turns off the icon highlight
effects.

**How:** Settings → Accessibility → Pointer Control → Pointer Animations → OFF.

### Set Auto-Lock to ≥ 4 minutes (or Never for active sessions)
**Why:** USB HID mouse input does NOT reset iPadOS's auto-lock timer.
If Auto-Lock is 30 s – 2 min (often the default), the iPad locks itself
mid-sequence and subsequent clicks are silently dropped. `pikvm_ipad_unlock`
can recover, but only if the agent notices — better to not lock in the
first place.

**How:** Settings → Display & Brightness → Auto-Lock → 5 Minutes (or Never).

## Recommended

### Increase Contrast
**Why:** Makes the cursor visibly brighter against varied wallpapers.
Helps the brightness filter in cursor detection.

**How:** Settings → Accessibility → Display & Text Size → Increase
Contrast → ON.

### Solid / simple wallpaper
**Why:** Animated or busy wallpapers contribute to diff noise.

**How:** Settings → Wallpaper → Choose a Wallpaper → pick a solid colour
or minimal pattern.

## Not required but nice

### Turn off widget animations
Some widgets (clock second hand, weather ticker, calendar) produce
cursor-sized diff noise. If detection reliability matters more than the
widgets' usefulness, you can remove them from the home screen:

**How:** Tap-and-hold a widget → Remove Widget.

## Verification

After making the changes, verify by calling `pikvm_mouse_move_to` with
`verbose: true` and checking the log output:
- Motion-diff should succeed (non-null `finalDetectedPosition`)
- The cursor clusters should be 15–40 px (cursor-sized), not 80–200 px
  (which indicates you're picking up icon highlights)
- `livePxPerMickey` should land in the 0.8–1.8 range

If detection still picks up icon highlights, double-check that Pointer
Animations is actually OFF — the toggle is easy to miss in Accessibility.
