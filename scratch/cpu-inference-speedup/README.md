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

## 2. XNNPACK execution provider — CLOSED, NO-GO (aarch64 build solved, but real onnxruntime batching bug blocks production use)

The standard `pip install onnxruntime` wheel does NOT include the
XNNPACK EP (`ort.get_available_providers()` only returns
`['AzureExecutionProvider', 'CPUExecutionProvider']` on 1.29.0). XNNPACK
support requires a custom ONNX Runtime build (`onnxruntime_USE_XNNPACK`).
nixpkgs' `onnxruntime` derivation had zero packaging for it —
`onnxruntime-xnnpack-overlay.nix` (this dir) fixes that via
`overrideAttrs` on `pkgs.onnxruntime`, pinning 4 new sources
(XNNPACK itself — declared upstream as `googlexnnpack`, not `xnnpack` —
plus pthreadpool, fxdiv, and kleidiai, Arm's NEON/SVE kernel lib, which
onnxruntime's own cmake pulls in unconditionally for any arm64 target;
FP16 is reused from nixpkgs' existing coreml wiring) to the exact
revisions onnxruntime v1.24.4's own `cmake/deps.txt` and
`cmake/external/xnnpack.cmake` reference. `doCheck`/
`onnxruntime_BUILD_UNIT_TESTS` and `onnxruntime_ENABLE_LTO` are off (we
only need the library + wheel, not onnxruntime's own test suite or
LTO's runtime win, and both are real memory/time costs on a
shared/oversubscribed build host); a narrow `-Wno-error=maybe-uninitialized`
carve-out (same mechanism nixpkgs' package already uses for
`unused-variable`) works around a GCC false positive that only
surfaces with LTO off, in onnxruntime's own `tensorprotoutils.cc`, not
a bug in this override. Build via `build_onnxruntime_xnnpack.sh`
(`PIKVM_NIXOS_REPO=<pikvm-nixos checkout> ./build_onnxruntime_xnnpack.sh`)
— real, non-cached rebuild, ~real wall-clock time, not free like the
ncnn+Vulkan Phase 0 build.

**Verified working, not just "exit 0"**: installed the built wheel into
a clean venv (same `LD_LIBRARY_PATH`-to-zlib+`stdenv.cc.cc.lib` detour
documented below — a bare pip venv on NixOS needs it same as before),
confirmed `ort.get_available_providers()` genuinely includes
`XnnpackExecutionProvider`, then constructed a REAL
`InferenceSession(providers=['XnnpackExecutionProvider',
'CPUExecutionProvider'])` against the actual `ml/crop-heatmap.onnx` and
ran a real inference — `sess.get_providers()` confirms XNNPACK is
actually active (not silently falling back to CPU), output shapes match
the known model contract ([1,1,24,24] + [1]). This is on x86_64 only
(dev-host smoke test, not a performance measurement) — the real
fp32-vs-XNNPACK comparative BENCHMARK still needs a matching aarch64
build + real Pi4 run, same pattern as every other candidate in this
doc. Worth noting before that benchmark runs: given task_484bed055820's
search-narrowing fix (shrinks the real production crop count well
below this doc's N=352 baseline), the more representative benchmark
shape may now be the NEW crop count rather than N=352 — check with the
task owner before interpreting the eventual number.

The build now exists — the SAME correctness harness here (`compare_int8.py`'s
methodology, swapped to compare XNNPACK EP vs default CPU EP instead of
INT8 vs fp32) directly reuses for whoever runs the real Pi4 benchmark.

**2026-08-31 follow-up (task_476e2fd57bc2, executed by
pikvm-nixos@georgs-mac-mini) — CLOSED, NO-GO.** Picked this up for the
Rust port (`ort` crate, not the Python wheel). Full writeup:
`docs/xnnpack-rust-execution-provider-design.md` §7 on branches
`rust-port/module-4-mover` / `feat/xnnpack-execution-provider` (that
repo's own history, not this one — cross-referenced here since this is
where the reusable build artifact lives).

- **aarch64 build: SOLVED.** `onnxruntime-xnnpack-overlay-aarch64.nix`
  + `build_onnxruntime_xnnpack_aarch64.sh` (this dir) — same overlay as
  above, targeting `legacyPackages.aarch64-linux`, plus 3 more fixes
  needed for a real (small, ~2.9GB RAM/1 CPU/0 swap) aarch64-linux
  builder VM: GCC GC-tuning flags (`--param ggc-min-expand=10
  --param ggc-min-heapsize=32768`) to fix a compile-time OOM, `mold` as
  the linker to fix the subsequent link-time OOM, and
  `pythonSupport = false` to skip the Python-bindings link entirely
  (not needed for the Rust port). Verified genuinely XNNPACK-enabled
  via `strings`/demangled-symbol inspection, not just build exit code.
- **Real Pi4 correctness check: XNNPACK is numerically correct for
  N=1 (single crop) but PANICS for N>1 (batched)** — `presence_logit`'s
  output tensor comes back length 1 instead of the batch size, a real
  onnxruntime-XNNPACK incompatibility with this model's batched
  execution, not a harness bug (identical code path, CPU EP handles
  the same batch correctly).
- **N=1 timing (2026-08-31, explicit decision-input ask): XNNPACK is
  ~2.4x SLOWER than CPU-EP even where it works.** Real pikvm01 numbers,
  warmup(5)+30-iteration median: CPU-EP 31.98ms vs XNNPACK-EP 76.98ms.
  Same pattern as candidates 1 and the earlier GPU/Vulkan investigation
  — an acceleration path that loses to plain CPU on this hardware for
  a model this small, likely dispatch/thread-pool overhead dominating.
  **Firm NO-GO**, not "needs more investigation" — production always
  batches (N=352 pre-hint-narrowing, smaller-but-still->1 after), so
  the real Pi4 timing benchmark this entry originally flagged as
  "still needed" was deliberately never run against the production
  shape: it can't run at all (the panic above), and the N=1 number
  already answers the only question a batched number could have
  added ("is XNNPACK faster") in the negative anyway.

## 3. ArmNN execution provider — CLOSED, NOT PURSUED

pikvm-nixos@nixos-developer-system's packaging investigation found ArmNN
EP needs prebuilt ARM Compute Library (ACL) + ArmNN shared libs supplied
externally, not FetchContent-vendored like XNNPACK — neither exists
anywhere in nixpkgs, and ACL is a large SCons-based (not CMake) tree
with hand-written NEON/SVE kernels. Packaging it from scratch would be a
much bigger lift than XNNPACK, for what was already the lower-priority
stretch goal. Recommendation (accepted): skip entirely, XNNPACK is the
only candidate with a real path forward.

## 4. Full-request-path profiling + thread-config check (task_78184455df4e, 2026-08-27)

Follow-up to candidate 1's XNNPACK-hold decision: georg wants to know
whether there's real non-native (JS-side) overhead in the actual
request pipeline worth targeting before considering anything as big as
a native rewrite, and whether ONNX Runtime is actually using all 4 of
the Pi4's cores.

**Important correction to the mental model going into this:** all
prior timing numbers in this doc (the `bench_node.mjs` fp32/int8
comparison, "71ms/inference") measured a SINGLE 96×96 crop (`N=1`) —
useful for a controlled apples-to-apples fp32-vs-int8 comparison, but
NOT representative of what the production code path actually does.
`runCascade()` (`src/pikvm/cursor-ml-detect.ts`, the canonical detector
behind `findCursorByV8FullFrame`) builds a grid of crops covering the
whole detected iPad region (default `GRID_STRIDE=48`px, 50% overlap
with the 96px crop) and batches ALL of them into a SINGLE
`session.run()` call. `grid-size-check.mts` confirms this against real
captured frames: on a real 1920×1080 frame, **N=352 crops per
inference call**, not N=1. The "71ms" number is real and useful as a
quantization/backend comparison baseline, but understates the real
per-request inference cost by roughly two orders of magnitude of work
(N=352 vs N=1), and — more importantly — makes any thread-count
comparison drawn from N=1 timing unsafe to generalize from (see below).

`full-path-profile.mts` reproduces `runCascade()`'s real phases —
region-detect, JPEG decode, grid-build + preprocess (the JS loop that
fills the `Float32Array` batch tensor), the batched inference call,
and heatmap/presence postprocessing — each individually timed, with a
sweep over `intraOpNumThreads` (unset/default, 1, 2, 4).

**x86_64 dev-host result (16 cores, NOT predictive of absolute Pi4
timing, but the *shape* is the finding — real Pi4 numbers still
needed):**

| intraOpNumThreads | inference (median) | TOTAL (median) | inference share |
|---|---|---|---|
| 1 | 1729-1857ms | 1787-1857ms | 96-97% |
| 2 | 642-1013ms | 705-1077ms | 91-94% |
| 4 | 433-458ms | 514-554ms | 82-84% |
| unset (default) | 229-424ms | 353-424ms | 65% |

Two things this shows clearly, independent of the absolute numbers:

1. **Threading matters a lot for the real batched (N=352) workload** —
   roughly linear scaling from 1→4 threads (~4x), unlike the N=1 case
   this task's predecessor investigated (single-crop inference is
   dominated by fixed per-call dispatch overhead, which is why GPU and
   INT8 both came back NO-GO there). Batch-of-352 is large enough that
   per-call overhead is amortized and real parallel compute matters —
   a fundamentally different regime from the N=1 comparisons the GPU
   and INT8 investigations ran. This does NOT contradict those NO-GOs
   (they measured something real and different); it means the
   "backend dispatch overhead dominates" conclusion from that
   investigation doesn't automatically transfer to the thread-count
   question for the real workload.
2. **`gridBuildPreprocess` (pure JS, no native call) is genuinely
   non-trivial** — 43-92ms depending on run, i.e. the same order of
   magnitude as an entire single-crop inference call from the earlier
   investigation. This is real, nameable, non-native overhead: a
   double-nested loop over 352×96×96×3 ≈ 9.7M float writes with
   per-element normalization math, done in JS on every request. On a
   weaker ARM core (vs. this 16-core x86_64 devbox) this fraction
   could matter proportionally more, not less — needs a real Pi4
   number to know for sure.

**What's still open, and needs it-03400 (real Pi4, only place that can
answer it):**
- Whether `intraOpNumThreads` left unset actually resolves to 4
  (all cores) on the Pi4's Cortex-A72, or silently under-utilizes
  (e.g. resolves to 1) — the x86_64 "default is fastest" result here
  is consistent with default correctly using more cores than any
  explicit setting tested, but does NOT prove what default resolves to
  on a 4-core ARM target specifically. If default is NOT already using
  all 4 cores there, forcing `intraOpNumThreads: 4` explicitly could be
  a genuine free win — no retrain, no rewrite, one line.
- Real ARM absolute numbers for each phase, especially
  `gridBuildPreprocess`'s share of total wall-clock — to answer
  georg's actual question (is there real JS-side cost worth a scoped
  native-module fix, or does inference genuinely dominate end to end).

Run via (repo root, same real-package-binaries pattern as `bench_node.mjs`):
```
npx tsx scratch/cpu-inference-speedup/grid-size-check.mts
npx tsx scratch/cpu-inference-speedup/full-path-profile.mts [path/to/frame.jpg]
```

## Model I/O contract

Same as `scratch/ncnn-phase0/README.md`'s (this is the same model,
`ml/crop-heatmap.onnx`): input `crop`, float32 NCHW `[N,3,96,96]`,
ImageNet-normalized; outputs `heatmap_logits` `[N,1,24,24]` and
`presence_logit` `[N]`, gate `sigmoid(presence_logit) >= 0.5`.
