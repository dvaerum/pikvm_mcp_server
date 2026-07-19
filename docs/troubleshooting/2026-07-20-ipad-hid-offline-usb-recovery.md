# iPad HID offline / USB not enumerating — recovery guide

_Written 2026-07-20 after a long, painful debugging session. Read this BEFORE
touching the iPad or rebooting anything — it will save you (and me) an hour._

## Symptom

`pikvm_health_check` / `/api/hid` reports **`mouse=offline, keyboard=offline`**,
and mouse/keyboard input does nothing on the iPad (no cursor appears when you
move the mouse). Video (HDMI) may be **perfectly fine** at the same time.

Most often triggered by: an **iPad reboot** or power event, or a botched
`kvmd-otg` restart. The PiKVM is presenting a USB mouse/keyboard gadget, but the
**iPad isn't enumerating it**.

## Rule 0 — trust behavior, not status flags

Two flags lied to us today; don't repeat the mistake:

- **`streamer.source.online` read `undefined`/false while the screen was
  perfectly live.** Never conclude "screen off / no HDMI" from that flag —
  **take a `pikvm_screenshot`.** If you get an image, the screen is fine. A 503
  from the screenshot is the real "no signal" signal.
- The `hid.*.online` flags were accurate *this* time, but confirm input the
  behavioral way anyway: **move the mouse and screenshot** — if a cursor appears
  and moves, input works regardless of the flag.

## Rule 1 — DO NOT reboot the iPad to fix pointer/tracker state

This is what set off the whole mess. Rebooting the iPad (`devicectl device
reboot`) to reset a stuck iPadCollector PointerTracker **backfired**: the iPad
came back and would **not re-enumerate the USB HID** — and no amount of
PiKVM-side action (HID reset, UDC rebind, PiKVM reboot ×2) brought it back while
the iPad was asleep. It stayed dead until a physical power-on + a clean PiKVM
reboot. **Fix tracker issues app-side, never with an iPad reboot.**

## Recovery ladder (least → most disruptive)

All PiKVM commands run over SSH via the loopback proxy:
```
ssh -o ProxyCommand='/usr/bin/nc -X connect -x 127.0.0.1:8888 %h %p' \
    -o BatchMode=yes -o StrictHostKeyChecking=no root@10.109.1.1 '<cmd>'
```
UDC on this Pi: **`fe980000.usb`**.

1. **Make sure the iPad is AWAKE first.** An asleep iPad won't enumerate USB. If
   the screen is off but you can't send keys (HID down), you may need a physical
   tap/power-button on the iPad. (An awake iPad is the precondition for
   everything below actually working.)

2. **HID soft reset** (via MCP `pikvm_hid_reset`, or `POST /api/hid/reset`).
   Cheap; re-inits the gadget. **Did NOT help** in today's case, but it's the
   free first try.

3. **⭐ USB soft-connect toggle — the "turn the port off/on without rebooting"
   we were looking for. TEST THIS FIRST next time (before any reboot):**
   ```
   echo disconnect > /sys/class/udc/fe980000.usb/soft_connect
   sleep 2
   echo connect    > /sys/class/udc/fe980000.usb/soft_connect
   ```
   This toggles the USB D+ pull-up — an *electrical* unplug/replug of the gadget,
   without touching kvmd or the whole box. Node confirmed present today; state
   node reads `configured` when healthy. **Untested as a recovery** (we found it
   only after the reboot already fixed things) — this is the hypothesis to
   validate next time. If it works, it replaces the reboot entirely.

4. **UDC unbind/rebind** (software re-plug, one level heavier than soft_connect):
   ```
   G=/sys/kernel/config/usb_gadget/kvmd
   echo "" > $G/UDC; sleep 3; echo fe980000.usb > $G/UDC
   ```
   Tried today — the iPad did **not** re-enumerate. But that was from an already
   broken state (see the kvmd-otg trap below), so not a clean test.

5. **Full PiKVM reboot** (`systemctl reboot`). **This is what actually worked**,
   but ONLY once the iPad was awake. A reboot with the iPad asleep did nothing.
   It's the sledgehammer; the point of steps 3–4 is to avoid needing it.

## Trap: never `systemctl restart kvmd-otg` naively

`systemctl restart kvmd-otg` **fails** with:
```
FileExistsError: [Errno 17] File exists: '/sys/kernel/config/usb_gadget/kvmd'
```
Its `stop` doesn't remove the gadget dir, so `start` can't recreate it — and it
leaves the gadget **half-broken**, making HID worse. A **reboot clears configfs**
and `kvmd-otg` comes up clean at boot ("Ready to work", UDC written). If you must
restart it without a reboot, tear the gadget down properly first (unbind UDC +
`rmdir` the gadget tree) — or just use the soft-connect toggle (step 3), which
doesn't touch kvmd-otg at all.

## The likely-better long-term solution (to test next time)

**Add a `pikvm_usb_reconnect` primitive that toggles `soft_connect`** (step 3),
and reach for it — not a reboot — whenever HID drops. If validated, it turns a
~3-minute reboot-and-recover into a ~5-second toggle. Sequence to try:
1. Confirm iPad awake (screenshot returns an image).
2. `soft_connect` disconnect → wait 2s → connect.
3. Poll `/api/hid` for `mouse=online` (≤15s), then move-mouse + screenshot to
   confirm a real cursor.
4. Only if that fails after ~2 tries, escalate to a full PiKVM reboot.

## One-line summary

Screen "off" is usually a lying flag — screenshot it. Don't reboot the iPad.
When HID drops, make sure the iPad is awake, then try the **`soft_connect`
toggle** before ever rebooting the PiKVM.
