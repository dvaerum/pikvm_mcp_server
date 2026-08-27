#!/usr/bin/env bash
# Reproducible build for vulkan_cpu_bench.cpp — resolves ncnn/stb/nlohmann_json
# via nix (no manual dependency install), then compiles with g++.
#
# PIKVM_NIXOS_REPO must point at a local pikvm-nixos checkout (any commit —
# only used to pin nixpkgs, not to build anything from that repo itself).
# Defaults to ../../pikvm-nixos relative to this script; override if yours
# lives elsewhere (e.g. `PIKVM_NIXOS_REPO=/path/to/pikvm-nixos ./build...sh`).
#
# On pikvm01/it-03400 (aarch64-linux target) — run this ON the target itself
# (same idiom as every other real-hardware verification in this project) so
# the fetched store paths + compiled binary are the right architecture; no
# script changes needed, `legacyPackages.x86_64-linux` below only matters
# for MY dev-host CPU-verify run, swap to `aarch64-linux` if cross-building
# instead of running natively on-device. Needs a C++ toolchain on PATH.
set -euo pipefail
cd "$(dirname "$0")"

PIKVM_NIXOS_REPO="${PIKVM_NIXOS_REPO:-$(dirname "$0")/../../pikvm-nixos}"
if [ ! -f "$PIKVM_NIXOS_REPO/flake.nix" ]; then
  echo "error: PIKVM_NIXOS_REPO ($PIKVM_NIXOS_REPO) has no flake.nix — set PIKVM_NIXOS_REPO to a real pikvm-nixos checkout" >&2
  exit 1
fi

echo "== resolving ncnn/stb/nlohmann_json via nix (using $PIKVM_NIXOS_REPO's nixpkgs pin) =="
NCNN=$(nix build --no-link --print-out-paths --impure --expr \
  "(builtins.getFlake (toString $PIKVM_NIXOS_REPO)).inputs.nixpkgs.legacyPackages.x86_64-linux.ncnn")
STB=$(nix build --no-link --print-out-paths --impure --expr \
  "(builtins.getFlake (toString $PIKVM_NIXOS_REPO)).inputs.nixpkgs.legacyPackages.x86_64-linux.stb")
JSON=$(nix build --no-link --print-out-paths --impure --expr \
  "(builtins.getFlake (toString $PIKVM_NIXOS_REPO)).inputs.nixpkgs.legacyPackages.x86_64-linux.nlohmann_json")

echo "NCNN=$NCNN"
echo "STB=$STB"
echo "JSON=$JSON"

echo "== compiling =="
g++ -std=c++17 -O2 \
  -I"$NCNN/include/ncnn" -I"$NCNN/include" \
  -I"$STB/include" -I"$JSON/include" \
  vulkan_cpu_bench.cpp \
  -L"$NCNN/lib" -lncnn -Wl,-rpath,"$NCNN/lib" \
  -o vulkan_cpu_bench

echo "== built: $(pwd)/vulkan_cpu_bench =="
echo "Run: ./vulkan_cpu_bench crop_heatmap.ncnn.param crop_heatmap.ncnn.bin <path-to-data/openloopshape-real>"
