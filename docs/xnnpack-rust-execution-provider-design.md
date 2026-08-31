# XNNPACK execution provider in the Rust ONNX cascade — design (task_476e2fd57bc2)

georg's question: earlier this session, XNNPACK was confirmed
**unreachable from `onnxruntime-node`** (the Node.js napi binding —
hardcoded 7-provider dispatch, no `xnnpack` case, source-confirmed at the
pinned tag and upstream). The Rust port's `ort` crate talks to the same
underlying onnxruntime C++ library via `dlopen` (`load-dynamic` feature) —
architecturally a completely different path. Has XNNPACK ever actually
been attempted in Rust? **No — confirmed never done** (see §1). This doc
is the correctness-first design for actually attempting it.

## 0. Two related, previously-unanswered questions, checked directly against code/history first

**Q: has a Rust-binary-vs-Node-server speed comparison ever been done?**
Checked commit history + all docs across all 5 `rust-port-*` branches:
**confirmed never done.** The only real numbers on record are (a)
Node-only startup/memory baselines measured before any Rust code existed
(`docs/rust-port-plan.md` §2, on branch `docs/rust-port-plan-task721cb397235a`),
and (b) a Node-before/Node-after comparison for PR93's hint-narrowing
optimization (`docs/FUTURE-WORK.md`: move_to 1.83x, click_at 1.60x — both
sides are TypeScript, no Rust binary involved). The full-port decision
itself was explicitly preference/maintainability-driven, not
performance-driven (`docs/rust-port-plan.md` §4 TL;DR) — but that's a
separate question from XNNPACK, which is a real, checkable technical
opportunity regardless of why the port was started. Not pursuing further
here; flagging back to the manager as a "confirmed never done, not this
task's scope" fact, per georg's question 1.

**Q: has XNNPACK ever been attempted in Rust specifically?**
Confirmed never done. `git grep -i -E
'ExecutionProvider|xnnpack|CPUExecutionProvider|with_execution_providers'
-- rust/` across all 5 branches returns zero hits. The only ONNX
`Session` construction site in the whole port is
`rust/detection-vision/src/cursor_ml_detect.rs:242-243`:
```rust
ort::init().commit();
Ok(Session::builder()?.commit_from_file(model_path)?)
```
No execution-provider list is ever passed — this runs on `ort`'s default
CPU EP only. `rust/detection-vision/Cargo.toml` pins `ort = { version =
"2.0.0-rc.13", default-features = false, features = ["load-dynamic"] }`
— no `xnnpack` feature enabled. The only prior XNNPACK work in this repo
is the **Node/TS-side investigation** (`scratch/cpu-inference-speedup/`,
branch `scratch/cpu-inference-speedup-artifacts`, task_1f066737902c) and
a **planning-doc mention** (`docs/rust-port-plan.md` §5, on branch
`docs/rust-port-plan-task721cb397235a` — a "worth attempting the spike"
proposal, never acted on). Neither touches the Rust `ort` crate. This is
genuinely unexplored, matching georg's hunch.

## 1. Step 1 finding: nixpkgs' onnxruntime does NOT have XNNPACK compiled in — confirmed 3 independent ways

This is the real, first blocker, same class as the Node-side
investigation's finding — but on the C++ library nixpkgs builds, not the
Python wheel.

1. **onnxruntime's own CMake default is OFF.** `cmake/CMakeLists.txt` at
   the pinned tag (`v1.24.4`, matching nixpkgs' `onnxruntime.version`):
   `option(onnxruntime_USE_XNNPACK "..." OFF)`.
2. **nixpkgs never overrides it.** Full `cmakeFlags` dump of
   `nixpkgs#onnxruntime` (evaluated live) contains no
   `onnxruntime_USE_XNNPACK` entry at all, and `grep -i xnnpack
   pkgs/by-name/on/onnxruntime/package.nix` returns zero hits — the
   `fp16`/`psimd` FetchContent overrides present there are generic MLAS
   deps, not XNNPACK-specific wiring.
3. **The actual built `.so` has no XNNPACK implementation**, despite
   containing the string constant. Built and inspected
   `nixpkgs#onnxruntime` (1.24.4, cache-substituted, no rebuild needed):
   `nm -D` and full `nm` on `libonnxruntime.so.1.24.4` return **zero**
   XNNPACK-related symbols (no `XnnpackExecutionProvider` mangled class,
   no factory function) — contrast with `CPUExecutionProvider`, which has
   a full set of mangled symbols. The `strings` hits for
   `XnnpackExecutionProvider`/`XNNPACK` are part of a static list of
   *every* EP name onnxruntime knows about for validation/enumeration
   purposes (`WebNNExecutionProvider`, `CANNExecutionProvider`,
   `AzureExecutionProvider`, `SNPEExecutionProvider`, etc. — none of
   which are compiled in either) — not evidence of a working
   implementation.

**Conclusion: the nixpkgs onnxruntime this Rust port dlopens against
today cannot serve XNNPACK, full stop.** A custom onnxruntime build is
required, exactly as the task anticipated.

## 2. Reusable groundwork: the earlier XNNPACK onnxruntime overlay already exists and already works (x86_64)

`scratch/cpu-inference-speedup/onnxruntime-xnnpack-overlay.nix` +
`build_onnxruntime_xnnpack.sh` (branch
`scratch/cpu-inference-speedup-artifacts`, commit `efa22dc`) already
solved the "how do you even get an XNNPACK-enabled onnxruntime out of
nixpkgs" problem:

- `pkgs.onnxruntime.overrideAttrs` adding
  `onnxruntime_USE_XNNPACK=true` plus 4 pinned `FETCHCONTENT_SOURCE_DIR_*`
  overrides (XNNPACK itself — declared upstream as `googlexnnpack`,
  pthreadpool, fxdiv, kleidiai — Arm's NEON/SVE kernel lib, pulled in
  unconditionally by onnxruntime's own cmake for any arm64 target) and
  FP16 reused from nixpkgs' existing coreml wiring. All 4 new sources
  pinned to the exact revisions onnxruntime v1.24.4's own
  `cmake/deps.txt`/`cmake/external/xnnpack.cmake` reference.
- `doCheck`/`onnxruntime_BUILD_UNIT_TESTS`/`onnxruntime_ENABLE_LTO` off
  (build-cost + a real GCC false-positive workaround), documented inline
  with the actual OOM/build failures that led to each flag.
- **Verified working, not just "exit 0"**: installed wheel,
  `ort.get_available_providers()` genuinely includes
  `XnnpackExecutionProvider`, real `InferenceSession` against
  `ml/crop-heatmap.onnx`, `sess.get_providers()` confirms XNNPACK
  actually active (not silent CPU fallback), output shapes match the
  known model contract. **x86_64 only** — no aarch64/Pi4 build has ever
  been attempted (the README says so explicitly: "the real fp32-vs-XNNPACK
  comparative BENCHMARK still needs a matching aarch64 build + real Pi4
  run").

For the Rust port, the wheel repackaging is irrelevant — `ort`'s
`load-dynamic` feature just needs `ORT_DYLIB_PATH` pointed at a `.so`.
The overlay already exposes the right output directly:
`onnxruntime-xnnpack` (the C++ derivation itself, before the
`onnxruntime-xnnpack-python` wheel wrapping) — its
`$out/lib/libonnxruntime.so` is exactly what `flake.nix:116`'s
`export ORT_DYLIB_PATH="${pkgs.onnxruntime}/lib/libonnxruntime.so"` line
needs to instead point at, for a build/dev shell variant that wants
XNNPACK.

**What's new work, not reuse**: the overlay's `let pkgs = ...
legacyPackages.x86_64-linux` is hardcoded to x86_64 — nothing has ever
confirmed this cross-compiles (or natively builds) for `aarch64-linux`,
the actual PiKVM/Pi4 target. This is the single largest open unknown
this design can't resolve without a real build attempt (§5).

## 3. Rust-side integration is small — `ort` already has first-class XNNPACK support

Checked `ort` v2.0.0-rc.13 (the exact pinned version) upstream source
directly, not assumed:

- `Cargo.toml` already declares a real `xnnpack` feature:
  `xnnpack = [ "ort-sys/xnnpack" ]` — present in the crate's own
  `docs.rs` feature list alongside `cuda`, `coreml`, etc.
- `src/ep/xnnpack.rs` provides a real, already-implemented
  `ep::XNNPACK` builder:
  ```rust
  ep::XNNPACK::default()
      .with_intra_op_num_threads(NonZeroUsize::new(4).unwrap())
      .build()
  ```
  passed via `SessionBuilder::with_execution_providers([...])`.
- Its `register()` impl calls the **generic**
  `SessionOptionsAppendExecutionProvider` C API entry point (not a
  provider-specific symbol) — meaning no special static linking is
  required beyond what `load-dynamic` already does; XNNPACK registration
  succeeds or fails purely based on whether the *dlopen'd `.so`* was
  built with `onnxruntime_USE_XNNPACK=ON`. This is good for
  correctness-first design: if `ORT_DYLIB_PATH` accidentally points back
  at the stock nixpkgs `.so`, registration fails loudly at
  `with_execution_providers(...)` (an `ort::Error`), not silently — no
  extra guard code needed to detect a misconfigured dylib path.

**Proposed Rust change** (small, additive, mirrors the existing
`allow_keyboard_wake`-style opt-in pattern used throughout this port —
default off, explicit opt-in per the correctness-first requirement):

```rust
// cursor_ml_detect.rs
pub struct CascadeOptions {
    // ...existing fields...
    /// Attempt to register the XNNPACK execution provider before falling
    /// back to CPU. Off by default: requires a non-stock onnxruntime .so
    /// (ORT_DYLIB_PATH must point at one built with onnxruntime_USE_XNNPACK=ON)
    /// and has not yet been benchmarked on real hardware — see
    /// docs/xnnpack-rust-execution-provider-design.md.
    pub try_xnnpack: bool,
}

fn build_session(model_path: &Path, opts: &CascadeOptions) -> anyhow::Result<Session> {
    ort::init().commit()?;
    let mut builder = Session::builder()?;
    if opts.try_xnnpack {
        builder = builder.with_execution_providers([
            ort::ep::XNNPACK::default().build(),
        ])?;
        // fail loudly, don't silently continue on stock CPU-only builds —
        // correctness/observability over convenience for a benchmark path
    }
    Ok(builder.commit_from_file(model_path)?)
}
```

`Cargo.toml` gains the `xnnpack` feature on `ort`, gated behind a new
Cargo feature on `pikvm-mcp-detection-vision` itself (e.g. `xnnpack-ep`)
so the default build (what actually ships) is completely unaffected —
same "additive, reviewed per call site" discipline this session has used
for every other opt-in gate (`ScreenshotOptions.allow_keyboard_wake`,
`DetectOptions.allow_keyboard_wake`, etc.).

## 4. Correctness-first verification — required before any speed number is trusted

Same standard already applied to the INT8 candidate
(`scratch/cpu-inference-speedup/compare_int8.py` methodology) and to
every live-hardware change this session:

1. Build a small parity harness (Rust integration test or example,
   `detection-vision/examples/xnnpack_parity_check.rs`) that runs the
   **same real captured frames/crops** already used by the cursor
   cascade's own test fixtures through both CPU EP and XNNPACK EP
   sessions, comparing `heatmap_logits` and `presence_logit` outputs.
   Reuse the existing model I/O contract (`crop` fp32 NCHW `[N,3,96,96]`
   → `heatmap_logits [N,1,24,24]` + `presence_logit [N]`, sigmoid gate
   ≥0.5) — no new contract to invent.
2. Assert **zero presence-decision mismatches** and argmax/heatmap-peak
   agreement within the same noise floor already documented for
   backend-kernel variance elsewhere in this project (~0.005-0.04 range,
   not INT8's larger ~0.3-0.4 quantization-error range — XNNPACK is a
   different fp32 kernel implementation, not a precision reduction, so
   the bar is closer to the ncnn comparison's near-zero noise floor than
   INT8's).
3. Explicitly confirm (not assume) which EP actually ran — call
   `ort`'s equivalent of `GetAvailableProviders`/inspect the session's
   active providers before trusting any timing number, mirroring the
   Python harness's `sess.get_providers()` check. A build that silently
   falls back to CPU must never be reported as an XNNPACK benchmark.
4. Only once parity is confirmed does a timing comparison mean anything.

## 5. What's genuinely unknown and needs a real attempt on real hardware — not something this design can resolve from a desk

This is where the task's own step 4 ("implement, then benchmark REAL
inference latency on real Pi hardware") has to take over from design:

- **Does the XNNPACK overlay's pinned sources cross-compile / natively
  build for `aarch64-linux`?** Never attempted. `cpuinfo` (already a
  nixpkgs onnxruntime dep) and `kleidiai` are both ARM-aware, which is a
  good sign, but nothing has verified the full FetchContent graph
  actually configures/compiles cleanly for this target — this needs a
  real build attempt, either native-on-Pi4 (resource-risky — the x86_64
  build already needed 2 OOM-avoidance flags on a much beefier shared
  host) or cross-compiled via `pkgsCross.aarch64-multiplatform` on a
  bigger host (faster iteration, more likely how the appliance image is
  actually built already — check the pikvm-nixos repo's own
  cross-compilation setup before assuming either path, since this repo
  (`pikvm_mcp_server`) has no `crossSystem`/`pkgsCross` wiring of its own
  — that's owned upstream, in pikvm-nixos).
- **Real Pi4 EP-registration success**: confirm `XnnpackExecutionProvider`
  actually activates on the real onnxruntime dlopen path (not just the
  Python/pip path already proven on x86_64) — the generic
  `SessionOptionsAppendExecutionProvider` call means this should work if
  the `.so` has it compiled in, but "should" isn't "confirmed."
  <br>
  Since I have no hardware access (OFFLINE-only), this and the two items
  below are explicitly for whoever executes this design — see the access
  correction in §6 for exactly who that is.
- **Real speed delta.** The best available real-hardware CPU-EP fp32
  reference point today is the Node-side `bench_node.mjs` result on
  it-03400 (2026-08-27): ~71-73ms median per single-crop (N=1) inference,
  same model, same physical Pi4, same underlying onnxruntime C++ engine
  — but a **different binding** (`onnxruntime-node` vs `ort`) with
  possibly different default thread-pool behavior, so it's a useful
  sanity anchor, not a substitute for measuring the Rust CPU EP baseline
  directly on the same hardware before comparing against XNNPACK. Also
  note from the same investigation: the *real* production inference
  shape batches many crops per call (N=352 in the TS cascade before
  PR93's hint-narrowing; the Rust cascade's own current real N — after
  its own hint-narrowing, category-4 work already shipped this session —
  should be measured directly, not assumed from the TS number), and
  `intraOpNumThreads` showed large (~4x) scaling effects on x86_64 for
  batched workloads with the *default* setting winning over any explicit
  thread count tested — whether Pi4's default already uses all 4 Cortex-A72
  cores has never been confirmed on real ARM hardware. Any XNNPACK
  benchmark should sweep this the same way, and should benchmark at the
  Rust cascade's real production batch size, not N=1.
- **Multiple runs, both directions.** Same discipline as every other
  live-hardware claim this session: report medians across multiple real
  runs, not a single sample, and don't round a marginal or noisy result
  up to "faster."

## 6. Sequencing

1. This doc → review by georgs-mac-mini (same discipline as every other
   change this session) before any implementation.
2. Rust code change (§3) — small, additive, off by default, safe to land
   regardless of whether the aarch64 build ever succeeds.
3. **§5/§6's execution needs routing — corrected after review.**
   `pikvm-mcp-server@georgs-mac-mini` reviewed this doc (no design gaps
   found) but correctly flagged that *they* don't actually hold the
   access §5 assumes: no pikvm-nixos repo checkout, no SSH to pikvm01
   (key not provisioned, webterm-only, unprivileged uid, no sudo), no
   configured aarch64 linux-builder — nowhere near enough to run a
   from-source onnxruntime nix build. The real capability (SSH to
   pikvm01, the pikvm-nixos repo, an aarch64 linux-builder +
   nix-copy workflow already in active use) sits with a *different*
   agent identity on the same physical machine,
   `pikvm-nixos@georgs-mac-mini` (cross-compile-then-nix-copy, avoids
   the native-on-Pi4 OOM risk flagged above), or alternatively
   `pikvm-nixos@it-03400` (an actual Pi4B, native build possible there).
   Routing this correctly is the manager's call, not assumed here.
4. Whoever executes: attempt the aarch64 onnxruntime-XNNPACK build
   (native or cross).
5. If it builds: run the parity harness (§4) first — no speed number
   trusted before parity holds.
6. If parity holds: real Pi4 benchmark, multiple runs, both CPU-EP-only
   and XNNPACK-EP baselines measured fresh on the same hardware in the
   same session (not compared against the older Node-side number as a
   substitute).
7. Report the real, checked answer back — including a clean "no speed
   win" or "build infeasible on aarch64" outcome if that's what's found;
   this is explicitly not a foregone-conclusion investigation.
8. `pikvm-mcp-server@georgs-mac-mini` remains the right reviewer for
   whatever comes back (parity harness, benchmark) once it needs
   iPad-adjacent behavioral judgment — the correction above is about who
   holds the build/deploy access, not about removing them from review.

## What changed

- Initial version (this doc): confirms XNNPACK was never attempted in
  Rust (§1), that a real Rust-vs-Node speed comparison was never done at
  all (§0), locates and validates reusable overlay groundwork (§2),
  confirms the Rust-side integration is small given `ort`'s existing
  first-class XNNPACK support (§3), and scopes the correctness-first
  verification (§4) and genuinely-unknown real-hardware work (§5) that
  only whoever has hardware access can resolve.
- Revision after `pikvm-mcp-server@georgs-mac-mini`'s design review: no
  design gaps found, but they correctly self-corrected an access-scope
  assumption this doc had made — they don't hold the pikvm01 SSH /
  pikvm-nixos repo / aarch64 linux-builder access §5's execution needs;
  that sits with `pikvm-nixos@georgs-mac-mini` or `pikvm-nixos@it-03400`
  instead. §6 updated to route execution correctly rather than assume
  the reviewer is also the executor.

## 7. Result (2026-08-31) — executed by pikvm-nixos@georgs-mac-mini

**Verdict: firm NO-GO.** The aarch64 build problem (§5's first open
question) is fully solved and documented below for reuse. The Rust
wiring (§3) is real, small, and correct. But XNNPACK itself is both
BROKEN for this model's actual production (batched) inference shape
AND ~2.4x SLOWER than plain CPU-EP in the one shape (N=1) where it
does work correctly — full findings below.

### 7.1 aarch64 onnxruntime+XNNPACK build — SOLVED, 4 real attempts

Adapted `scratch/cpu-inference-speedup/onnxruntime-xnnpack-overlay.nix`
for `aarch64-linux` (swap `legacyPackages.x86_64-linux` →
`legacyPackages.aarch64-linux`) and built natively on a real
aarch64-linux machine — georgs-mac-mini's nix-darwin `linux-builder` VM
(a genuine ARM VM, not cross-compilation). That VM turned out to be far
smaller than the "beefier shared host" the x86_64 build ran on: only
**~2.9GB RAM, 1 CPU, zero swap** (confirmed via a diagnostic remote
build reading `/proc/meminfo`), well below what this build needs
regardless of `--cores`/parallelism tuning. In order, real attempts:

1. `--cores 4` → `cc1plus` OOM-killed compiling
   `core/util/math_cpu.cc.o`.
2. `--cores 1` → identical OOM, identical file — ruled out concurrency
   as the cause; this is a single-translation-unit peak-memory ceiling.
3. Added `--param ggc-min-expand=10 --param ggc-min-heapsize=32768` to
   `CMAKE_CXX_FLAGS` (tunes GCC's garbage collector to run more
   aggressively during compilation — trades compile time for peak
   memory, does NOT change `-O2` codegen/the resulting binary's
   behavior) → fixed the compile-time OOM completely (100% of `.cc.o`
   built, including the file that killed attempts 1-2), but the OOM
   moved one stage later: the final link (`ld` linking
   `libonnxruntime.so`, which statically pulls in
   XNNPACK+kleidiai+onnx+re2+abseil+protobuf all at once) got killed
   instead (exit 137).
4. Added `mold` as the linker (`-fuse-ld=mold` on
   `CMAKE_{EXE,SHARED,MODULE}_LINKER_FLAGS`, `pkgs.mold` in
   `nativeBuildInputs`) — a drop-in linker built specifically for low
   peak-memory/fast large-C++ links, no codegen/behavior change. Fixed
   the main `libonnxruntime.so` link. The OOM moved ONE more output
   over: linking `onnxruntime_pybind11_state.so` (the Python bindings'
   native module) also OOM'd under mold. Set `pythonSupport = false` on
   the `pkgs.onnxruntime.override` (the Rust port doesn't need the
   Python wheel at all — `ort`'s `load-dynamic` feature only needs
   `$out/lib/libonnxruntime.so` for `ORT_DYLIB_PATH`) — this skips that
   link entirely. **Clean build.**

Verified genuinely XNNPACK-enabled, not just "exit 0" — same bar §1
used to rule OUT the stock library, but more decisively: `strings` on
the built `.so` shows real demangled C++ method signatures
(`onnxruntime::XnnpackExecutionProvider::GetCapability`/
`CreatePreferredAllocators`, `onnxruntime::xnnpack::ConvBase`/
`AveragePool`/`FuseActivation` constructors), real internal-only error
strings only reachable from actual runtime code ("XNNPACK EP should not
have asked for the node", the pthread-threadpool-contention warning),
and real source paths
(`onnxruntime/core/providers/xnnpack/xnnpack_execution_provider.cc`).
254 XNNPACK string hits total — a real implementation, not just an
EP-name enumeration list.

The finished overlay (aarch64-only fixes on top of the proven x86_64
one, fully commented inline with this same history) is worth reusing
verbatim for any future aarch64 XNNPACK/similar-scale-C++ build attempt
on this same linux-builder VM.

### 7.2 Rust wiring (§3) — landed as designed, one deviation

Branch `feat/xnnpack-execution-provider` (commits 804c379, f29f1c1) —
new `xnnpack-ep` Cargo feature on `pikvm-mcp-detection-vision`, off by
default, gating `with_execution_providers([ort::ep::XNNPACK::default()
.build()])` on the verifier session before `commit_from_file`.
Registration failure surfaces as a real error (`map_err`, not silently
swallowed to CPU) — correctness-first, as designed.

**Deviation from this doc's illustrative sketch**: gated via a Cargo
feature (compile-time) rather than a runtime `CascadeOptions
.try_xnnpack` field, to avoid threading a new parameter through every
call site/test for what's currently a benchmark-only spike. Easy to
promote to a runtime option later if XNNPACK ever becomes worth
shipping. Verified: 198 tests pass, clippy clean, fmt clean, with and
without the feature — default build genuinely unaffected.

### 7.3 Correctness check (§4) — PASSES for N=1, PANICS for N>1

Ran on real pikvm01 hardware (nix-copied the built XNNPACK
`onnxruntime.so` there, cloned the branch, built+ran natively —
40min cold build on Pi4 silicon, ~90s incremental for the feature
rebuild). `examples/xnnpack_parity_check.rs`, same deterministic
synthetic-crop input as the crate's existing `#[ignore]`d real-model
tests, run twice (once per EP, compile-time-gated).

**N=1 (single crop): PASSES.** `x=234, y=231` identical to CPU-EP;
`presence=0.002882` vs CPU-EP's `0.002883` — 1e-6 difference, well
inside the ~0.005-0.04 kernel-implementation-variance noise floor this
doc anticipated (§4 item 2). XNNPACK genuinely works, numerically, for
this model, at this batch size.

**N=6 (batched — my original parity test): PANICS.** `presence_logit`'s
output tensor comes back length 1 instead of the expected batch size
6 — `presence[bi]` index-out-of-bounds when
`run_cascade_inference` picks the winning crop across the batch. This
is NOT a harness bug: identical inference code path, CPU-EP handles
the same N=6 batch correctly; only the registered EP differs between
the two runs. This is a genuine onnxruntime-XNNPACK incompatibility
with batched execution of this specific model — some op in the graph
most likely doesn't support XNNPACK's batched code path and either
silently reshapes or the EP partially claims the graph in a way that
breaks the batch dimension. Not root-caused further (would need
digging into onnxruntime's XNNPACK provider internals) — flagged here
as the concrete next step IF anyone revisits this.

### 7.4 N=1 timing (2026-08-31 follow-up, georg's explicit go/no-go ask)

Before closing this out, georg asked for any speed signal at all —
even N=1, which already passed correctness — framed explicitly as a
decision-input number ("is fixing the batch crash worth anyone's
time"), not a production claim. Added a warmup(5)+30-iteration timed
loop to `xnnpack_parity_check.rs` (commit e691287), run on the same
real pikvm01 hardware, same single-crop input as §7.3's N=1 check:

| EP      | median   | min      | max       |
|---------|----------|----------|-----------|
| CPU     | 31.98ms  | 29.92ms  | 34.55ms   |
| XNNPACK | 76.98ms  | 75.39ms  | 111.08ms  |

**XNNPACK is ~2.4x SLOWER than plain CPU-EP even in the one case where
it runs correctly.** Same pattern as this project's other acceleration
attempts on this hardware (Vulkan 4.8-6.3x slower per the earlier GPU
investigation, INT8 ~25% slower per §1 above) — most likely XNNPACK's
own thread-pool/dispatch overhead dominating for a model this small
(96x96 crop, a tiny network), where plain CPU EP's simpler path wins.
**Caveat, as with everything else at N=1 in this doc: not the real
production batch shape** — but combined with §7.3's batch panic,
there's no scenario left where XNNPACK is worth pursuing further for
this pipeline: it's slower where it works, and broken where it'd
actually be used in production.

### 7.5 Why this closes as a firm NO-GO, not "needs more investigation"

Production always batches (N=352 pre-hint-narrowing per
`task_78184455df4e`'s full-path-profiling finding; smaller-but-still->1
after PR93's hint-narrowing). §5's real Pi4 benchmark against the real
production batch shape was skipped: it can't run at all (§7.3's panic),
and §7.4's N=1 number already answers the only question a batched
number could have added ("is XNNPACK faster") in the negative anyway —
even without the batch overhead, XNNPACK loses. The batching
incompatibility would need to be root-caused and fixed for this to be
worth reopening (or the pipeline restructured to N sequential
single-crop XNNPACK calls, which would almost certainly lose to the
already-fast batched CPU-EP path on per-call overhead alone on top of
already losing per-call — not worth pursuing). XNNPACK is not usable
for, and not faster than CPU-EP for, this pipeline as it exists today.

The aarch64 build fix (§7.1) and the Rust wiring (§7.2, landed
off-by-default and harmless) both remain useful groundwork regardless
— if the batching issue is ever fixed upstream or worked around, the
infrastructure to pick it back up is already in place.
