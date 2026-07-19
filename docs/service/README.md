# Reaching the PiKVM through a loopback proxy (macOS Local Network privacy)

## The problem

macOS (Tahoe / macOS 26) **Local Network privacy** gates LAN access **per binary
identity**. Apple-signed binaries (`ping`, `/usr/bin/curl`) are exempt; a
nix-built `node`/`curl` with no app-bundle identity is **silently denied** — any
`connect()` to the PiKVM's LAN IP (`10.109.x`) fails instantly with
`errno 65 No route to host`.

Because Claude Code spawns the MCP server as a stdio child under tmux (a
`Background` launchd session, not the GUI Aqua session), the server inherits that
blocked context and every PiKVM call returns "fetch failed". Loopback
(`127.0.0.1`) is **not** gated.

## The fix — route through a loopback CONNECT proxy

Run a tiny CONNECT proxy in a **granted** Terminal.app window and point the
server at it. The MCP→proxy hop is loopback (always allowed); the proxy→PiKVM
hop runs under Terminal's Local Network grant.

```
Claude ─stdio─▶ pikvm-mcp (under tmux) ─http://127.0.0.1:8888─▶ tinyproxy ─LAN─▶ PiKVM
                (blocked from LAN directly)  (loopback: allowed)  (granted Terminal)
```

**1. Start the proxy in a plain Terminal.app window (NOT tmux):**
```sh
nix run nixpkgs#tinyproxy -- -d -c ~/pikvm_mcp_server/docs/service/tinyproxy.conf
```
`-d` keeps it foreground so it stays attached to the granted window. The config
binds `127.0.0.1` only and sets **no `ConnectPort`**, so it tunnels to any port.
On its first PiKVM call macOS prompts **"Terminal wants to find devices on your
local network" → Allow**.

**2. The server is already wired for it.** `.mcp.json` runs
`scripts/pikvm-mcp-stdio.sh` with `PIKVM_PROXY=http://127.0.0.1:8888`. The client
routes through the proxy via undici `ProxyAgent` (CONNECT-tunnelling HTTPS, the
self-signed cert accepted). Only the dedicated `PIKVM_PROXY` is honored —
ambient `HTTPS_PROXY`/`ALL_PROXY` are ignored so an unrelated internet proxy
can't reroute LAN device traffic. Unset it for a direct connection.

Verify with `pikvm_health_check` — it should read streamer/HID state instead of
"fetch failed".

## Recovering HID

If `pikvm_health_check` reports `mouse/keyboard online: false` and input has no
effect, run `pikvm_hid_reset` (`POST /api/hid/reset`). A soft reset can't force
the *host* to re-enumerate — a target that cold-booted from a dead battery may
need a physical USB-C re-plug, a target restart, or a full PiKVM reboot to
recreate the gadget (live-verified 2026-07-19).
