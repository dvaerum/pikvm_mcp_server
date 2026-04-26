# PiKVM server-side changes log

This document records EVERY change made to the live PiKVM at
`pikvm01.bb.vcamp.dk` — what, when, why, and how to revert.

PiKVM hardware/OS:
- Raspberry Pi 4 Model B Rev 1.1, model "v2", HDMI capture
- Arch Linux ARM, kernel 6.12.56-1-rpi (as of 2025-11-08 build)
- Root filesystem is read-only by default; `rw` to remount (PiKVM helper)
- `ro` to remount read-only (not yet observed; may be implicit on reboot)

Access:
- HTTPS web UI: `https://pikvm01.bb.vcamp.dk` (admin/<password>)
- SSH: `root@pikvm01.bb.vcamp.dk` (key-based, georg's id_ed25519 added)

Config files of interest:
- `/etc/kvmd/override.yaml` — YAML overrides applied on top of defaults
- `/etc/kvmd/override.d/` — drop-in directory (currently empty)
- `/usr/share/kvmd/configs.default/` — defaults (do NOT edit)

## Change log

### 2026-04-26 — backup of override.yaml prior to dual-mode investigation

Action:
```
ssh root@pikvm01.bb.vcamp.dk
rw                                  # remount root read-write
cp /etc/kvmd/override.yaml /etc/kvmd/override.yaml.bak-pre-dualmode
```

Why: investigating whether enabling `mouse_alt` (dual-mode mouse,
adds an absolute-coordinate HID device alongside the relative one)
makes iPad cursor positioning deterministic, by exposing absolute
coordinates the iPad accepts as touch-like input.

The user reports prior attempts had problems:
- Pure absolute-mode: clicks didn't register on iPad
- Absolute-mode + "the patch" (unspecified what patch): cursor
  jumped around the screen randomly

These prior findings are documented here:
- (User's notes file `/tmp/pikvm-configured-for-ipad.md` — file
  not present at the documented path when investigated; awaiting
  user to re-share or relocate.)

To revert this change:
```
rw && cp /etc/kvmd/override.yaml.bak-pre-dualmode /etc/kvmd/override.yaml
systemctl restart kvmd
```
The backup file is harmless on its own; just an extra file.

Status: backup created. **NO config changes applied yet.** kvmd has
NOT been restarted. The running config is the same as before this
session.

### Pending — awaiting user notes before any further change

User said the file `/tmp/pikvm-configured-for-ipad.md` contains the
context on prior config attempts and patches. That file isn't where
it was supposed to be. NOT proceeding with any config change until
that context is available — the prior "screen jumps around"
behavior is exactly what we'd risk reproducing.

## Reference: current config (snapshot 2026-04-26)

Effective HID config from `kvmd -m`:
```yaml
hid:
  type: otg
  keymap: /usr/share/kvmd/keymaps/en-us
  mouse:
    device: /dev/kvmd-hid-mouse
    absolute: false                # ← override.yaml sets this
    horizontal_wheel: false        # ← override.yaml sets this
  mouse_alt:
    device: ''                     # ← override.yaml disables alt
    horizontal_wheel: true
```

Defaults would be `mouse.absolute: true` and
`mouse_alt.device: /dev/kvmd-hid-mouse-alt` — the override here
DEPARTS from defaults. The override comment doesn't explain why,
but the user has stated above that prior absolute attempts
produced bad iPad behavior.

`/api/hid` returns `mouse.outputs.available: []` — no alternative
HID outputs currently available to the API.
