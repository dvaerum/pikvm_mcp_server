# CPU-side inference speedup investigation (task_1f066737902c)

Follow-up to the GPU-acceleration feasibility spike (definitive NO-GO,
see `scratch/ncnn-phase0-conversion-artifacts` — Vulkan is 4.8-6.3x
SLOWER than CPU on two real Pi4/V3D boards for this model). Not merged
to main — experimental investigation artifacts, not shipped code.

Three candidates from the task, in the order tackled:

## 1. INT8 dynamic quantization — CLOSED, NO-GO (real hardware confirms it's SLOWER)

`crop-heatmap.int8.onnx` — dynamic post-training INT8 quantization of
`ml/crop-heatmap.onnx`, produced via `onnxruntime.quantization`'s
recommended two-step process (`python -m onnxruntime.quantization.preprocess`
then `quantize_dynamic(weight_type=QuantType.QUInt8)`). 3.20x smaller
(199731 → 62404 bytes).

**Correctness** (same methodology as the ncnn Phase 0 fidelity check —
real captured frames, not synthetic):
- `compare_int8.py`: 12 crops centered on real ground-truth cursor
  positions (`data/openloopshape-real/manifest.jsonl`). 0/12 argmax
  mismatches, 0/12 presence-decision mismatches. Heatmap logit diff
  noticeably larger than the ncnn comparison's pure backend-noise
  (~0.32-0.42 here vs ~0.005-0.008 there) — expected, since INT8
  introduces real quantization error, not just kernel-implementation
  variance — but not large enough to flip any decision on this set.
- `compare_int8_batch.py`: broader 135-case sweep (27 real frames × 5
  crop positions, mostly background/no-cursor content). 0/135
  presence-decision mismatches. ONE confident-case argmax mismatch
  found — diagnosed in `diagnose_mismatch.py`: fp32's top-2 heatmap
  peaks were a near-tie (logit 2.7159 vs 2.7136, i.e. essentially
  equal), and INT8's tiny additional noise flipped which of the two
  adjacent cells won — a 4.00px positional difference on a 96px crop,
  well within the ordinary noise floor already documented elsewhere in
  this project for cursor-detection residuals. Not a real accuracy
  regression; a coin-flip on an already-ambiguous case.

**Speed — REAL HARDWARE RESULT (it-03400, 2026-08-27, via `bench_node.mjs`
run through the real deployed pikvm-mcp-server-0.5.250 package's own ARM
`onnxruntime-node` + `sharp` binaries, node 24.18.0 — the exact production
runtime, not a separately-built environment): INT8 is ~25% SLOWER than
fp32 (median 88.8-91.9ms vs 71.0-72.7ms/inference across 600 inferences,
reproduced across 2 independent runs, correctness matched both times).
Same direction as the x86_64 dev-host result below, though the x86_64
number alone was explicitly NOT trusted as predictive — this is the
number that actually counts, and it's a clean NO-GO: plain ONNX Runtime
CPU EP INT8 kernels don't pay off for this model/op-mix on this ARM
core, quantize/dequantize overhead exceeds the arithmetic savings.

(Original x86_64 dev-host number, kept for the record: INT8 measurably
SLOWER than fp32 there too — 2.12ms vs 1.17ms/inference — for the same
general reason, small-model graph overhead outweighing savings. Was
flagged at the time as non-predictive of ARM specifically since ARM's
SDOT/UDOT + weaker baseline NEON fp32 throughput could in principle have
told a different story — it didn't, but the caution was correct to
apply before the real number existed.)

**Consequence for XNNPACK (candidate 2)**: the bar just got higher.
XNNPACK now needs to beat fp32's ~71ms baseline directly, not int8's
~89ms — there's no "at least beat int8" fallback anymore.

## 2. XNNPACK execution provider — not yet buildable from this dev host

The standard `pip install onnxruntime` wheel does NOT include the
XNNPACK EP (`ort.get_available_providers()` only returns
`['AzureExecutionProvider', 'CPUExecutionProvider']` on 1.29.0). XNNPACK
support requires either a custom ONNX Runtime build (`--use_xnnpack`) or
a specialized distribution (e.g. onnxruntime-mobile) not verified
available for this platform. Since XNNPACK's whole value proposition is
ARM NEON optimization, a meaningful validation belongs on the real
target architecture anyway — routed to pikvm-nixos@nixos-developer-system
to check whether nixpkgs' `onnxruntime` derivation has (or can gain) an
XNNPACK-enabled build option for the aarch64 target. Once a build
exists, the SAME correctness harness here (`compare_int8.py`'s
methodology, swapped to compare XNNPACK EP vs default CPU EP instead of
INT8 vs fp32) directly reuses.

## 3. ArmNN execution provider — CLOSED, NOT PURSUED

pikvm-nixos@nixos-developer-system's packaging investigation found ArmNN
EP needs prebuilt ARM Compute Library (ACL) + ArmNN shared libs supplied
externally, not FetchContent-vendored like XNNPACK — neither exists
anywhere in nixpkgs, and ACL is a large SCons-based (not CMake) tree
with hand-written NEON/SVE kernels. Packaging it from scratch would be a
much bigger lift than XNNPACK, for what was already the lower-priority
stretch goal. Recommendation (accepted): skip entirely, XNNPACK is the
only candidate with a real path forward.

## Model I/O contract

Same as `scratch/ncnn-phase0/README.md`'s (this is the same model,
`ml/crop-heatmap.onnx`): input `crop`, float32 NCHW `[N,3,96,96]`,
ImageNet-normalized; outputs `heatmap_logits` `[N,1,24,24]` and
`presence_logit` `[N]`, gate `sigmoid(presence_logit) >= 0.5`.
