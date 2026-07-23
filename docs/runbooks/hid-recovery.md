# Runbook: HID recovery (mouse/keyboard not driving the target)

Canonical procedure for recovering the PiKVM's emulated USB HID gadget when
mouse/keyboard stop working. Backed by `src/pikvm/hid-recovery.ts` and the
`pikvm_hid_recover` tool. Ladder firsthand-confirmed 2026-07-22/23.

> **Honesty up front.** The remote rungs can **all fail** — on 2026-07-22 only a
> physical re-plug recovered it. R1 (soft reset) is a cheap first try that
> usually does **not** fix a controller-level drop. R2 (soft_connect) and R3a
> (UDC rebind) are **untested** as recoveries. R3b (reboot) is the most reliable
> remote option (worked once, target awake) but destructive. R4 is a human.

## R0 — presence gate (do this first)

Nothing in the ladder can recover a target that isn't there: an asleep iPad / a
powered-off machine won't enumerate USB. **Behavioral** check: a `pikvm_screenshot`
returns an image. If it doesn't, **wake / power on the target first** — no rung
will work. (`checkTargetPresent()`.)

## Detect vs verify

- **Detect (cheap trigger):** `getHidProfile()` (`GET /api/hid`) with
  `mouseOnline && keyboardOnline` false. Decides whether to *start* the ladder.
- **Verify (authoritative):** the online flags have **lied**, so recovery is
  confirmed **behaviorally** — emit a mouse move and check the screen actually
  changed (cursor moved). Every rung is verified this way, not by the flags.
  (`makeBehavioralVerifier()`; heuristic — live-tunable like the desktop residuals.)

## The ladder

`pikvm_hid_recover` runs this: R0 gate → escalate up to `maxRung`, behavioral-verify
after each; `allowReboot` gates the destructive R3b; R4 is the terminal human
escalation when everything remote fails.

| Rung | Action | Backing | Reliability | Owner |
|------|--------|---------|-------------|-------|
| **R1** | Soft reset | `resetHid()` → `POST /hid/reset` [+ `set_connected 0→1`] (also `pikvm_hid_reset`) | **LOW** — can't force host re-enumeration; `set_connected` is a **no-op on our unit** (live 2026-07-19); did not recover the incident | **MCP** (built) |
| **R2** | `soft_connect` toggle | host: `echo disconnect > /sys/class/udc/<udc>/soft_connect; sleep 2; echo connect > …` (toggles USB D+ pull-up; udc on the Pi = `fe980000.usb`; healthy reads `configured`) | **UNTESTED** — cheap intermediate; preferred over a kvmd-otg restart (avoids the FileExistsError trap) | **pikvm-nixos** + MCP invoke/verify |
| **R3a** | UDC rebind | host: configfs UDC unbind→bind, or `systemctl restart kvmd-otg` | **UNTESTED**; must be **idempotent** (FileExistsError trap) | **pikvm-nixos** + MCP |
| **R3b** | Reboot the PiKVM | host reboot | Most reliable remote option (worked once, target awake). **DESTRUCTIVE** (~30-90s incl. this server); opt-in `allowReboot` | **pikvm-nixos** + MCP trigger/wait/verify |
| **R4** | Human physical action | re-plug the target USB (not charge-only) / power it on | The known-always fix; remote rungs can all fail | **Human** |

Notes:
- **R3b is not the kvmd ATX API** — that reboots the *target* PiKVM drives, not
  the Pi. We reboot the **Pi host** to rebuild its USB gadget stack.
- **Verify after reboot** = client-side wait: poll the behavioral verify until
  healthy (the endpoint is down for the reboot window).

## Trigger interface (MCP ↔ pikvm-nixos)

R2/R3a/R3b are privileged host operations. The MCP service runs unprivileged
(`DynamicUser`, `ProtectSystem=strict`) and delegates them to a privileged helper
pikvm-nixos provides. MCP end: `makeHttpRecoveryTrigger()`.

**Contract (proposed — pikvm-nixos to confirm/adjust):**

- **Transport:** MCP `POST`s JSON to a loopback helper URL.
  - MCP config (wired): `PIKVM_HID_RECOVERY_URL` (e.g.
    `http://127.0.0.1:8082/hid-recovery`), optional `PIKVM_HID_RECOVERY_TOKEN`,
    `PIKVM_HID_RECOVERY_VERIFY_SSL`. Unset ⇒ host rungs report **unavailable**.
- **Request:** `POST <url>`, `Content-Type: application/json`,
  `Authorization: Bearer <token>`, body — **action set `{soft_connect,
  udc-rebind, reboot}`**:
  ```json
  { "action": "soft_connect" }   // or "udc-rebind" or "reboot"
  ```
- **Response:** `200 { "ok": true, "message": "…" }` on success; non-2xx / `ok:false`
  on failure. `soft_connect` and `udc-rebind` must be **idempotent**
  (handle the FileExistsError trap; prefer `soft_connect`, which avoids it). For
  `reboot`, reply before the host goes down if possible; the MCP client also
  treats a dropped connection as "reboot initiated" and switches to wait-for-online.
- **Security:** loopback-only bind + bearer token (nixos provisions it as a
  systemd credential / sops secret); the actions are destructive.
- **Verification is the MCP client's job** (behavioral, per above).

## MCP-side status (built vs pending)

- **Built (offline):** R0 `checkTargetPresent`, `makeBehavioralVerifier`,
  `waitForRecovery`, the `recoverHid` orchestrator (R0→R1→R2→R3a→R3b→R4), the
  HTTP trigger client, and `pikvm_hid_recover`. R1 runs today; R2/R3a/R3b are
  stubbed against the trigger and report unavailable until
  `PIKVM_HID_RECOVERY_URL` is set.
- **Pending (pikvm-nixos, after the U2 kvmd-ordering fix):** the privileged host
  helper implementing the trigger contract's THREE actions — `soft_connect`,
  idempotent `udc-rebind`, `reboot`.
- **Pending (live-rig sign-off):** which rung actually recovers HID on this unit
  (R2 soft_connect? R3a UDC rebind? or only R3b reboot / R4 physical)? That
  decides the preferred fix.
