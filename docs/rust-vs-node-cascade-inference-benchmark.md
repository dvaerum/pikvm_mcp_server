# Rust-vs-Node cascade-inference benchmark (task_17eebaaa7160)

georg asked whether iPad cursor tracking can be made faster; part of
scoping that (task_7ce237717d82) required finding the source of a
"~13-15% Rust-vs-Node cascade-inference gap" the manager referenced.
That number turned out to be real, but existed only as a chat message
(`pikvm-nixos@it-03400` → manager, `msg_24f31a0be99b8dd4`, 2026-08-31) —
not committed anywhere. This doc is that missing artifact, written up
after independently confirming the number wasn't a mix-up with the
unrelated PR#93 Node-before/Node-after figure (`docs/FUTURE-WORK.md`).

## Methodology

- Real Pi4B hardware (it-03400's appliance), both sides release-build.
- Rust: `rust-port/module-4-mover` @ `8a1b7f9` (the E2E-sign-off-complete
  commit — see `docs/rust-port-completion-sign-off.md`).
- Node: whatever build was already deployed on the box at test time (not
  independently pinned to a specific commit in the source report — see
  "Open gaps" below).
- 2 real captured frames (`frame-lower-left-01`, `frame-upper-right-01`).
- 10 runs each, both `no-hint` (N=352 full-region scan) and `hint=gt`
  (narrow window, PR#93's hint-narrowing) configs — 4 cases × 10 runs.
- Correctness cross-check: cursor coordinates byte-identical between
  Rust and Node on all 4 cases — this benchmark is measuring speed only,
  not accuracy; there is no correctness question here.

## Results (median, ms)

| Frame | Config | Node | Rust | Gap |
|---|---|---|---|---|
| frame-lower-left-01 | no-hint (N=352) | 14995 | 17023 | +2028ms (**13.5%**) |
| frame-lower-left-01 | hint=gt | 3004 | 3151 | +147ms (**4.9%**) |
| frame-upper-right-01 | no-hint (N=352) | 14600 | 16867 | +2267ms (**15.5%**) |
| frame-upper-right-01 | hint=gt | 3024 | 3200 | +176ms (**5.8%**) |

(Percentages computed here from the raw ms figures reported; not
independently re-verified against raw per-run data — see "Open gaps.")

**A real, notable pattern, not previously called out**: the gap is
roughly 3x larger in absolute terms and meaningfully larger in relative
terms on the large-batch (N=352, no-hint) cases than on the small-batch
(hint-narrowed) cases. A flat per-request or per-process overhead
(startup cost, FFI/binding overhead, fixed dispatch cost) would be
expected to show up as a roughly CONSTANT gap regardless of batch size —
what's observed instead scales with batch size, which points toward
something in the actual inference/threading path rather than a fixed
per-call cost. This is circumstantial, not proven, but it's the reason
thread-count tuning (see below) is the most promising next lever rather
than, say, further FFI-overhead investigation.

## What's been ruled out

**The onnxruntime build/version-artifact theory is ruled out.**
Independently checked (this session, `docs/xnnpack-rust-execution-provider-design.md`
§1's discipline applied here too): Microsoft's official
`onnxruntime-node` 1.24.3 prebuilt and nixpkgs' from-source-built 1.24.4
(what the Rust `ort` crate dlopens) are essentially identical on every
build flag that could plausibly affect CPU inference speed — same LTO
(on), same protobuf-lite (not full), same XNNPACK-off, same
internal-threadpool-not-OpenMP threading model, same `ORT_ENABLE_ALL`
graph-optimization default. The 1.24.3→1.24.4 onnxruntime changelog has
zero entries touching CPU EP, threading, or ARM codegen. If the gap is
real (it is — see above), it is very unlikely to be an onnxruntime
build/version artifact.

## What's still open

- **Thread-count (`intraOpNumThreads`) tuning on real Pi4 — the
  recommended next step.** Neither binding sets this explicitly (both
  run on ONNX Runtime's bare default). An x86_64 sweep exists
  (`scratch/cpu-inference-speedup/README.md` §4) showing the unset
  default beating an explicit `4` on a 16-core devbox, but that doc
  itself flags this as non-predictive for a 4-core Pi4 — "whether Pi4's
  default already uses all 4 Cortex-A72 cores has never been confirmed
  on real ARM hardware." Cheapest concrete next step: run the existing
  `scratch/cpu-inference-speedup/full-path-profile.mts`-style sweep (or
  an equivalent Rust-side one, since this benchmark now shows the gap is
  Rust-specific, not just a TS question) on real Pi4 hardware, varying
  `intraOpNumThreads` explicitly on the Rust side and comparing against
  Node's own default resolution. **This needs real hardware access I
  don't have (OFFLINE-only) — the right owner is whoever ran this
  benchmark (pikvm-nixos@it-03400) or another node with Pi4 access.**
- **Exact Node build/commit not pinned in the source report.** The
  methodology note says "whatever Node build was already on the box" —
  useful for a first-pass sanity check, but for a rigorous comparison the
  exact Node/onnxruntime-node commit-or-package-version on the box at
  test time should be recorded, in case the deployed Node build itself
  has since drifted from what's on `main` today.
  \
  Whoever re-runs or extends this benchmark should record that
  precisely, per this project's own "don't average two claims, verify
  against the authoritative source" discipline.
- **Raw per-run data not preserved here.** Only the reported medians are
  recorded above (from the source chat message) — no raw 10-run
  distributions, no variance/spread. If the thread-count sweep or any
  follow-up needs statistical confidence beyond "the median moved," the
  raw per-run numbers should be captured and kept (matching how other
  real-hardware benchmarks in this project, e.g. the INT8/XNNPACK
  investigations, keep raw output alongside the summary).

## Disposition

Not a correctness concern (byte-identical output confirmed). A real,
measured ~13-15% Rust-vs-Node speed gap exists specifically in the
large-batch (no-hint) case and a smaller ~5-6% gap in the hint-narrowed
case — both real Pi4 numbers, not an artifact of differing onnxruntime
builds. Thread-count tuning is the most promising next lever given the
batch-size-correlated pattern, and is real, cheap, untried work for
whoever has Pi4 hardware access to pick up next.
