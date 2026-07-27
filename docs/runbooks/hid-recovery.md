# Runbook: HID recovery (mouse/keyboard not driving the target)

Canonical procedure for recovering the PiKVM's emulated USB HID gadget when
mouse/keyboard stop working. Backed by `src/pikvm/hid-recovery.ts` and the
`pikvm_hid_recover` tool. Ladder firsthand-confirmed 2026-07-22/23/26.

> **Status — TWO failure modes (updated 2026-07-27, WB field report P1).** Which
> rung fixes it depends on the mode; the ladder must ESCALATE R2→R3a, not stop at R2:
> - **Mode A — idle-drop** (mouse offline after inactivity): **R2 `soft_connect`**
>   recovers it in ~6s (validated 2026-07-23, after R1 failed).
> - **Mode B — full HID dead after a PiKVM reboot / gadget re-present** (mouse AND
>   keyboard dead, UDC `not attached`): **R2 `soft_connect` is INSUFFICIENT** (state
>   stays `not attached`); **R3a UDC unbind/rebind is what revives it** (validated
>   2026-07-26). A PiKVM reboot alone did NOT restore HID here — the UDC rebind was
>   still needed after it.
> R1 (soft reset) is a cheap first try that fixed neither. R3b (reboot) is the
> destructive last resort. R4 (human re-plug) is the final fallback — the 2026-07-22
> "needed a physical re-plug" was pre-`soft_connect`/pre-UDC-rebind (only R1 existed).

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
| **R1** | Soft reset | `resetHid()` → `POST /hid/reset` [+ kvmd `set_connected 0→1`] (also `pikvm_hid_reset`) | **LOW** — can't force host re-enumeration; kvmd `set_connected` is a **no-op on our unit** (its `connected` is unwired; live 2026-07-19/23); did not recover the incident | **MCP** (built) |
| **R2** | `soft_connect` toggle | host: `echo disconnect > /sys/class/udc/<udc>/soft_connect; sleep 2; echo connect > …` (kernel USB D+ pull-up; udc on the Pi = `fe980000.usb`; healthy reads `configured`) | **Mode A: VALIDATED 2026-07-23** — recovered a ~4h-idle drop in ~6s (state `not attached`→`configured`) after R1 failed. **Mode B: INSUFFICIENT** — WB report 2026-07-26, after a reboot the state stayed `not attached`; had to escalate to R3a. A distinct kernel mechanism from R1's kvmd toggle (bypasses kvmd); no FileExistsError. Always try first (cheap), but don't stop here if `state` stays `not attached` | **pikvm-nixos** + MCP invoke/verify |
| **R3a** | UDC rebind | host: configfs UDC unbind→bind (`echo "" > $G/UDC; sleep 3; echo fe980000.usb > $G/UDC`, `G=/sys/kernel/config/usb_gadget/kvmd`). **Do NOT `systemctl restart kvmd-otg`** (FileExistsError trap: its stop leaves the gadget dir) | **VALIDATED 2026-07-26 (WB report P1)** — after a reboot left HID fully dead (Mode B) and R2 was insufficient, the unbind/rebind flipped state `not attached`→`configured` and ⌘-H reached Home (no physical replug). The reliable rung for Mode B; must be **idempotent** | **pikvm-nixos** + MCP |
| **R3b** | Reboot the PiKVM | host reboot | Destructive last-resort remote option (~30-90s incl. this server); opt-in `allowReboot`. **Rarely needed** now R2 works | **pikvm-nixos** + MCP trigger/wait/verify |
| **R4** | Human physical action | re-plug the target USB (not charge-only) / power it on | Final fallback. The 07-22 re-plug was pre-`soft_connect` (only R1 existed then) | **Human** |

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
- **Live-rig sign-off — TWO modes confirmed:** (2026-07-23) R2 `soft_connect`
  recovered a Mode-A idle drop in ~6s after R1 failed; (2026-07-26, WB report P1)
  a Mode-B full-dead-after-reboot needed R3a UDC rebind — R2 was insufficient and
  a reboot alone didn't restore HID. So the host helper must try `soft_connect`
  first (cheap; fixes Mode A) then **escalate to `udc-rebind`** (fixes Mode B) —
  both now validated actions; `reboot` is the rarely-reached last resort. Full
  field data: `docs/troubleshooting/wb-field-report/README.md`.
