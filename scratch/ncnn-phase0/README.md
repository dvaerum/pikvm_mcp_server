# Phase 0 ncnn conversion artifacts (task_6ee9fd2bf5ec)

Preserved output from the crop-heatmap.onnx → ncnn feasibility spike
(2026-08-27, GO verdict — see the task/PR history for the full writeup).
Lives on this branch, not merged to main, since these are unproven
experimental-GPU-path artifacts, not shipped product code.

## What's here

- `crop_heatmap.ncnn.param` / `crop_heatmap.ncnn.bin` — the actual
  converted model, ready to load with ncnn's `Net.load_param`/`load_model`.
  This is what a real-hardware (Vulkan) benchmark needs.
- `crop_heatmap.pnnx.{param,bin,onnx}` — the intermediate pnnx-format
  representation (kept in case re-conversion or a different pnnx export
  option is ever needed; not required for inference).
- `crop_heatmap_ncnn.py` / `crop_heatmap_pnnx.py` — pnnx-generated
  reference Python inference wrappers for each format (not used by the
  comparison scripts below, which drive `ncnn.Net`/`onnxruntime` directly).
- `compare.py` — single real-frame fidelity check (onnxruntime CPU vs
  ncnn CPU), quick sanity check.
- `compare_batch.py` — broader sweep (27 real frames × 5 crop positions
  = 135 cases, mostly background/no-cursor content).
- `compare_gt.py` — the strongest evidence: 12 crops centered on real
  ground-truth cursor positions (`data/openloopshape-real/analysis.json`),
  0/12 argmax mismatches, 0/12 presence-decision mismatches between
  onnxruntime and ncnn. NOTE: `analysis.json` isn't tracked in this repo
  (was a transient local artifact of the original spike) — the same
  ground-truth `gt_x`/`gt_y` fields live directly in the tracked
  `data/openloopshape-real/manifest.jsonl`; `vulkan_cpu_bench.cpp` below
  reads from there instead, same 12 crops, same crop/normalize logic.
- `vulkan_cpu_bench.cpp` / `build_vulkan_cpu_bench.sh` — Phase 2's
  CPU-vs-Vulkan timing harness (task_bac3fefed239 / task_c5b91f0dce14).
  Native C++ against ncnn's real `Net`/`Extractor`/`gpu.h` API (verified
  against the actual installed headers, not memory), reads the same 12
  ground-truth crops from `manifest.jsonl`, runs N=50 timed inferences per
  crop under `use_vulkan_compute=false` then `=true`, reports median/min/max
  plus a last-crop argmax+presence spot-check. CPU-path output
  cross-verified byte-for-byte-equivalent argmax against `compare_gt.py`'s
  onnxruntime/ncnn comparison on the same crop (frame-lower-right-02.jpg):
  both report `argmax=299`, `sigmoid(presence)≈1.0000`. Gracefully skips
  the Vulkan half with a clear message if `ncnn::get_gpu_count() == 0`
  (e.g. this CPU-only dev host) rather than crashing or silently no-op'ing
  — the real Vulkan numbers come from running this on pikvm01 (V3DV
  confirmed live there) or another Vulkan-capable host.

All scripts/the harness resolve paths relative to their own location + the
repo root (or take the paths as CLI args, for the harness), so they work
from any checkout — no hardcoded absolute paths.

## Reproducing / regenerating

Conversion (only needed if re-deriving from `ml/crop-heatmap.onnx` — the
`.ncnn.*`/`.pnnx.*` files here are already the output):
```
pip install pnnx==20260526 onnx onnxruntime numpy Pillow ncnn==1.0.20260526
pnnx ml/crop-heatmap.onnx inputshape=[1,3,96,96]f32
```

Running the comparisons:
```
python3 scratch/ncnn-phase0/compare_gt.py
```

### NixOS: expect a dynamic-linking detour

`pip install`ed wheels for `torch` (a `pnnx` dependency), `numpy`, and
`ncnn` are generic-glibc manylinux builds — they expect `libstdc++.so.6`,
`libz.so.1` etc. on the standard FHS paths NixOS doesn't provide. Fix by
setting `LD_LIBRARY_PATH` to a **64-bit** `zlib` + `stdenv.cc.cc.lib` +
`libGL` (needed by torch's CUDA/graphics probing even for CPU-only use)
— e.g. via `nix-build '<nixpkgs>' -A <pkg> --no-out-link` to resolve exact
store paths, then export. Watch out: some `gcc-*-lib` store paths on a
multilib system resolve to the **32-bit** `libstdc++` — verify with
`file` before trusting one (`ELF 64-bit ... x86-64`, not `ELF 32-bit ...
Intel i386`).

Also see [`docs/learnings/ncnn-mat-buffer-constructor.md`](../../docs/learnings/ncnn-mat-buffer-constructor.md)
for a real ncnn Python-binding footgun hit while writing these scripts
(silently-uninitialized data from the `Mat(numpy_array)` constructor).

## Model I/O contract (for anyone building a native/Vulkan harness)

- Input: name `crop`/`in0`, float32, NCHW `[N, 3, 96, 96]`, ImageNet
  normalization (`mean=[0.485,0.456,0.406]`, `std=[0.229,0.224,0.225]`,
  applied to `pixel/255`).
- Outputs: `heatmap_logits`/`out0` (`[N,1,24,24]`), `presence_logit`/`out1`
  (`[N]`). Presence gate: `sigmoid(presence_logit) >= 0.5`
  (`VERIFY_THRESH`, matches `cursor-ml-detect.ts`'s default). Heatmap
  prediction: argmax over the 24×24 grid, scaled back to the 96×96 crop
  (`scale = 96/24 = 4`, `predicted = argmax_coord * scale + scale/2`).
