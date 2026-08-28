#!/usr/bin/env bash
# Builds the XNNPACK-enabled onnxruntime (task_1f066737902c candidate 2).
# Unlike the ncnn+Vulkan Phase 0 build, NOTHING here is cache-substituted —
# this is a full, real onnxruntime C++ rebuild (10s of minutes, real CPU
# cost) on the shared/oversubscribed host. Run this backgrounded, never in
# foreground, per this project's standing shared-host discipline.
#
# PIKVM_NIXOS_REPO must point at a local pikvm-nixos checkout (any commit —
# only used to pin nixpkgs, not to build anything from that repo itself).
set -euo pipefail
cd "$(dirname "$0")"

PIKVM_NIXOS_REPO="${PIKVM_NIXOS_REPO:-$(dirname "$0")/../../pikvm-nixos}"
if [ ! -f "$PIKVM_NIXOS_REPO/flake.nix" ]; then
  echo "error: PIKVM_NIXOS_REPO ($PIKVM_NIXOS_REPO) has no flake.nix — set PIKVM_NIXOS_REPO to a real pikvm-nixos checkout" >&2
  exit 1
fi

echo "== building XNNPACK-enabled onnxruntime (C++ lib + python wheel) =="
echo "   this is a REAL, non-cached rebuild — expect real wall-clock time"
echo "   --cores capped to reduce peak memory on this shared/oversubscribed host"
nix build --no-link --print-out-paths \
  --option min-free 0 --option max-free 0 \
  --cores 4 \
  --impure --expr \
  "(import ./onnxruntime-xnnpack-overlay.nix { repo = $PIKVM_NIXOS_REPO; }).onnxruntime-xnnpack.dist" \
  | tee /tmp/onnxruntime-xnnpack-out-path.txt

echo "== built: $(cat /tmp/onnxruntime-xnnpack-out-path.txt) =="
echo "That path contains a raw .whl — pip install it directly into whatever venv you already"
echo "use for compare_int8.py (e.g. \`pip install <out-path>/*.whl --force-reinstall\`) to get"
echo "an InferenceSession with XnnpackExecutionProvider available, same pattern as before but"
echo "swap providers=['CPUExecutionProvider'] for ['XnnpackExecutionProvider','CPUExecutionProvider']."
