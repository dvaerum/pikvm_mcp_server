#!/usr/bin/env bash
#
# Stdio launcher for the PiKVM MCP server, routing outbound PiKVM requests
# through a loopback proxy.
#
# WHY: Claude Code spawns this as a stdio child (under tmux). On macOS, that
# context is blocked from the PiKVM's LAN IP by Local Network privacy. But
# loopback (127.0.0.1) is NOT gated — so we point the server at a proxy running
# on 127.0.0.1 (started in a granted Terminal.app window). The MCP→proxy hop is
# loopback; the proxy→PiKVM hop inherits Terminal's Local Network grant. See
# docs/service/README.md.
#
# This runs the freshly-built local dist (which HAS proxy support) rather than
# the home-manager nix binary (which may lag). Rebuild with `npm run build`
# after pulling changes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# --- PiKVM connection (mirror the home-manager wrapper) ----------------------
export PIKVM_HOST="${PIKVM_HOST:-https://pikvm01.bb.vcamp.dk}"
export PIKVM_USERNAME="${PIKVM_USERNAME:-admin}"
export PIKVM_VERIFY_SSL="${PIKVM_VERIFY_SSL:-false}"
export PIKVM_DEFAULT_KEYMAP="${PIKVM_DEFAULT_KEYMAP:-en-us}"

PW_FILE="${PIKVM_PASSWORD_FILE:-$HOME/.config/sops-nix/secrets/pikvm-password}"
if [[ -z "${PIKVM_PASSWORD:-}" && -r "$PW_FILE" ]]; then
  PIKVM_PASSWORD="$(cat "$PW_FILE")"
  export PIKVM_PASSWORD
fi

# --- Proxy -------------------------------------------------------------------
# Route all PiKVM HTTPS calls through the loopback CONNECT proxy. Override with
# PIKVM_PROXY in the environment / .mcp.json if the port differs.
export PIKVM_PROXY="${PIKVM_PROXY:-http://127.0.0.1:8888}"

exec "${NODE_BIN:-node}" dist/index.js
