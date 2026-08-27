# CPU-side inference speedup investigation (task_1f066737902c)

Follow-up to the GPU-acceleration feasibility spike (definitive NO-GO,
see `scratch/ncnn-phase0-conversion-artifacts` — Vulkan is 4.8-6.3x
SLOWER than CPU on two real Pi4/V3D boards for this model). Not merged
to main — experimental investigation artifacts, not shipped code.

Three candidates from the task, in the order tackled:

## 1. INT8 dynamic quantization — done, correctness validated, speed NOT yet measured on real hardware

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

**Speed — x86_64 dev-host numbers ARE NOT representative, included only
as a documented curiosity**: on this x86_64 host, INT8 was measurably
SLOWER than fp32 (2.12ms vs 1.17ms/inference) — the model is small
enough that added Cast/DynamicQuantizeLinear graph overhead outweighs
the arithmetic savings, and this CPU's `avx_vnni` support may not be
exercised effectively by ONNX Runtime's default x86 INT8 kernels for a
model this size. **This does NOT predict ARM behavior** — ARMv8.2+'s
SDOT/UDOT instructions accelerate INT8 GEMM specifically and ARM NEON's
baseline fp32 throughput is weaker than x86 AVX2's, so the relative
INT8 benefit could look completely different on a real Pi4. The real
answer needs an actual Pi4 timing run (same harness pattern as the ncnn
Phase 0 → Phase 2 split) — that's the one thing this investigation
could NOT self-contain on this dev host.

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

## 3. ArmNN execution provider — not started (lower priority per the task)

Same packaging-first blocker as XNNPACK — needs a build with ArmNN EP
support, which nixpkgs may or may not already provide. Deferred until
1/2 are further along, per the task's own stated priority order.

## Model I/O contract

Same as `scratch/ncnn-phase0/README.md`'s (this is the same model,
`ml/crop-heatmap.onnx`): input `crop`, float32 NCHW `[N,3,96,96]`,
ImageNet-normalized; outputs `heatmap_logits` `[N,1,24,24]` and
`presence_logit` `[N]`, gate `sigmoid(presence_logit) >= 0.5`.
