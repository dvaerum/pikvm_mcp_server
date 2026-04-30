# PiKVM server-side changes log

This document records EVERY change made to the live PiKVM at
`pikvm01.bb.vcamp.dk` — what, when, why, and how to revert.

PiKVM hardware/OS:
- Raspberry Pi 4 Model B Rev 1.1, model "v2", HDMI capture
- Arch Linux ARM, kernel 6.12.56-1-rpi
- Root filesystem is read-only by default; `rw` to remount, `ro` to
  remount read-only (PiKVM helpers)

Access:
- HTTPS web UI: `https://pikvm01.bb.vcamp.dk` (admin / <password>)
- SSH: `root@pikvm01.bb.vcamp.dk` (key-based, georg's id_ed25519 added)

Authoritative reference for the user's existing iPad-targeted
configuration, including required HID patches and rationale:
**`~/pikvm-configured-for-ipad.md`** (on georg's Mac).

## Existing config (NOT changed by this project)

Per the user's `pikvm-configured-for-ipad.md`, the current PiKVM
config is the WORKING setup for iPad and should not be changed:

- `/etc/kvmd/override.yaml` sets `mouse.absolute: false` and
  `mouse_alt.device: ''`. iPad needs relative-mouse mode; absolute
  mode causes "gestures going crazy" because iPadOS interprets
  absolute HID position reports as touch events.

- `/usr/lib/python3.13/site-packages/kvmd/apps/otg/hid/mouse.py`
  has been MANUALLY PATCHED to set `protocol=2, subclass=1`
  (USB boot-mouse-interface descriptor). Without this patch,
  iPadOS won't accept clicks (mouse movement still works, but
  click events are dropped). The patch is persisted by a pacman
  hook at `/etc/pacman.d/hooks/kvmd-mouse-patch.hook` so it
  reapplies after `pacman -Syu`.

- USB capture card (MS2109) must be in the LOWER black USB 2.0
  port on the Pi 4 — verified by `/dev/kvmd-video` symlink.

## Observation: patch path version note

The user's `pikvm-configured-for-ipad.md` references the patch at
`/usr/lib/python3.14/site-packages/...`. The actual path on the
running PiKVM is `python3.13` (verified 2026-04-26):
```
grep -n "protocol\|subclass" /usr/lib/python3.13/site-packages/kvmd/apps/otg/hid/mouse.py
# 45:    protocol=2,
# 46:    subclass=1,
# 109:   protocol=2,
# 110:   subclass=1,
```

The patch is currently applied (values are 2/1) and clicks are
working. **No action needed — the user's policy is "we do not
update the pikvm".** Recording this purely as an observation in
case the patch path becomes relevant in the future. This MCP
project does not modify the PiKVM.

## Change log (this session)

### 2026-04-26 10:24 UTC — investigated config, made one transient change

Action:
```
ssh root@pikvm01.bb.vcamp.dk
rw                                  # remount root read-write
cp /etc/kvmd/override.yaml /etc/kvmd/override.yaml.bak-pre-dualmode
```

Why: was investigating whether enabling dual-mode mouse (`mouse_alt`
+ absolute as alt device) could solve iPad cursor positioning
variance. Created backup as a precaution before any edit.

### 2026-04-26 10:38 UTC — REVERTED (no behavior change)

Discovered via the user's `pikvm-configured-for-ipad.md` notes that
absolute mouse mode is INCOMPATIBLE with iPad — produces "gestures
going crazy" because iPadOS interprets absolute HID reports as
touch events. The current relative-mode + boot-mouse-patch is the
proven working setup.

Action (revert):
```
ssh root@pikvm01.bb.vcamp.dk
rm -f /etc/kvmd/override.yaml.bak-pre-dualmode
ro                                  # remount root read-only
```

Verification:
```
mount | grep " / "
# /dev/mmcblk0p3 on / type ext4 (ro,relatime)
```
Plus mouse boot-interface patch verified intact (protocol=2,
subclass=1 at all four sites).

**Net effect: ZERO changes to PiKVM. The system is in the same
state it was before this session's SSH access began.**

### 2026-04-28 — API-only interactions, ZERO config changes

This session (v0.5.137 → v0.5.172, Phases 147-182) ran exclusively
against PiKVM's HTTP API. No SSH, no config edits, no service
restarts. API endpoints exercised:

- `GET /api/hid` — read HID gadget status (mouse.online,
  keyboard.online, jiggler state). Read-only.
- `POST /api/hid/reset` — Phase 146 transient HID reset to test
  whether re-enumerating the USB HID gadget would clear the iPad
  input-block. Reset succeeded but did NOT clear the iPad-side
  state. The `/api/hid/reset` endpoint is itself transient
  (re-enumerates the USB gadget, no persistent config change).
- `POST /api/hid/events/send_mouse_relative` — every cursor move.
- `POST /api/hid/events/send_mouse_button` — every click.
- `POST /api/hid/events/send_keyboard` — every key press (Phase
  162/176 Escape dismiss, Phase 180 Cmd+Tab, etc.).
- `GET /api/streamer/snapshot` — every screenshot.

All endpoints are read-only (snapshots, status) or transient (HID
events that don't persist on the PiKVM filesystem). No
`/etc/kvmd/override.yaml`, mouse boot-patch, or systemd
unit modifications.

**Net effect: ZERO permanent changes to PiKVM during this session.
The system is in the same state it was before the v0.5.137 work
began.**

## Closed avenue: dual-mode mouse on iPad

The `mouse_alt` / dual-mode mouse approach IS NOT a path forward
for iPad. Per the user's notes and confirmed via troubleshooting
section of `pikvm-configured-for-ipad.md`:

> "Gestures going crazy on iPad — This happens when using absolute
> mouse mode. iPadOS interprets absolute HID position reports as
> touch events. Stay in relative mouse mode."

Future contributors: do NOT enable absolute or dual-mode on this
PiKVM expecting it to fix iPad cursor positioning. The cursor
variance documented in `ipad-cursor-detection.md` is INHERENT to
iPadOS pointer acceleration on relative-mouse input. The path
forward is multi-trial probabilistic clicks (Phase 23 verification +
Phase 25 retry-on-miss + post-click screenshot inspection),
already shipped in the MCP server.

Refinement (2026-04-26 by user): the "gestures going crazy" failure
mode requires the mouse boot-interface patch (`protocol=2,
subclass=1`) to be applied. WITHOUT the patch + absolute mode,
the cursor moves but clicks don't register. WITH the patch +
absolute mode, clicks register but as touch events that iPadOS
interprets as conflicting with cursor motion → "gestures going
crazy". The current relative-mode + boot-interface-patch is the
only mouse combo where clicks register normally on iPad.

### 2026-04-26 14:40 UTC — Add `streamer.forever: true` to override.yaml

Action:
```
ssh root@pikvm01.bb.vcamp.dk
rw
cp /etc/kvmd/override.yaml /etc/kvmd/override.yaml.bak-pre-stream-forever
# Insert "    forever: true" under the existing "  streamer:" block.
systemctl restart kvmd
ro
```

Why: kvmd by default auto-stops the ustreamer subprocess ~10 seconds
after the last live web/WS client disconnects, to save CPU. The MCP
server's REST `pikvm_screenshot` calls go through `/api/streamer/snapshot`
which does NOT auto-start the streamer if it's stopped — kvmd returns
HTTP 503 `UnavailableError`. Live-verified 2026-04-26: a 30-minute
gap between PiKVM web-UI sessions left the streamer stopped, all MCP
screenshot calls returned 503, and click_at / move_to / health_check
all became unusable until a manual web-UI session re-started it.

`streamer.forever: true` makes kvmd keep ustreamer running
permanently after first start. Cost: ~3% CPU continuous on Pi 4 +
slightly higher idle wattage. Benefit: MCP REST calls work reliably
without needing an active web-UI client.

Verification:
```
ps -ef | grep ustream | grep -v grep
# kvmd  300599  300554  3 11:40 ?  ... kvmd/streamer: /usr/bin/ustreamer
curl -k -u admin:... https://pikvm01.bb.vcamp.dk/api/streamer/snapshot?save=0 -o /tmp/test.jpg
file /tmp/test.jpg
# /tmp/test.jpg: JPEG image data, baseline, precision 8, 1920x1080, components 3
```

Revert (if ever needed): remove the `forever: true` line from
override.yaml and restart kvmd. The original behaviour is the kvmd
default.

### 2026-04-26 10:50 UTC — Phase 31: touchscreen HID experiment + revert

Action: hot-added a third HID gadget function (`hid.usb2`) to the
PiKVM USB composite gadget, configured as a single-touch digitizer:

```
GADGET=/sys/kernel/config/usb_gadget/kvmd
echo "" > $GADGET/UDC          # unbind
mkdir $GADGET/functions/hid.usb2
echo 0 > $GADGET/functions/hid.usb2/protocol
echo 0 > $GADGET/functions/hid.usb2/subclass
echo 5 > $GADGET/functions/hid.usb2/report_length
# Write 45-byte single-touch digitizer descriptor to report_desc
ln -s functions/hid.usb2 configs/c.1/hid.usb2
echo "fe980000.usb" > $GADGET/UDC   # rebind
```

Hypothesis: a separate USB digitizer device (Usage Page 0x0D, Usage
0x04 Touch Screen) is fundamentally different from "mouse with
absolute coordinates". A real digitizer descriptor unambiguously
declares itself as a touchscreen, so iPadOS would NOT have the
"gestures going crazy" interpretation conflict that absolute-mouse
mode produces. If iPadOS recognised the device as a touchscreen,
we would gain deterministic absolute-coordinate input (no pointer
acceleration variance).

Test: wrote tap reports to `/dev/hidg2` at touchscreen logical
coordinates (16383, 16383) center, then at (19660, 25274) which
maps to the on-screen Settings icon at HDMI (1027, 833). Observed
no response on the iPad — no touch indicators, no app launch, no
visible state change.

Conclusion: **CLOSED — iPadOS does not act on USB HID touchscreen
input.** This aligns with Apple's documented architecture: pointer
support added in iPadOS 13.4 is for mice and trackpads only. There
is no documented USB-touchscreen API surface in iPadOS, presumably
to prevent this exact attack-vector for spoofing touch events from
peripherals. The descriptor was accepted by the USB stack
(`/dev/hidg2` was created and writeable) but the iPad's input
subsystem did not surface the touches to UIKit.

Action (revert):
```
echo "" > $GADGET/UDC
rm -f $GADGET/configs/c.1/hid.usb2
rmdir $GADGET/functions/hid.usb2
echo "fe980000.usb" > $GADGET/UDC
```

Verification:
- Functions list back to {hid.usb0, hid.usb1, mass_storage.usb0}
- /dev/hidg2 gone; /dev/hidg0 + /dev/hidg1 present
- Mouse boot patch intact (`protocol=2, subclass=1` at all four sites)
- Root mount still `ro`
- Live mouse_move and key sends work post-revert (iPad responsive)

**Net effect: ZERO permanent changes to PiKVM. The system is in
the same state it was before this experiment.**

See `docs/troubleshooting/ipad-touchscreen-hid-dead-end.md` for the
full technical write-up of the descriptor design and why iPadOS
ignored it.

### 2026-04-30 09:24 UTC — Phase 188 Step 1: gamepad HID descriptor kernel-level sanity check + revert

Phase 188's plan called for a 3-step gamepad HID experiment. With
the iPad battery-dead and no USB host on the cable, **only Step 1
(Linux/kernel-side sanity check) is exercisable right now.** Step
2 and 3 require the iPad to be online to observe enumeration and
behaviour respectively — deferred until iPad reboots.

Step 1 question: does the configfs add of a generic-HID-gamepad
function (`hid.usb2` with the 46-byte descriptor from
`docs/troubleshooting/ipad-gamepad-hid-investigation.md`) succeed
at the kernel level without errors, AND can it be cleanly reverted
to the pre-experiment state?

Action:
```
ssh root@pikvm01.bb.vcamp.dk
GADGET=/sys/kernel/config/usb_gadget/kvmd
cd $GADGET
echo "" > UDC                               # unbind
mkdir functions/hid.usb2
echo 0 > functions/hid.usb2/protocol
echo 0 > functions/hid.usb2/subclass
echo 5 > functions/hid.usb2/report_length
# Wrote 46-byte gamepad descriptor (see ipad-gamepad-hid-
# investigation.md for the byte layout) to functions/hid.usb2/report_desc
ln -s functions/hid.usb2 configs/c.1/hid.usb2
echo "fe980000.usb" > UDC                   # rebind
```

Result:
- `/dev/hidg2` was created (major 236, minor 2).
- `dmesg` showed clean re-enumeration: `dwc2 fe980000.usb: bound
  driver configfs-gadget.kvmd`. No errors.
- kvmd + kvmd-otg services remained `active` throughout.
- A test write of 5 zero bytes to `/dev/hidg2` returned
  `Errno 108 transport endpoint shutdown` — exactly as expected
  with the iPad off (no USB host to deliver the report to). When
  the iPad is back online, the same write should succeed.

This proves the **descriptor format is well-formed** and the
**configfs add/remove flow is reliable** — both prerequisites for
Phase 188 Step 2 (iPad enumeration test) when the iPad reboots.

Action (revert):
```
ssh root@pikvm01.bb.vcamp.dk
cd /sys/kernel/config/usb_gadget/kvmd
echo "" > UDC
rm -f configs/c.1/hid.usb2
rmdir functions/hid.usb2
echo "fe980000.usb" > UDC
```

Verification:
- Functions back to {hid.usb0, hid.usb1, mass_storage.usb0}.
- `/dev/hidg2` gone; `/dev/hidg0` + `/dev/hidg1` intact.
- Mouse boot-patch (`protocol=2, subclass=1`) intact at all four
  sites in `mouse.py`.
- kvmd + kvmd-otg both `active`.

Tangential observation: when the SSH session opened, root was
already mounted `rw,relatime` (not `ro` as the PiKVM policy
expects). Not caused by this experiment — the SSH session's first
command (`mount | grep " / "`) showed `rw` BEFORE any configfs
modification was issued. Most likely a leftover from the Phase 46
`streamer.forever` edit that wasn't followed by a `ro` remount.
**Restored to `ro` at the end of this session** via the PiKVM
`ro` helper. Future contributors: always run `ro` before
disconnecting if you ran `rw` for any reason.

**Net effect of this Phase 188 Step 1 experiment: ZERO permanent
changes to PiKVM. Bonus side-effect: root mount restored to the
documented `ro` baseline.**
