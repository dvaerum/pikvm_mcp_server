# Runbook: HID recovery (mouse/keyboard offline)

Canonical procedure for recovering the PiKVM's emulated USB HID gadget when the
mouse and keyboard stop working. Backed by `src/pikvm/hid-recovery.ts` and the
`pikvm_hid_recover` tool.

> **Honesty up front.** Rung 1 (soft reset) is a cheap first try that is **known
> not to reliably recover** this failure. Rung 3 (reboot) is the currently
> **known-reliable** fix. Rung 2 (UDC rebind) is the **untested** candidate for a
> no-reboot fix — a live-rig sign-off will decide whether it replaces reboot as
> the preferred remedy.

## Detect

The failure signature (observed live this project, after idle):

- `pikvm_health_check` / `getHidProfile()` (`GET /api/hid`) reports **`online:
  true`** but **`mouseOnline: false` and `keyboardOnline: false`**;
- video still works (`pikvm_screenshot` succeeds).

Detection rule: HID is **broken** when `mouseOnline && keyboardOnline` is false.
Recovery target: both back to `true`. (`isHidBroken()` in the module.)

## The ladder

Try in order, cheapest first; verify `mouseOnline && keyboardOnline` after each.
`pikvm_hid_recover` automates this (`maxRung`, `allowReboot`).

| Rung | Action | Backing | Fixes | Reliability | Verify | Owner |
|------|--------|---------|-------|-------------|--------|-------|
| **1** | Soft reset | `resetHid()` → `POST /hid/reset` [+ `set_connected 0→1` when `reconnectUsb`] (also the `pikvm_hid_reset` tool) | A transient/software gadget glitch | **LOW.** Can't force the host to re-enumerate; `set_connected` is a **no-op on our unit** (live-verified 2026-07-19). Did **not** recover the observed incident (x3 + 5s settles). | `getHidProfile` → both online | **MCP** (built) |
| **2** | UDC rebind / `kvmd-otg` restart | configfs UDC unbind→bind, or `systemctl restart kvmd-otg`, via the **host trigger** below | Recreates the gadget at the **controller** level (what the soft reset can't) | **UNTESTED on this unit** — the no-reboot candidate | poll `getHidProfile` until both online (short window) | **pikvm-nixos** (host mechanism) + MCP (invoke/verify) |
| **3** | Reboot the PiKVM device | host reboot via the **host trigger** below | Full USB-stack reset | **Known-reliable** (the human's fix was a device-level reboot/re-plug). Destructive: whole appliance (incl. this server) down ~30-90s. Opt-in (`allowReboot`). | client-side **wait-for-online**: poll until the endpoint answers **and** `getHidProfile` both online | **pikvm-nixos** (privileged reboot) + MCP (trigger/wait/verify) |

Notes:
- **Rung 3 is not the kvmd ATX API.** kvmd's ATX power controls reboot the
  *target* machine PiKVM drives, not the Pi itself — we need to reboot the **Pi
  host** to rebuild its USB gadget stack.
- **FileExistsError trap (rung 2):** re-creating/re-binding the configfs gadget
  when it already exists raises `FileExistsError`; the host mechanism must be
  idempotent (unbind-if-bound, ignore-exists).

## Trigger interface (MCP ↔ pikvm-nixos)

Rungs 2-3 are privileged host operations. The MCP service runs unprivileged
(`DynamicUser`, `ProtectSystem=strict`) and **cannot** rebind a UDC or reboot the
host, so it delegates to a **privileged helper that pikvm-nixos provides**. The
MCP end is `makeHttpRecoveryTrigger()`; pikvm-nixos implements the listener.

**Contract (proposed — pikvm-nixos to confirm/adjust):**

- **Transport:** the MCP server `POST`s JSON to a localhost helper URL.
  - Config (MCP side, already wired): `PIKVM_HID_RECOVERY_URL` (e.g.
    `http://127.0.0.1:8082/hid-recovery`), optional `PIKVM_HID_RECOVERY_TOKEN`,
    `PIKVM_HID_RECOVERY_VERIFY_SSL`. Unset ⇒ rungs 2-3 report **unavailable**.
- **Request:** `POST <url>`  `Content-Type: application/json`,
  `Authorization: Bearer <token>` (shared secret, provisioned by nixos as a
  systemd credential / sops secret; loopback-only), body:
  ```json
  { "action": "udc-rebind" }   // or { "action": "reboot" }
  ```
- **Response:**
  - `udc-rebind`: `200 { "ok": true, "message": "…" }` on success; non-2xx or
    `ok:false` on failure. Must be idempotent (handle the FileExistsError trap).
  - `reboot`: return `202`/`200` **before** the host goes down if possible; the
    MCP client also treats a dropped connection after the request as
    "reboot initiated" and switches to wait-for-online.
- **Auth/security:** bind loopback only; require the bearer token; the action is
  destructive so it must not be reachable off-host.
- **Verification is the MCP client's job:** after either action it polls
  `getHidProfile` (rung 2: short timeout; rung 3: ~30-90s reboot window) and
  reports RECOVERED / STILL BROKEN.

The clean cert/endpoint naming on the nixos side (mirroring the mcpProxy TLS
attrs) is pikvm-nixos's to finalize — MCP matches whatever names they land on.

## MCP-side status (what's built vs pending)

- **Built (offline):** detection (`isHidBroken`), `waitForHidOnline`, the
  `recoverHid` orchestrator, the HTTP trigger client, and the `pikvm_hid_recover`
  tool. Rung 1 runs today; rungs 2-3 are stubbed against the trigger and report
  unavailable until `PIKVM_HID_RECOVERY_URL` is set.
- **Pending (pikvm-nixos, after the U2 kvmd-ordering fix):** the privileged host
  helper implementing the trigger contract — the UDC-rebind mechanism
  (idempotent) and the reboot path.
- **Pending (live-rig sign-off):** does UDC rebind actually recover HID on this
  unit? That decision picks rung 2 vs rung 3 as the preferred fix.
