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
