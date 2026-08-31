# XNNPACK execution provider in the Rust ONNX cascade — design (task_476e2fd57bc2)

**FINAL VERDICT (2026-08-31): NO-GO, clean and evidence-backed.** aarch64
XNNPACK-enabled onnxruntime build: solvable, done, documented (§5,
`feat/xnnpack-execution-provider`, PR #95, not merged — see §7).
Rust EP-registration wiring (§3): small, correct, off-by-default.
Correctness parity (§4): single-crop (N=1) inference PASSES (numerically
identical to CPU-EP within noise floor); the real production batch shape
(N>1, e.g. N=6 tested) **PANICS** — a genuine onnxruntime/XNNPACK
batch-dimension incompatibility with this model, confirmed not a harness
bug (CPU-EP handles the identical N=6 batch correctly). XNNPACK is **not
currently usable** for this pipeline's real batched-inference workload.
The real Pi4 timing benchmark (§5's last step) was correctly never run
against the broken N=1-only path — that would have answered the wrong
question. See §7 for the full finding and disposition.

georg's original question: earlier this session, XNNPACK was confirmed
**unreachable from `onnxruntime-node`** (the Node.js napi binding —
hardcoded 7-provider dispatch, no `xnnpack` case, source-confirmed at the
pinned tag and upstream). The Rust port's `ort` crate talks to the same
underlying onnxruntime C++ library via `dlopen` (`load-dynamic` feature) —
architecturally a completely different path. Has XNNPACK ever actually
been attempted in Rust? **No — confirmed never done** (see §1). The rest
of this doc is the correctness-first design that was then executed,
leading to the NO-GO verdict above.

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

## 7. Final finding and disposition (2026-08-31) — clean NO-GO

Execution went exactly per §6, steps 3-5, and stopped there for a real
reason rather than proceeding to the benchmark on autopilot:

- **§5's aarch64 build succeeded** on `pikvm-nixos@georgs-mac-mini`'s
  linux-builder, after 4 real attempts (GCC GC-tuning, mold linker,
  `pythonSupport=false` — the earlier OOM class this design already
  flagged as the real risk, confirmed and worked through, not avoided).
  XNNPACK confirmed genuinely compiled into the resulting `.so` via
  strings/demangled-symbol inspection — the same discipline §1 used to
  confirm nixpkgs' *stock* onnxruntime does NOT have it, applied here in
  reverse to confirm this custom build DOES.
- **§3's Rust wiring shipped**: `feat/xnnpack-execution-provider`
  (`804c379`) — small, additive, off-by-default `xnnpack-ep` Cargo
  feature. Independently re-verified by me (not trusting the reported
  numbers): build/clippy/fmt clean with and without the feature;
  `pikvm-mcp-detection-vision` tests 198 passed/0 failed/4 ignored,
  identical both ways; full workspace test exits clean. PR #95 opened
  against `rust-port/module-4-mover`.
- **§4's correctness parity harness shipped** (`f29f1c1`,
  `xnnpack_parity_check` example) and ran on real hardware
  (pikvm01): **single-crop (N=1) inference PASSES** — CPU-EP and
  XNNPACK-EP output numerically identical within the same noise floor
  already documented elsewhere in this project for backend-kernel
  variance. But **the real production batch shape (N>1, N=6 tested)
  PANICS** under XNNPACK — a genuine onnxruntime/XNNPACK
  batch-dimension incompatibility with this specific model, confirmed
  NOT a harness bug by cross-checking that CPU-EP handles the identical
  N=6 batch input without issue. (One caveat worth recording precisely,
  not glossed over: N=1 "passing" numerically identical rather than
  merely near-identical is itself a fact worth a second look before
  trusting *any* future N=1-only XNNPACK measurement on this model — see
  the exact-vs-near-identical concern raised during review — but it's
  moot for this verdict, since the batch case fails outright regardless
  of how N=1 is interpreted.)
- **§5's real Pi4 timing benchmark was correctly never run** against the
  N=1-only path — benchmarking a shape the production pipeline doesn't
  actually use would have answered the wrong question, and running it
  against the broken N>1 path isn't possible (it panics before
  completing). This is the correctness-first gate (§4) doing exactly
  what it was designed to do: catching a real incompatibility before a
  misleading speed number could ship.

**Verdict: XNNPACK is not currently usable for this pipeline's real
batched-inference workload.** This is a complete, real, checked answer
to georg's original question — not an "estimate" or a "should work"
guess — and a clean negative result, not a stalled or abandoned
investigation.

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
- Final revision (2026-08-31): §7 added recording the actual execution
  outcome — clean NO-GO, N=1 parity passes but the real production
  batch shape panics under XNNPACK. Manager closed task_476e2fd57bc2 on
  this finding. PR #95 (the Rust wiring + parity harness) is being
  closed without merging, matching this project's established
  precedent for confirmed negative CPU-inference-speedup results (the
  earlier INT8 and ncnn+Vulkan investigations both live as unmerged
  scratch/reference branches, not in the shipped crate tree) — see the
  PR's own closing comment for the exact reasoning.
