# MCP derives its HID mode from the appliance, and is stateless about it

## Status

accepted (2026-08-07) — design greenlit by the manager; part of pikvm-nixos #51.
Not yet shipped. Mover/HID-adjacent, so it takes the mandatory on-device gate at
the iPad node before merge.

## Context

The MCP server drives the pointer differently depending on the target's HID
mode:

- **desktop** — absolute mouse (`mouse.absolute=true`, dual abs+rel gadget); the
  legacy detect-then-move path. `mouseAbsoluteMode = true`.
- **ipad** — single relative mouse (`mouse.absolute=false`); the curve-one-shot
  path. `mouseAbsoluteMode = false`.

Historically the mode was a **declared** value: `--target ipad|desktop` (or
`PIKVM_TARGET`), read once at startup, overriding the HID-detected mode.

pikvm-nixos #51 makes the mode **runtime-switchable on the appliance** (an
executor rewrites a `/var` marker and restarts kvmd-otg then kvmd; the USB
gadget physically re-assembles and the target re-enumerates). The appliance
exposes it over a loopback token endpoint:

- `GET  /hidmode` → `{"mode":"desktop"|"ipad"}` — authoritative current mode.
- `POST /hidmode {"mode":"ipad"}` → `200 {"ok":true,"message":"…session drops…"}`
  — non-locking, honest, no mid-flight guard.

This created a **coherence defect**: `hosts/rpi4.nix` declared
`services.pikvm-mcp.target = "ipad"` while the new kvmd `hidMode.default` seeds
`desktop`. Two places held the mode; after #51 they can disagree at **runtime**,
which is worse than at build time — the MCP would drive relative while the gadget
is assembled absolute (or vice-versa), and a wrong-mode pointer is a silent
failure (absolute moves do nothing on an iPad; a dual-assembled gadget confuses
iPadOS badly).

## Decision

The **appliance owns the mode** (georg's single-source-of-truth, #51 design
point 6). The MCP stops holding a second copy: it **reads** the mode and flips
its own relative/absolute behaviour, becoming **stateless** about mode.

### The mode source is selected by `PIKVM_HIDMODE_URL` *presence*, not a target value

- **ABSENT** (`PIKVM_HIDMODE_URL` unset) → **declared** mode via `target`
  (`--target`/`PIKVM_TARGET`), required, exactly as today. This is the permanent,
  first-class, supported configuration for **stock-Arch pikvm01** (the WB kiosk),
  which will never have a `/hidmode` endpoint. It is **not** a degraded state and
  never fails closed.
- **PRESENT** (`PIKVM_HIDMODE_URL` set) → **derive** the mode from `GET /hidmode`.
  This is the appliance. `services.pikvm-mcp.target` is **deleted** from
  `hosts/rpi4.nix` — the appliance holds exactly one copy of the mode (the kvmd
  marker), and the MCP follows it.

`target` becomes **optional**, with a self-consistency rule enforced at startup:

| `target` | `PIKVM_HIDMODE_URL` | result |
|---|---|---|
| set | unset | declared mode (pikvm01) |
| unset | set | derived mode (appliance) |
| **set** | **set** | **STARTUP ERROR** — the two-copies defect itself, caught at config time |
| unset | unset | STARTUP ERROR — need one source |

### Unreachable endpoint → FAIL CLOSED (no declared fallback on the appliance)

A three-state model, splitting *absent* from *unreachable*:

1. **absent** → declared mode (above); never refuses.
2. **configured + reachable** → derived mode.
3. **configured + unreachable** → **refuse mover ops** (mouse move/click/move_to/
   scroll, calibrate) with an explicit "HID mode unknown — appliance /hidmode
   unreachable" error. Mode-agnostic ops (screenshot, keyboard, health_check,
   hid_recover) still work.

**No declared fallback on the appliance.** A fallback would reintroduce a second
copy of the mode — the exact defect #51 kills — and driving the wrong mode is a
silent failure. On the appliance the endpoint is **loopback**, so "unreachable"
almost always means kvmd is down or mid-switch (the session is dropping),
precisely when driving input is wrong anyway. **Refuse > guess-wrong.**

### Caching, re-reads, and the re-enumeration window

- **Short-TTL cache + re-read on reconnect, not per-call.** The mode changes only
  on an explicit switch, and a switch **drops the session** (kvmd restart → USB
  re-enumerate → the MCP's kvmd connection breaks). So a stale cached mode
  self-corrects on the next broken op. Re-read: at startup, when the TTL expires
  before a mover op, and forced on any reconnect / health_check / recovery.
- **Mode-settling gate.** After a switch the marker flips immediately but the USB
  is gone for seconds, so even a fresh `GET` can report the new mode before the
  HID is live. On any detected mode change (or our own `POST`), refuse mover ops
  ("HID re-enumerating, wait") until the target HID reports **online** again
  (UDC state = ground truth; the kvmd flags lie).

### The MCP exposes a setter (all three surfaces must be able to switch)

georg's locked #51 design mandates the mode be settable on the kvmd API, the web
UI, **and** the MCP tool. So the MCP exposes a setter that `POST`s `/hidmode`.
Its return is **honest** (never "mode is now X"): "switch requested; the session
WILL drop; the new mode is NOT live yet — reconnect and re-read before driving
input." The setter begins the mode-settling gate.

## Consequences

- `hosts/rpi4.nix`: **delete** `services.pikvm-mcp.target = "ipad"`, set
  `PIKVM_HIDMODE_URL` (+ token) instead. (nixos peer's change; the manager is
  routing this to `pikvm-nixos@georgs-mac-mini`.) It only reaches the appliance
  via a flake-pin bump — a merge here is not a deploy (the #41 lesson).
- pikvm01's off-box Mac wrapper is **untouched**: `target=ipad`, no
  `PIKVM_HIDMODE_URL`.
- **Verification honesty.** The coupling test proves the **contract** — the MCP
  reads `/hidmode`, flips `mouseAbsoluteMode`, and gates/settles correctly — not
  an end-to-end real-iPad-on-appliance pointer move. Nobody can currently prove
  appliance iPad mode moves a real pointer: it-03400's OTG link doesn't
  enumerate (cabling, on georg) and the iPad node's ground truth is pikvm01,
  which is stock Arch, not the appliance. Real-iron behavioural stays georg's
  standing iPad-rig gate. A green here reads as "contract satisfied," not
  "verified on iron."

## Known assumption / open dependency: the endpoint must report the ARTIFACT, not the marker

`GET /hidmode` currently reports the appliance's **marker file**
(`/var/lib/kvmd/hidmode`) — i.e. the executor's *intent*, written **before** it
restarts kvmd-otg and kvmd. That makes the resolver vulnerable to a
**confidently-wrong** read, distinct from unreachable: if a switch to `ipad` is
written but the kvmd-otg restart fails / is slow / partially applies, `/hidmode`
returns `ipad` while the assembled USB gadget is still the desktop dual-mouse.
The resolver believes it, flips `mouseAbsoluteMode`, and the mover drives relative
emits into an absolute gadget — a silent no-op on iPad, with the click path
reporting positions it never achieved. This is the deployed≠live class
(pikvm-nixos #49) one level deeper: **marker = intent, the assembled gadget =
truth.** Fail-closed guards *unreachable*; it does not guard *wrong-mode*.

The correct fix is appliance-side (raised with the module author by the iPad
node): the endpoint should report the **assembled gadget** — self-describing in
configfs (`functions/hid.usb1` report_length + descriptor sha: `4/55c045b2…` =
relative-single; `mouse_alt` node present = desktop-dual, absent = ipad-single) —
rather than the marker. Then the resolver consumes `body.mode` **unchanged** and
is correct by construction (one reader of truth, not N clients re-deriving). The
MCP cannot self-mitigate: it is offline from the appliance except through these
endpoints and cannot read configfs directly; and the mode-settling gate clears on
UDC-confirmed-**online**, which does not distinguish online-in-the-right-mode from
online-in-the-wrong-mode. **So this resolver assumes `/hidmode` reports the
assembled gadget.** Until the endpoint does, a failed/partial switch can leave the
derived mode wrong-but-confident.
