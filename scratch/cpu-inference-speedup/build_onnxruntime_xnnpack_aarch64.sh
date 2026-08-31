#!/usr/bin/env bash
# aarch64-linux attempt of the XNNPACK-enabled onnxruntime build
# (task_476e2fd57bc2 / docs/xnnpack-rust-execution-provider-design.md §5,
# routed by manager msg_ce10b814d09fb15a).
#
# Adapted from pikvm_mcp_server's scratch/cpu-inference-speedup-artifacts
# overlay (x86_64-linux, proven working) by swapping legacyPackages.x86_64-linux
# -> legacyPackages.aarch64-linux. Built natively via this Mac's nix-darwin
# aarch64-linux linux-builder (real ARM VM, not cross-compiled) — dispatched
# automatically by the nix-daemon per /etc/nix/machines, no direct SSH needed.
# Real, --cores-1-only build history behind this exact set of flags:
# see docs/xnnpack-rust-execution-provider-design.md §7.1 in this repo
# (rust-port/module-4-mover / feat/xnnpack-execution-provider) for the
# full 4-attempt OOM chain (compile → compile → link → python-bindings-
# link) that led here — --cores 1 alone wasn't enough; the overlay
# itself needs the GCC GC-tuning flags + mold linker + pythonSupport=false.
set -euo pipefail
cd "$(dirname "$0")"

PIKVM_NIXOS_REPO="${PIKVM_NIXOS_REPO:-$(dirname "$0")/../../pikvm-nixos}"
if [ ! -f "$PIKVM_NIXOS_REPO/flake.nix" ]; then
  echo "error: PIKVM_NIXOS_REPO ($PIKVM_NIXOS_REPO) has no flake.nix — set PIKVM_NIXOS_REPO to a real pikvm-nixos checkout" >&2
  exit 1
fi

echo "== building XNNPACK-enabled onnxruntime for aarch64-linux (C++ lib) =="
echo "   real, non-cached rebuild, dispatched to the aarch64-linux linux-builder VM"
nix build --no-link --print-out-paths \
  --option min-free 0 --option max-free 0 \
  --cores 1 \
  --impure --expr \
  "(import ./onnxruntime-xnnpack-overlay-aarch64.nix { repo = $PIKVM_NIXOS_REPO; }).onnxruntime-xnnpack" \
  | tee /tmp/onnxruntime-xnnpack-aarch64-out-path.txt

echo "== built: $(cat /tmp/onnxruntime-xnnpack-aarch64-out-path.txt) =="
