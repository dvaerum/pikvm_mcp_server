# PiKVM field-report — problems hit while driving the WashingBrothers kiosk iPad

**Living document.** This is a running log of problems encountered using the
PiKVM MCP server to remote-control the physical WashingBrothers kiosk iPad
(payment testing, Settings navigation, etc.), plus concrete MCP-tool bugs /
improvement ideas surfaced along the way. **Keep appending as new problems
appear** — newest entries at the top of the Problem Log. Maintained by the
Claude agent working the washing-brothers-ios repo.

> ⚠️ **NEWEST → [`2026-07-30-cursor-detection-blocker.md`](2026-07-30-cursor-detection-blocker.md)**
> — reported as "HID healthy but the cursor can't be localized, so ALL clicking
> fails"; it blocked an on-device Stripe test entirely. **VERIFIED on the rig
> 2026-07-30: the symptoms reproduce exactly, but the root cause was HID being
> DOWN** (mouse *and* keyboard dead, UDC `not attached`) — one `soft_connect`
> restored it and clicks landed 4/4 @ 1.0 px. The detector was reporting honestly.
> Two real bugs it surfaced ARE being fixed: the missing `force` escape hatch, and
> `PIKVM_HID_RECOVERY_URL` not being wired on pikvm01 (the incident's real fix).
> See the **VERIFICATION** section at the end of that file before acting on it.

- **App under test:** **WashingBrothers Kiosk** (SwiftUI + WKWebView hosting the
  user-web SPA), bundle id `dk.vammencamping.sumuppayment`, shown as "Kiosk 1"
  (kiosk `b78f7c49`) on screen — this is the app in all screenshots below.
- **Rig:** PiKVM `pikvm01.bb.vcamp.dk` (SSH `root@`, default agent key) driving
  a physical iPad (iPadOS 26.x) over USB-OTG HID + HDMI capture. UDC on this Pi
  is `fe980000.usb`.
- **iPad devicectl id:** `CF2B815D-7960-5B60-987B-FA2DC9A65353`
  (a *separate* channel from PiKVM HID — keeps working when HID is dead; launch
  the app with `xcrun devicectl device process launch --terminate-existing
  --device <id> dk.vammencamping.sumuppayment`).
- **Related existing doc:** [`../2026-07-20-ipad-hid-offline-usb-recovery.md`](../2026-07-20-ipad-hid-offline-usb-recovery.md)
  (the original HID-offline recovery guide — this report validates/extends it).

## How the screenshots in this folder were captured

MCP `pikvm_screenshot` returns an image to the agent but does **not** write a
file. To save evidence to disk, pull the streamer snapshot directly:

```bash
PASS=$(cat ~/.config/sops-nix/secrets/pikvm-password)
ssh root@pikvm01.bb.vcamp.dk \
  "curl -s -k -u admin:$PASS 'https://localhost/api/streamer/snapshot'" \
  > screenshots/NN-description.jpg
```

**To capture the cursor (it auto-fades ~1-2 s after the last move):** do the
move AND the snapshot in ONE pikvm-side command so no MCP/tool round-trip latency
sits between them — move via the HID HTTP API, wait ~1 s, then snapshot. The
cursor is still rendered inside that window:

```bash
ssh root@pikvm01.bb.vcamp.dk "
  curl -sk -u admin:$PASS -XPOST 'https://localhost/api/hid/events/send_mouse_relative?delta_x=260&delta_y=210' -o /dev/null
  sleep 1
  curl -sk -u admin:$PASS 'https://localhost/api/streamer/snapshot'
" > screenshots/NN-cursor.jpg
```

`send_mouse_relative` (relative delta, needs no cursor detection) returns HTTP
200 and the pointer appears. A plain `pikvm_screenshot` then a *separate* `curl`
misses it — the pointer fades in the gap (that's how `11` lost the cursor).

---

## Problem Log (newest first)

### P1 — HID fully dead (keyboard **and** mouse) after PiKVM reboot; only UDC rebind revived it  ⭐ KEY FINDING
**Date:** 2026-07-26 · **Status:** RESOLVED (SSH-side, no physical access) ·
**Screenshot:** `screenshots/00-home-hid-restored.jpg`

**Symptom:** Neither keyboard nor mouse reached the iPad. Every keyboard
shortcut (`⌘-H`, `⌘-Space`, `⌘-,`) was a no-op; the mouse cursor would not
render at all, so `pikvm_seed_cursor_template` failed ("no cursor-sized
motion-diff clusters") and every `pikvm_mouse_click_at` skipped ("cursor
position not verified after move"). HDMI **video was perfectly fine** the whole
time (screenshots returned normally) — which masks the problem.

**Trigger:** the iPad did not re-attach the USB-HID gadget after the PiKVM's OTG
gadget re-presented (here, after a full PiKVM reboot).

**What did NOT fix it (all tried, in order):**
1. `pikvm_hid_recover` / `pikvm_hid_reset` — no effect.
2. **Full PiKVM reboot** via `ssh root@pikvm01 reboot` (uptime confirmed
   2d18h → 0min, a real reboot). Brought **video** back but **not** HID.
3. **`soft_connect` toggle** (`echo disconnect/connect >
   /sys/class/udc/fe980000.usb/soft_connect`). UDC `state` stayed
   **`not attached`** — did not revive HID. *(This was the untested hypothesis in
   the 2026-07-20 doc; now tested — insufficient on its own.)*

**What FIXED it — UDC unbind/rebind over SSH (the "software replug"):**
```bash
G=/sys/kernel/config/usb_gadget/kvmd
echo "" > $G/UDC        # unbind
sleep 3
echo fe980000.usb > $G/UDC   # rebind
# UDC state flips: not attached -> configured
```
After this, `state` read **`configured`** and `⌘-H` immediately took the iPad to
the Home screen (verified — see screenshot). **No physical cable replug was
needed** — correcting an earlier assumption. Precondition: the iPad must be
**awake** (screenshot returns a live image), which it was.

**Reliable recovery ladder for next time** (least→most disruptive, stop as soon
as `state`=`configured` and a behavioral test passes):
1. Confirm iPad awake (`pikvm_screenshot` returns an image).
2. `soft_connect` disconnect→connect. Re-check `state`.
3. **UDC unbind/rebind** (above). ← this is what actually worked.
4. Behavioral confirm: `⌘-H` → Home, or seed cursor + move.
5. Only if all fail, escalate to PiKVM reboot (and note it may still not help if
   the iPad is asleep).

---

### P1.5 — Mouse too imprecise to enter a 4-digit PIN pad (concrete session, with screenshots)  📸
**Date:** 2026-07-27 00:0x–00:4x · **Status:** open (blocked the task; worked around) ·
**Screenshots — the WashingBrothers Kiosk admin "Enter admin PIN" pad, cursor
present vs faded (this IS the surface that has to be tapped):**
- `screenshots/13-pinpad-cursor-visible.jpg` — the PIN pad **with** the mouse
  cursor (orange arrow by the "2" key), captured within ~1 s of a move.
- `screenshots/14-pinpad-cursor-faded.jpg` — the **same** pad 3.5 s later with no
  move: the cursor has **faded to nothing**. This is the state every digit-tap
  starts from, so detect-then-move finds no cursor and the tap is skipped.
- 13 vs 14 is the clicking problem in two frames. (Grid-level equivalents:
  `10-grid-before-pinpad.jpg` target surface, `11-cursor-faded-invisible.jpg`
  faded, `12-cursor-after-move.jpg` cursor freshly moved.)

**Opening the pad:** the gear button (bottom-right) is mouse-only and its taps
kept getting skipped (faded cursor) — but **`⌘-,` opens the admin PIN pad from
the hardware keyboard** (verified 2026-07-27), which sidesteps the gear entirely.
It does NOT help with the 4 digits, though: the pad still only accepts on-screen
taps, so you open with the keyboard and are then stuck on the mouse for the PIN.

**Task:** open the kiosk app's admin panel (tap the gear → tap 4 digits on a
custom on-screen NumericPinPad → tap Unlock) to run a printer Test Print. The
app's PIN pad **ignores the hardware keyboard** (`pikvm_type "1234"` left the
field on its "PIN" placeholder), so it is **mouse-only** — and the mouse could
not do it. Raw evidence from this one session:

- **Opening the panel (single large target, the gear):** `pikvm_mouse_click_at`
  reported *"V8 start detection failed (no cursor found)"* → *"4 attempts (all
  failed) … cursor position not verified after move."* Click **skipped entirely**.
  Forcing it with `requireVerifiedCursor:false` then clicked at the cursor's
  **stale position (top-left corner)** — the target gear was bottom-right, a
  ~1400 px miss. (The MCP live screenshot caught the orange cursor stranded
  top-left; by the time the disk snapshot was pulled ~1-2 s later it had faded to
  nothing — see `11`.)
- **Retry-on-miss DOUBLE-ENTERS on a keypad:** a keypad tap adds one dot to the
  PIN field — a <0.5 % pixel change — so `verifyClick` reads it as "no visible
  change" and retries. Each retry taps the SAME digit again. Result: one intended
  "1" → the field showed **two dots**, then a mis-moved "backspace" (clicked at
  the stale cursor position = the "1" key again) made it **three** → `111`. Never
  got a clean `1234` in.
- **Brightness gate false-trips on the app's own dark modal:** the PIN sheet dims
  its backdrop, so `click_at` aborted with *"iPad display blocked (mean
  brightness=27/255)"* even though the iPad was awake and bright. Needed
  `minBrightness:0` to proceed.
- **`Escape` does not dismiss** an in-app SwiftUI modal (only relaunching the app
  cleared the stuck pad).

**Net:** could not complete a 4-tap PIN via the remote mouse at all. Worked
around by having backend-dev drive the equivalent action server-side (no PIN).
The precision ceiling isn't just "~50-60 %" for a *single* target (P2) — for a
*sequence* of small adjacent targets it's effectively unusable, because every
missed/duplicated tap corrupts prior state. See M1–M3, and new **M6/M7** below.

---

### P2 — Cursor auto-fade → `click_at` / `seed_cursor_template` fail even when mouse HID is alive
**Date:** ongoing · **Status:** WORKAROUND known · see **P1.5** for a concrete, screenshotted instance

iPadOS fades the trackpad pointer after a few seconds of inactivity. Once faded,
the ML cursor detector finds nothing, so `pikvm_mouse_click_at` refuses to click
("cursor position not verified") and `seed_cursor_template` returns "no
motion-diff clusters" — **even with a large emit** (tried ±200/±400/±500 px).
This is distinct from P1 (there the HID itself was down). Net effect: mouse
control has a ~50–60% success ceiling and frequently stalls entirely.

**Workaround:** prefer keyboard-driven navigation (`pikvm_key` /
`.keyboardShortcut(...)` in-app). For anything that *must* use the mouse, this is
the biggest reliability tax on the whole rig — see improvement ideas M2/M3.

---

### P3 — `pikvm_health_check` HID flags are unreliable ("lie")
**Date:** ongoing · **Status:** known, use behavior instead

`pikvm_health_check` has reported `mouse=offline, keyboard=offline` while input
worked fine, and (separately) the streamer `online` flag has read false while
the screen was live. Conversely the flags stayed `offline` after HID was
actually restored. **Ground truth is the UDC `state` node**
(`/sys/class/udc/fe980000.usb/state` = `configured` vs `not attached`) plus a
behavioral test (move mouse / send `⌘-H` and screenshot). Don't trust the health
flags for HID up/down decisions.

---

### P4 — `pikvm_mouse_scroll` scrolls at the (unknown) current pointer location
**Date:** 2026-07-26 · **Status:** open

Trying to scroll the iPad Settings sidebar, `pikvm_mouse_scroll` sent the wheel
events (`Scrolled (0, 120)`) but nothing moved — because the pointer was over the
detail pane, not the sidebar, and the tool has no way to target a pane. With the
cursor faded (P2) I also couldn't move the pointer to the sidebar first. The
scroll primitive needs an optional target coordinate (move-then-scroll) — see M1.

---

## MCP tool bugs / improvement ideas

> **Shipped 2026-07-27:** M0 and M5 below were implemented in `pikvm_mcp_server`
> as new MCP tools — `pikvm_usb_reconnect` and `pikvm_snapshot`. See the ✅ notes.

- **M0 — add a `pikvm_usb_reconnect` primitive.** ✅ **SHIPPED as
  `pikvm_usb_reconnect`.** Encapsulate the P1 recovery ladder (soft_connect →
  UDC unbind/rebind → poll `state` for `configured` → behavioral confirm). This
  turns a multi-minute, multi-SSH manual recovery (or a wasted PiKVM reboot) into
  one call. The 2026-07-20 doc proposed this for `soft_connect` only; **it must
  include the UDC rebind**, since soft_connect alone was proven insufficient (P1).
  *The shipped tool does exactly this: runs soft_connect then udc-rebind (no
  destructive reboot), and verifies each rung by BOTH the ground-truth UDC state
  AND a behavioral move-and-diff, because the kvmd HID flags lie (P3). Reach for
  it first when HID dies; escalate to `pikvm_hid_recover` only if it fails.*
- **M1 — `pikvm_mouse_scroll` should accept an optional `x`/`y` target** (move
  pointer there, then scroll) so callers can scroll a specific pane. Today it
  scrolls wherever the pointer happens to be (P4). **⚠ SHIPPED but BROKEN ON iPad
  (live-verified 2026-07-27):** the x/y targeting calls `pikvm.mouseMove` =
  ABSOLUTE positioning (`send_mouse_move to_x/to_y`), which **iPadOS ignores** (the
  iPad is a *relative* trackpad — same reason curve-one-shot exists). 3 screenshot
  tests: absolute moves don't move the cursor, relative do → the scroll still fires
  at the stale pointer, i.e. M1 provides NO pane targeting on iPad (works on desktop
  only). **Fix:** route the move through the platform-aware `moveToPixel`
  (curve-one-shot), the same path `click_at` uses — not raw `mouseMove`.
- **M2 — `seed_cursor_template` / `click_at` need a stronger cursor-wake.** When
  the pointer is fully faded, no emit size reveals it (P2). Options: a "jiggle"
  loop (several alternating small moves) before the diff, or an absolute-position
  fallback that clicks by dead-reckoning from a known corner with a follow-up
  verify instead of refusing outright.
- **M3 — expose `requireVerifiedCursor=false` more ergonomically** and pair it
  with a post-click screen-diff verify, so a faded-cursor click can still be
  *attempted* and judged by whether the screen changed, rather than skipped.
- **M4 — surface UDC `state` in `pikvm_health_check`.** The `/sys/class/udc/.../state`
  value (`configured`/`not attached`) is the *reliable* HID-attach signal; the
  current `hid.*.online` flags are not (P3). Add it to health output.
- **M5 — a first-class snapshot-to-file function (its own tool), + `savePath` on
  `pikvm_screenshot`.** ✅ **SHIPPED as `pikvm_snapshot(savePath, region?, quality?,
  maxWidth?, maxHeight?)`** — grabs `/streamer/snapshot`, optional region crop,
  writes the JPEG, returns path + byte size; no base64 through the conversation,
  no SSH/curl. Verified 2026-07-27 (saved 1920×1080 in one call). This is exactly
  the standalone primitive requested: it lets everything else compose it (see M8 —
  the mouse tools' before/during/after capture is just this called at each phase).
  *(Corollary from P1.5, now moot: the ONLY frame that contained the stranded
  cursor used to be the un-saveable MCP screenshot; `pikvm_snapshot` — ideally
  paired with a move so the cursor is rendered — now captures it directly.)*
- **M6 — `verifyClick` must not double-fire on keypads (P1.5).** When a click's
  legitimate effect is a sub-threshold pixel change (one dot on a PIN field, a
  key highlight), the retry loop re-taps the SAME key and corrupts input. Fix
  options: (a) a `singleTap`/`noRetry` fast-path that clicks exactly once; (b)
  verify against a **caller-supplied expected region** (the PIN dots box) instead
  of a global pixel-fraction; (c) for sequential entry, expose a
  `pikvm_type_on_pinpad`-style helper that taps digit buttons by label with no
  per-tap verify. Today `maxRetries:0` still moved-then-clicked at a stale
  position; the real need is "tap once at a KNOWN screen coord, don't re-move."
- **M7 — an absolute "tap at these HDMI coords, don't hunt the cursor" primitive
  (P1.5).** Every failure here stemmed from detect-then-move being unable to find
  a faded cursor. A mode that parks the cursor deterministically (e.g. a measured
  home-corner move, then a known relative delta to the target) and taps — with an
  optional post-tap screen-diff to report hit/miss — would sidestep cursor
  detection entirely for sequences of small targets. `assume-at` is close but
  requires the caller to already know where the cursor is.
- **M8 — mouse-move / click tools need a built-in `capture` option (before /
  during / after).** The cursor only renders *while/just after* it moves, so the
  ONLY reliable moment to photograph it is *inside* the move/click op — a separate
  `pikvm_screenshot` (or curl) always races the ~1-2 s fade and loses it (that's
  how `11` came out cursor-less; the pikvm-side move→sleep→snapshot workaround is
  what got `12`). So `pikvm_mouse_move` / `pikvm_mouse_move_to` /
  `pikvm_mouse_click_at` should accept e.g.
  `capture: ["before","during","after"]` (+ a `savePath`/prefix) and return/write
  a frame at each requested phase, grabbed on the server with no round-trip gap:
  - **before** — the target region pre-move (baseline for a diff),
  - **during** — mid-motion, the frame where the cursor is guaranteed rendered
    (this is the one that's otherwise impossible to catch), and
  - **after** — post-click, to visually confirm what changed / whether it landed.
  This makes the move itself self-documenting, turns click hit/miss verification
  into a real before→after image pair, and is the tool-native version of the
  manual `send_mouse_relative`→`sleep 1`→snapshot recipe now in the screenshots
  section. It shouldn't reimplement snapshotting — it just calls the standalone
  snapshot function (M5) at each requested phase. Pairs with M5 (standalone
  snapshot-to-file) and M6 (region-scoped verify).

---

## Access / environment quick-reference
- SSH: `ssh root@pikvm01.bb.vcamp.dk` (agent default key authorized).
- UDC: `fe980000.usb`. Gadget configfs: `/sys/kernel/config/usb_gadget/kvmd`.
- Snapshot to file: **`pikvm_snapshot(savePath, region?)`** (shipped 2026-07-27 —
  M5). Fallback: `curl -s -k -u admin:$PASS https://localhost/api/streamer/snapshot`
  (`$PASS` = `~/.config/sops-nix/secrets/pikvm-password`).
- HID dead (no cursor / no keys): **`pikvm_usb_reconnect`** first (shipped
  2026-07-27 — M0; soft_connect→udc-rebind, no reboot). Manual fallback = the
  UDC unbind/rebind in P1.
- iPad devicectl id: `CF2B815D-7960-5B60-987B-FA2DC9A65353`
  (`xcrun devicectl device process launch --device <id> com.apple.Preferences`
  opens Settings foreground with no HID — the escape hatch when HID is dead).

## Changelog
- **2026-07-27** (ios-agent side) — confirmed both shipped tools from the
  washing-brothers-ios session that filed this report: **`pikvm_usb_reconnect`**
  (M0) and **`pikvm_snapshot`** (M5) are now present; `pikvm_snapshot` re-verified
  (1920×1080 saved in one call, no SSH/curl). Marked M0/M5 ✅ in the ideas list.
  Noted the maintainer's M1-iPad-FAIL finding matches what this session saw
  (absolute moves don't land on iPadOS; curve-one-shot / relative is the only path).
- **2026-07-27** (live-verify cycle, iPad node) — M6 singleTap LIVE-verified + merged
  (#25): default maxRetries=3 triple-fired one PIN tap AND escaped the dismissed pad
  to tap a machine card → payment screen; singleTap = one tap/one dot. Fixed the
  `PIKVM_PREDOWN_DIR` proof-shot to keep the cursor alive (#26) so the "where was it
  about to click?" frame isn't cursorless. M5 LIVE-verified PASS (snapshot-to-file +
  exact region crop). **M1 LIVE-verified FAIL on iPad** — absolute `mouseMove` is a
  no-op on iPadOS, so x/y pane targeting doesn't work on iPad (fix: route via
  `moveToPixel`/curve-one-shot). M2/M7 jiggle-wake proven UNNECESSARY earlier
  (curve-one-shot handles the faded cursor; control == jiggle 100%).
- **2026-07-27** (later) — captured the actual admin PIN-pad pair
  `13-pinpad-cursor-visible.jpg` / `14-pinpad-cursor-faded.jpg` (cursor present
  vs faded on the exact surface being tapped); noted `⌘-,` opens the admin pad
  from the keyboard (digit entry still mouse-only); named the app under test
  (WashingBrothers Kiosk, `dk.vammencamping.sumuppayment`) in the header.
- **2026-07-27** — added P1.5 (mouse can't enter a 4-digit PIN pad — concrete
  session with screenshots `10`/`11`/`12`) and tool ideas M6 (verifyClick
  double-fires on keypads), M7 (absolute tap-without-cursor-hunt primitive), and
  **M8** (mouse-move/click tools need a built-in before/during/after `capture`
  option — the only reliable way to photograph the cursor is inside the move op);
  cross-linked P2. Added the cursor-capture technique (pikvm-side
  move→sleep→snapshot via `send_mouse_relative`) to the screenshots section, and
  screenshot `12` (cursor visible right after a move) as the fade-contrast to `11`.
- **2026-07-26** — created; logged P1 (HID dead → UDC-rebind fix, key finding),
  P2–P4, and M0–M5 tool ideas.
