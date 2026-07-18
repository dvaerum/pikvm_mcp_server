#!/usr/bin/env bash
#
# Launch the PiKVM MCP server in persistent Streamable-HTTP mode.
#
# WHY: macOS Local Network privacy (Tahoe / macOS 26) blocks LAN access for
# nix-built binaries that have no app-bundle identity — so when Claude Code
# spawns the server as a stdio child (under tmux, or a bare launchd agent),
# every connect() to the PiKVM's LAN IP fails with an instant "No route to
# host". Loopback (127.0.0.1) is NOT gated. This script runs the server ONCE as
# a long-lived process; Claude connects to it over loopback HTTP instead of
# spawning it. For the server's own LAN calls to succeed, run this from a
# context that holds the Local Network grant (a Terminal.app window that has
# been allowed, or an .app/Login-Item wrapper). See docs/service/README.md.
#
# Config via env (all optional except the PiKVM secrets, which are read below):
#   MCP_HTTP_HOST   bind host (default 127.0.0.1 — keep it loopback)
#   MCP_HTTP_PORT   bind port (default 8390)
#   MCP_HTTP_SOCKET optional unix socket path (served in addition to TCP)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# --- PiKVM connection (mirror the home-manager wrapper) ----------------------
export PIKVM_HOST="${PIKVM_HOST:-https://pikvm01.bb.vcamp.dk}"
export PIKVM_USERNAME="${PIKVM_USERNAME:-admin}"
export PIKVM_VERIFY_SSL="${PIKVM_VERIFY_SSL:-false}"
export PIKVM_DEFAULT_KEYMAP="${PIKVM_DEFAULT_KEYMAP:-en-us}"

# Read the password fresh on every start so rotations don't need a rebuild.
PW_FILE="${PIKVM_PASSWORD_FILE:-$HOME/.config/sops-nix/secrets/pikvm-password}"
if [[ -z "${PIKVM_PASSWORD:-}" && -r "$PW_FILE" ]]; then
  PIKVM_PASSWORD="$(cat "$PW_FILE")"
  export PIKVM_PASSWORD
fi

# --- Transport ---------------------------------------------------------------
export MCP_TRANSPORT=http
export MCP_HTTP_HOST="${MCP_HTTP_HOST:-127.0.0.1}"
export MCP_HTTP_PORT="${MCP_HTTP_PORT:-8390}"
# MCP_HTTP_SOCKET is passed through as-is if the caller set it.

# Prefer the built output; fall back to tsx for a from-source run.
NODE_BIN="${NODE_BIN:-node}"
if [[ -f dist/index.js ]]; then
  exec "$NODE_BIN" dist/index.js --http
else
  exec npx tsx src/index.ts --http
fi
