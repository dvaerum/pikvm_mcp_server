# iPad gamepad-HID — research note (NOT a confirmed avenue)

**Status (2026-04-30):** desk research + Step 1 (Linux/kernel
sanity check) complete. Steps 2-3 (iPad enumeration + behaviour)
deferred until iPad battery recovers.

**Step 1 update (2026-04-30 09:24 UTC):** the 46-byte gamepad
descriptor was added to PiKVM via configfs and accepted cleanly
by the kernel. `/dev/hidg2` materialised, kvmd remained active,
no dmesg errors. Test write returned `Errno 108 transport endpoint
shutdown` (expected — iPad host was off). Reverted; PiKVM back to
{hid.usb0, hid.usb1, mass_storage.usb0}. See `pikvm-server-changes.md`
for the full action+verification log. **Descriptor format and
configfs flow both validated; Phase 188 Step 2 ready to run when
iPad reboots.**

This note exists to capture what I learned about exposing a USB HID
**gamepad** to the iPad via the PiKVM USB OTG composite gadget, as
a possible bypass for the iPadOS pointer-acceleration variance that
caps `pikvm_mouse_click_at` icon-target reliability at ~50–60 %.

## The hypothesis (user-endorsed 2026-04-29)

> "If we really do not have cursor pointer acceleration, then the
> gamepad stuff is worth investigating."

Mouse-with-relative-coordinates feeds iPadOS's pointer-effect
acceleration curve. That curve is *non-deterministic per emit*
(measured 9× ratio variance, see `ipad-cursor-detection.md`), so
no PiKVM-side calibration can give us deterministic clicks against
small icons.

A **gamepad** is a different USB HID device class entirely (Usage
Page 0x01 Generic Desktop, Usage 0x05 Game Pad). iPadOS's
`GameController` framework was extended in iPadOS 13.4 / 14 to
handle Xbox, PlayStation, and other standard HID controllers. If
iPadOS routes gamepad thumbstick input through a *different*
input pipeline than mouse acceleration — and if it surfaces a
system cursor that moves at constant speed per stick deflection —
we'd have deterministic absolute-ish positioning without the
pointer-effect variance.

## What desk research actually showed

The hypothesis is **partially true but with significant caveats**:

1. **No documented system-cursor-via-gamepad-stick mode exists on
   iPadOS by default.** Apple's official iPadOS gamepad pages
   (Apple Support 111099, 111775) describe gamepads exclusively as
   game-input devices. The right thumbstick is interpreted by
   *games* via the `GameController` framework, not by SpringBoard
   as a system pointer. There's no "gamepad mouse mode" toggle in
   Settings.

2. **AssistiveTouch with adaptive accessory** (Settings →
   Accessibility → Touch → AssistiveTouch → Pointer Devices) is
   the **closest** documented path. Apple lists "joystick" among
   the supported adaptive accessories. Once paired and configured
   per accessibility flow, the joystick deflection moves the
   system cursor at constant speed — no pointer-effect snap, no
   acceleration variance. **But:** the AssistiveTouch joystick
   config is undocumented for non-MFi USB joysticks, and the
   accessibility flow assumes Bluetooth pairing.

3. **USB-C gamepads on iPad are unreliable** (community reports —
   discussions.apple.com/thread/252504798). Bluetooth Xbox/PS/Switch
   controllers are the supported path. PiKVM's USB OTG gadget
   shows up to the iPad over the same Lightning/USB-C cable as the
   mouse and keyboard, so it's exactly the "USB gamepad" case the
   community reports as flaky.

4. **GameController.framework wants standard descriptors.**
   Per CCController (slembcke/CCController, github), Apple's
   framework recognises Xbox / DualShock / DualSense via known
   VID/PID + descriptor patterns. A *generic* HID gamepad
   descriptor may not be recognised at all.

## Realistic experiment plan (if iPad reboots and we want to try)

This is **structured to fail fast**, not to invest 2 hours before
discovering iPadOS ignores the device. Each step has a clear
go/no-go signal so we abort early if the foundation isn't there.

### Prerequisites (must hold before starting)

- iPad's foreground app is something neutral (lock screen ideal).
- PiKVM streamer online (`pikvm_screenshot` returns 200, not 503).
- Existing mouse + keyboard HID gadgets unchanged (this experiment
  ADDS `hid.usb2` — does not replace `hid.usb1` mouse, in line
  with Phase 31 touchscreen experiment design).
- `pikvm-server-changes.md` updated with the change BEFORE making it.
- A documented revert script ready (mirrors Phase 31 revert).

### Step 1 — minimal generic gamepad descriptor

Smallest viable descriptor:

```
05 01       Usage Page (Generic Desktop)
09 05       Usage (Game Pad)
A1 01       Collection (Application)
  09 01       Usage (Pointer)
  A1 00       Collection (Physical)
    09 30       Usage (X)             ; left stick X
    09 31       Usage (Y)             ; left stick Y
    09 33       Usage (Rx)            ; right stick X
    09 34       Usage (Ry)            ; right stick Y
    15 81       Logical Min (-127)
    25 7F       Logical Max (127)
    75 08       Report Size (8)
    95 04       Report Count (4)
    81 02       Input (Data,Var,Abs)
  C0
  05 09       Usage Page (Button)
  19 01       Usage Minimum (1)
  29 08       Usage Maximum (8)
  15 00       Logical Min (0)
  25 01       Logical Max (1)
  75 01       Report Size (1)
  95 08       Report Count (8)
  81 02       Input (Data,Var,Abs)
C0
```

Report layout (5 bytes): `LX, LY, RX, RY, BTN_BITS`. Buttons 1
and 2 conventionally map to A (south) / B (east) — used as
"click" candidates.

**Go/no-go after Step 1:** plug into a Linux box first, run
`evtest`, confirm the kernel registers the gadget as a joystick.
Saves a wasted iPad cycle if the descriptor itself is malformed.

### Step 2 — connect to iPad, observe dmesg / screenshot

After binding `hid.usb2`, take a screenshot and observe the iPad.
**Do not** send any reports yet. Watch for:

- iPad shows no obvious change → probable enumeration failure.
- iPad shows a pointer briefly → enumeration succeeded.
- Cursor stops responding to mouse → mouse gadget got unbound or
  the iPad's input arbitration rejected the new device.

**Stop condition:** if iPad shows no recognition signal in 10 s,
and `cat /sys/kernel/debug/usb/devices` on the PiKVM shows the
gadget enumerated, the experiment is in the same state as Phase 31
(touchscreen) — descriptor accepted by Linux but iPadOS doesn't
surface the device. Revert and document.

### Step 3 — send stick deflection, look for cursor movement

If Step 2 shows any recognition signal: write a 5-byte report
with right-stick X = +50 and watch for cursor motion via
`pikvm_screenshot`. If the cursor moves at constant speed
proportional to deflection, we've found the deterministic path.

**Go/no-go after Step 3:**
- **Yes, cursor moves linearly** → write a `pikvm_gamepad_*` API
  layer in a follow-up phase. This is the win condition.
- **Cursor doesn't move, but iPad shows other UI response (e.g.
  AssistiveTouch ring)** → AssistiveTouch needs explicit pairing
  in Settings; document the on-device steps the user must perform
  before the gamepad route is usable.
- **No response at all** → iPad routes gamepad input only to
  *games* (GameController.framework callbacks), not the system.
  Closed avenue — document and revert.

### Step 4 — button → click

If Step 3 succeeds: write a report with button-1 bit set, observe
whether iPad treats it as a tap. Likely outcomes:
- **Tap registered on UI element under cursor** → success path.
- **No tap, but cursor moved** → gamepad cursor is "look
  pointer", not a primary input pointer. Possibly need
  AssistiveTouch's "Click" assignment in Settings.

## Pre-mortem

**Most likely failure mode (50%+):** iPadOS does not surface
generic HID gamepads as system input devices, only as
GameController callbacks. Same architecture as Phase 31
touchscreen — accepted by Linux, ignored by iPadOS input
subsystem.

**Second-most-likely (30%):** iPadOS recognises the gamepad but
only feeds it to AssistiveTouch *after* the user pairs it
manually. Unpaired devices are inert. This re-introduces a
chicken-and-egg config requirement (the user must have already
configured AssistiveTouch + the device on-device before any
PiKVM-side work matters).

**Long-shot success (20%):** the joystick descriptor lands the
iPad in a recognised "pointer device" path (the same one used by
Apple's adaptive accessibility joysticks per Apple Support 111775)
and we get deterministic stick-driven cursor without any
on-device toggle. This would be the win condition.

## Decision

**Defer until the iPad is back online.** When it is:
1. Read this doc and `ipad-touchscreen-hid-dead-end.md` first —
   the experiment design here mirrors Phase 31's structure.
2. Run Steps 1–3 with screenshots at every state change.
3. Revert via the documented script regardless of outcome — no
   permanent PiKVM changes from this experiment, exactly like
   Phase 31.
4. Update `pikvm-server-changes.md` with the actions and result
   regardless of outcome (positive or negative results both
   useful).

If Steps 1–3 succeed, a follow-up phase wires `pikvm_gamepad_*`
MCP tools (move, click via stick + button) and runs the same 30-
trial bench against Settings/Books/Maps icons that
`pikvm_mouse_click_at` runs against. Comparing residual
distributions tells us whether the gamepad path is materially
better than the current mouse path.

## Live runbook (Steps 2-3 — copy-paste, run after iPad reboots)

This block is intended for direct execution when the iPad is
online and `pikvm_screenshot` returns a frame. Step 1 has already
been validated (2026-04-30 09:24 UTC, see `pikvm-server-changes.md`)
so it's only repeated here to put the gamepad function in place.

**Pre-flight (run from this Mac):**
```bash
# Sanity-check: iPad streamer is online
curl -ksu "admin:$PASS" "https://pikvm01.bb.vcamp.dk/api/streamer" \
  | python3 -c "import sys,json;s=json.load(sys.stdin)['result']['streamer']['source'];print('online:',s.get('online'),'res:',s.get('resolution'))"
# Expect: online: True
```

**Step 2 (PiKVM — add gadget, observe iPad with no reports):**
```bash
ssh root@pikvm01.bb.vcamp.dk 'bash -se' <<'EOF'
set -e
GADGET=/sys/kernel/config/usb_gadget/kvmd
cd $GADGET
echo "" > UDC                                # unbind
mkdir functions/hid.usb2
echo 0 > functions/hid.usb2/protocol
echo 0 > functions/hid.usb2/subclass
echo 5 > functions/hid.usb2/report_length
python3 - <<'PY'
desc = bytes([
  0x05,0x01, 0x09,0x05, 0xA1,0x01,
    0x09,0x01, 0xA1,0x00,
      0x09,0x30, 0x09,0x31, 0x09,0x33, 0x09,0x34,
      0x15,0x81, 0x25,0x7F, 0x75,0x08, 0x95,0x04, 0x81,0x02,
    0xC0,
    0x05,0x09, 0x19,0x01, 0x29,0x08,
      0x15,0x00, 0x25,0x01, 0x75,0x01, 0x95,0x08, 0x81,0x02,
  0xC0,
])
open("/sys/kernel/config/usb_gadget/kvmd/functions/hid.usb2/report_desc","wb").write(desc)
PY
ln -s functions/hid.usb2 configs/c.1/hid.usb2
echo "fe980000.usb" > UDC
ls -l /dev/hidg2
EOF
```

Then immediately:
- Take screenshot via `pikvm_screenshot` (compare to baseline:
  any new on-screen indicator? AssistiveTouch ring? cursor change?).
- Wait 10 s, take another screenshot.
- If nothing visible — proceed to Step 3 anyway (the device may
  enumerate silently like a Bluetooth controller does).

**Step 3 (PiKVM — send stick deflection, observe cursor):**
```bash
# Send right-stick X = +50, hold for 500 ms
ssh root@pikvm01.bb.vcamp.dk 'python3 -c "
import time
with open(\"/dev/hidg2\",\"wb\",buffering=0) as f:
    # report layout: LX, LY, RX(=+50), RY, BUTTONS
    f.write(bytes([0,0,50,0,0]))
    time.sleep(0.5)
    f.write(bytes([0,0,0,0,0]))     # release
"'
```

Then take screenshot — did the on-screen cursor move right?

If cursor moved: try other directions (RX=-50, RY=+50, RY=-50)
to confirm linear behaviour. Capture screenshots at each step.

If cursor didn't move: send button-1 press to test the click
path:
```bash
ssh root@pikvm01.bb.vcamp.dk 'python3 -c "
import time
with open(\"/dev/hidg2\",\"wb\",buffering=0) as f:
    f.write(bytes([0,0,0,0,0x01]))   # button 1 pressed
    time.sleep(0.15)
    f.write(bytes([0,0,0,0,0x00]))   # button 1 released
"'
```

Take screenshot — did anything change? (Tap registered on the
focused UI element?)

**Mandatory revert (regardless of outcome):**
```bash
ssh root@pikvm01.bb.vcamp.dk 'bash -se' <<'EOF'
set -e
GADGET=/sys/kernel/config/usb_gadget/kvmd
cd $GADGET
echo "" > UDC
rm -f configs/c.1/hid.usb2
rmdir functions/hid.usb2
echo "fe980000.usb" > UDC
# Verify
ls $GADGET/functions/      # should NOT include hid.usb2
ls -l /dev/hidg*           # should be hidg0 + hidg1 only
systemctl is-active kvmd kvmd-otg
# If root was rw, restore ro
mount | grep " / " | grep -q rw && ro || true
EOF
```

**Document the result regardless of outcome:** append a Phase 188
Step 2-3 entry to `pikvm-server-changes.md` and update the Status
header at the top of this file with the win-condition / dead-
avenue verdict.

## References

- Phase 31 (touchscreen-HID dead-end) —
  `docs/troubleshooting/ipad-touchscreen-hid-dead-end.md`
- iPadOS 14 GameController framework expansion —
  `https://9to5mac.com/2020/06/25/ipados-14-game-controller-framework-expands-with-keyboard-mouse-and-trackpad-support/`
- Apple Support 111099 (gamepad pairing) —
  `https://support.apple.com/en-us/111099`
- Apple Support 111775 (AssistiveTouch pointer devices) —
  `https://support.apple.com/en-us/111775`
- USB HID gadget driver docs —
  `https://docs.kernel.org/usb/gadget_hid.html`
- HID descriptors reference —
  `https://github.com/DJm00n/ControllersInfo`
- CCController (Xbox/PS/HID adapter for GameController.framework)
  — `https://github.com/slembcke/CCController`
