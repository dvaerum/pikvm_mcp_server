# Running the PiKVM MCP server as a persistent HTTP service

## The problem this solves

macOS **Local Network privacy** (Tahoe / macOS 26) gates LAN access **per binary
identity**. Apple-signed binaries (`ping`, `/usr/bin/curl`) are exempt; a
nix-built `node`/`curl` with no app-bundle identity is **silently denied** — any
`connect()` to the PiKVM's LAN IP (`10.109.x`) fails instantly with
`errno 65 No route to host`.

Because Claude Code spawns the MCP server as a **stdio child** (under tmux, which
reparents to `launchd`), the server inherits that blocked context and every
PiKVM call returns "fetch failed". This was verified this session:

| Caller | LAN reach |
|---|---|
| `/usr/bin/curl` (Apple, signed) | ✅ HTTP 401 |
| `ping`, `nc` (Apple) | ✅ |
| nix `curl`/`python`/`node` under tmux | ❌ instant errno 65 |
| nix binary under a bare `launchd` agent | ❌ instant errno 65 |
| **loopback `127.0.0.1` between two nix binaries** | ✅ **not gated** |

## The fix

Run the MCP server **once** as a long-lived process, anchored to an identity
that holds the Local Network grant, and have Claude connect to it over
**loopback HTTP** (never gated). The server's own PiKVM calls go out under the
granted identity; Claude's calls come in over `127.0.0.1`.

```
Claude Code ──http://127.0.0.1:8390/mcp──▶ pikvm-mcp-server ──LAN──▶ PiKVM
   (loopback: always allowed)              (needs the LAN grant once)
```

## Transport modes (built into the server)

The server chooses its transport from env/argv (default stays **stdio** for
backward compatibility):

| Setting | Effect |
|---|---|
| _(none)_ | stdio (legacy — spawned per session, blocked on this Mac) |
| `--http` or `MCP_TRANSPORT=http` | Streamable HTTP |
| `MCP_HTTP_HOST` | bind host (default `127.0.0.1` — **keep it loopback**) |
| `MCP_HTTP_PORT` | bind port (default `8390`) |
| `MCP_HTTP_SOCKET` | optional unix-socket path, served **in addition** to TCP |

Endpoints: `POST/GET/DELETE /mcp` (MCP), `GET /health` (liveness).

## Recommended: loopback proxy (no HTTP transport, no Claude restart dance)

Instead of moving the whole MCP server into a granted context, run a tiny
**CONNECT proxy** in a granted Terminal.app window and have the server route its
PiKVM calls through it. The server stays a normal stdio child of Claude; only
its outbound PiKVM HTTPS traffic goes via `127.0.0.1:8888`.

```
Claude ─stdio─▶ pikvm-mcp (under tmux) ─http://127.0.0.1:8888─▶ tinyproxy ─LAN─▶ PiKVM
                (blocked from LAN directly)  (loopback: allowed)  (granted Terminal)
```

**1. Start the proxy in a plain Terminal.app window (NOT tmux):**
```sh
nix run nixpkgs#tinyproxy -- -d -c ~/pikvm_mcp_server/docs/service/tinyproxy.conf
```
`-d` keeps it in the foreground so it stays attached to the granted window.
The config binds loopback only and sets **no `ConnectPort`**, so it tunnels to
any port. On its first PiKVM call macOS prompts
**"Terminal wants to find devices on your local network" → Allow**.

**2. The server is already wired for it.** `.mcp.json` runs
`scripts/pikvm-mcp-stdio.sh` (freshly-built local `dist`, which has proxy
support) with `PIKVM_PROXY=http://127.0.0.1:8888`. Restart Claude Code once so
it picks up the new `.mcp.json`, then `pikvm_health_check` should succeed.

The server reads `PIKVM_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`; leaving them unset
restores a direct connection.

---

## Anchoring the LAN grant — pick one (HTTP-transport alternative)

### Option A — Terminal-anchored (quick, no code-signing)

1. Open a **plain Terminal.app window** — **not** tmux.
2. Start the service:
   ```sh
   ~/pikvm_mcp_server/scripts/pikvm-mcp-serve.sh
   ```
3. On its first PiKVM call, macOS prompts **"Terminal wants to find devices on
   your local network"** → **Allow**. (If no prompt appears, open
   System Settings → Privacy & Security → **Local Network** and enable
   **Terminal**.)
4. Confirm: `curl -s http://127.0.0.1:8390/health` → `{"ok":true,...}` and the
   server log shows a successful HID read (no "fetch failed").

Trade-off: the service lives only as long as that Terminal window/session.

### Option B — Login-Item .app bundle (durable, survives reboot)

A bare `launchd` LaunchAgent does **not** work — it has no app identity to hold
the grant and gets silently denied (verified). A minimal **.app bundle** does
get a Local Network TCC identity. Scaffold under `docs/service/PikvmMcp.app/`
(see `install-app.sh`), grant it once, add to **System Settings → General →
Login Items**. This survives reboots and needs no open terminal.

Trade-off: one-time "Allow" click; the .app wraps the same launcher script.

### Option C — LaunchAgent (only if the grant already exists)

`dk.vcamp.pikvm-mcp.plist` is provided for completeness. It will start the
server on login, but its LAN calls stay blocked until the underlying identity is
granted by Option A/B. Use it only after the grant is established.

## Point Claude Code at the HTTP server

`.mcp.json`:
```json
{
  "mcpServers": {
    "pikvm": { "type": "http", "url": "http://127.0.0.1:8390/mcp" }
  }
}
```
Then restart Claude Code. Verify with `pikvm_health_check` — it should read the
streamer/HID state instead of "fetch failed".

The previous stdio config is preserved in `.mcp.json.stdio.bak`.
