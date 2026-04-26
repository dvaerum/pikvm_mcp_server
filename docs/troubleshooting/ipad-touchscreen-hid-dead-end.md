# iPad USB-touchscreen HID — closed avenue

This document records a **negative result**: a USB HID digitizer
(touchscreen) function added alongside the existing PiKVM mouse and
keyboard does NOT work on iPadOS. Future contributors should not
re-investigate this approach without reading this first.

Date: 2026-04-26
PiKVM: pikvm01.bb.vcamp.dk (Pi 4B v2, kernel 6.12.56)
Target: iPad (iOS 17, portrait, ~1280x720 native, displayed in
1920x1080 HDMI capture)

## Motivation

After 30+ phases of work to make `pikvm_mouse_click_at` reliable
on the iPad home screen, the inherent variance of iPadOS pointer
acceleration on relative-mouse input was the unmoved bottleneck.
A USB HID **digitizer** (touchscreen) device, in contrast, sends
**absolute** coordinates that map directly to the screen — no
acceleration, no variance, no per-call scaling. If iPadOS accepted
input from such a device, we'd have deterministic clicks at any
screen pixel.

Mouse-with-absolute-coordinates is documented to fail on iPad
("gestures going crazy" — see `pikvm-server-changes.md`). But a
**digitizer** is a different USB HID device class entirely (Usage
Page 0x0D Digitizer, Usage 0x04 Touch Screen) — iPadOS would
recognise it as a touchscreen from the start, not as a confused
mouse.

## Approach

PiKVM exposes the USB OTG composite gadget via Linux ConfigFS at
`/sys/kernel/config/usb_gadget/kvmd/`. Adding a third HID
function alongside the existing keyboard (`hid.usb0`) and mouse
(`hid.usb1`) is a straightforward configfs operation:

```bash
GADGET=/sys/kernel/config/usb_gadget/kvmd
UDC_VAL=$(cat $GADGET/UDC)              # save fe980000.usb
echo "" > $GADGET/UDC                    # unbind (USB unplug)
mkdir $GADGET/functions/hid.usb2
echo 0 > $GADGET/functions/hid.usb2/protocol
echo 0 > $GADGET/functions/hid.usb2/subclass
echo 5 > $GADGET/functions/hid.usb2/report_length
# Write 45-byte report descriptor to report_desc (see below)
ln -s functions/hid.usb2 $GADGET/configs/c.1/hid.usb2
echo "$UDC_VAL" > $GADGET/UDC            # rebind (USB replug)
```

## Descriptor

Single-touch digitizer descriptor, 45 bytes:

```
05 0D       Usage Page (Digitizer)
09 04       Usage (Touch Screen)
A1 01       Collection (Application)
  09 22       Usage (Finger)
  A1 02       Collection (Logical)
    09 42       Usage (Tip Switch)
    15 00       Logical Minimum (0)
    25 01       Logical Maximum (1)
    75 01       Report Size (1)
    95 01       Report Count (1)
    81 02       Input (Data,Var,Abs)
    95 07       Report Count (7)
    81 03       Input (Cnst,Var,Abs)  ← 7-bit padding
    05 01       Usage Page (Generic Desktop)
    26 FF 7F    Logical Maximum (32767)
    75 10       Report Size (16)
    95 01       Report Count (1)
    09 30       Usage (X)
    81 02       Input (Data,Var,Abs)
    09 31       Usage (Y)
    81 02       Input (Data,Var,Abs)
  C0
C0
```

5-byte report:
- Byte 0: bit 0 = TipSwitch (1 = touching), bits 1-7 padding
- Bytes 1-2: X (16-bit LE, range 0-32767, maps to screen left→right)
- Bytes 3-4: Y (16-bit LE, range 0-32767, maps to screen top→bottom)

A tap at (X, Y) is two reports: TipSwitch=1 then TipSwitch=0,
both with the same X/Y, with a brief delay between them.

## Result

The configfs operation succeeded:
- `/dev/hidg2` was created
- The descriptor was accepted by the kernel HID stack (`xxd`
  confirmed the 45 bytes were stored intact)
- Writes to `/dev/hidg2` returned success (no errno)
- The USB gadget enumerated successfully (`dwc2 fe980000.usb: new
  device is high-speed; new address 3` in dmesg)

**iPadOS did not respond to any tap reports.** Tested:
- Tap at (16383, 16383) — center of touchscreen logical space,
  which maps to center of iPad screen (visually empty space).
  No response (expected if hit empty space but also no visible
  cursor/touch indicator).
- Tap at (19660, 25274) — maps to HDMI (1027, 833), which is
  directly on the Settings app icon. No response. Settings did
  not open. No visual feedback.
- Tap with extended hold (200ms). No response.

## Why this fails

iPadOS pointer support was added in iPadOS 13.4 (March 2020),
specifically for **Bluetooth and USB mice and trackpads**. There
is no documented API surface for USB touchscreen input. iPadOS
treats the iPad's built-in touchscreen as the sole legitimate
source of `UITouch` events.

This is presumably an intentional security/UX decision by Apple:
- A spoofed touchscreen could perform gestures the user didn't
  intend (similar to "BadUSB" attacks).
- Allowing arbitrary USB devices to inject touches would let
  peripherals bypass the on-screen UI directly without any
  visible indicator (whereas a mouse always has a visible cursor).
- Apple's accessory program (MFi) certifies specific hardware;
  arbitrary HID digitizers are not in scope.

The HID descriptor was clearly received by iPadOS (USB
enumeration succeeded — kernel-level), but the iPadOS input
subsystem (UIKit / HID-to-UITouch translation) silently dropped
the touch reports.

## What about multi-touch / Windows Precision descriptors?

We did NOT test:
- Multi-touch descriptor with Contact Count + Contact ID (Windows
  Precision Touchscreen format)
- Microsoft HID digitizer feature reports (e.g. CAPS-MAX-CONTACTS)
- Vendor-specific descriptors mimicking specific MFi-certified
  hardware

These are unlikely to succeed for the same reason: iPadOS gates
touchscreen input at the OS level, not at the descriptor parsing
level. Spending more time on descriptor variations is a poor use
of effort.

## Alternative approaches we considered

1. **Bluetooth HID emulation (BLE Mouse + tap injection)**:
   iPadOS supports Bluetooth pointing devices, but again — only
   pointing devices, not touchscreens. Same fundamental block.

2. **AssistiveTouch + cursor**: AssistiveTouch can map mouse
   buttons to virtual touch gestures. But user notes (per
   `pikvm-configured-for-ipad.md`) explicitly state AssistiveTouch
   must be OFF for current click setup to work; turning it ON
   broke clicks during the user's earlier testing.

3. **MFi-licensed HID device emulation**: Would require knowing
   the proprietary MFi authentication chip protocol, which is
   under NDA and not publicly available.

4. **Apple Pencil emulation**: Apple Pencil uses Bluetooth + a
   proprietary protocol with a coprocessor in the iPad's screen
   (digital signal generation). Cannot be emulated over USB.

## Conclusion: stay on the cursor path

The path forward for reliable iPad clicks remains:
- **Keyboard-first workflows wherever possible** (Spotlight
  app launch, in-app search, keyboard shortcuts)
- **Multi-trial probabilistic clicks for cursor targets**
  (Phase 23 verification + Phase 25 retry-on-miss + visual
  post-condition checks)
- **Slam-bottom-right anchor primitive** for known cursor
  position before precision moves

The cursor variance is bounded but non-zero. There is no
hardware-side fix accessible to a non-Apple party. Effort is
better spent on:
- Stronger post-click verification (hit-the-RIGHT-icon, not
  just hit-something)
- Better target tolerance (large icons are easier; design
  workflows around large targets when possible)
- More robust keyboard fallback

## How to reproduce / extend

If a future contributor finds new evidence that iPadOS DOES
accept some specific touchscreen-descriptor variant (e.g. via
new iPadOS release notes, MFi changes, or a working
demonstration on another project), the experiment is easily
re-run:

1. SSH to PiKVM as root.
2. Run the configfs script above with the modified descriptor.
3. Test taps via `printf '...' > /dev/hidg2`.
4. Verify visually via `pikvm_screenshot`.
5. **ALWAYS revert** by removing the symlink, rmdir-ing the
   function, and re-binding the UDC.
6. Document findings here as either confirmation, refinement, or
   another negative result with the variant tested.
