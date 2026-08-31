# Rust cascade `intraOpNumThreads`/`interOpNumThreads` sweep on real Pi4 — design (task_7ce237717d82 follow-up)

Follow-up to `docs/rust-vs-node-cascade-inference-benchmark.md`, which
found a real ~13.5%/15.5% Rust-vs-Node gap on the no-hint (N=352
full-scan) case and a smaller ~4.9%/5.8% gap on the hint-narrowed case,
ruled out an onnxruntime build/version artifact as the cause (both
bindings' build flags are essentially identical), and flagged that the
gap scaling with batch size is circumstantial evidence pointing at the
inference/threading path. Neither binding sets `intraOpNumThreads`
explicitly today — both run on ONNX Runtime's bare default. Whether
that default actually uses all 4 of the Pi4's Cortex-A72 cores has
never been confirmed on real ARM hardware (only on a 16-core x86_64
devbox, where the *TS-side* harness below already showed the unset
default beating an explicit `4` — explicitly flagged there as
non-predictive for a 4-core ARM target).

This is real design work for **you** to implement + run — I have no Pi4
hardware access (OFFLINE-only). Sending directly per the manager's
go-ahead, same routing pattern as the XNNPACK design.

## Goal

Confirm/deny whether explicit `intraOpNumThreads` tuning changes the
Rust cascade's real inference latency on real Pi4 hardware, and whether
it narrows or explains the Rust-vs-Node gap.

## What already exists (TS side, reusable as the comparison baseline)

`scratch/cpu-inference-speedup/full-path-profile.mts` (branch
`scratch/cpu-inference-speedup-artifacts`, task_78184455df4e) already
does exactly this sweep on the Node/TS side: real captured frame
(`data/openloopshape-real/frame-lower-left-01.jpg` by default), real
`detectIpadRegion` + grid-build + batched inference (real N, not a
synthetic single-crop), per-phase timing, swept across
`intraOpNumThreads ∈ {unset, 1, 2, 4}` with `interOpNumThreads: 1` when
explicit. If it hasn't already been re-run on real Pi4 hardware (the
doc's own "what's still open" note says it never has been), running it
there is step 0 — a real Node-side-only Pi4 baseline for this exact
sweep, using the exact same real frame the new Rust sweep below should
also use, so the two are directly comparable.

## New: Rust-side mirror (`rust/detection-vision/examples/thread_count_sweep.rs`)

Mirror the TS harness's shape as closely as possible for a fair
comparison — same real frame, same sweep values, same per-run
methodology (10 runs + 1 untimed warmup, median/min/max reported).

**Real production building blocks to reuse (all already public,
confirmed via direct read — no new detection/grid logic to write):**
- ~~`pikvm_mcp_detection_vision::orientation::detect_ipad_bounds_from_buffer`~~
  **Correction (it-03400, verified against source before folding in):**
  this was wrong — `run_cascade` (`cursor_ml_detect.rs:358`, the actual
  function the original Rust-vs-Node benchmark called) does its region
  detection via `detect_ipad_region` (from `ipad_region_detect`) +
  `NATIVE_MARGIN` inset math, NOT `detect_ipad_bounds_from_buffer`,
  which doesn't appear anywhere in that call path. Use
  `pikvm_mcp_detection_vision::ipad_region_detect::detect_ipad_region`
  + the same `NATIVE_MARGIN` inset math instead — mirroring the real
  reference implementation the benchmark numbers actually came from,
  not a different (if superficially similar) detector.
- `pikvm_mcp_detection_vision::cursor_ml_detect::build_cascade_grid` /
  `cascade_axis` — real grid-build (mirrors TS's `axis`/grid-loop, same
  `GRID_STRIDE`/crop-half math — confirm the exact constants match by
  reading both side by side, don't assume identical values).
- `pikvm_mcp_detection_vision::cursor_ml_detect::run_cascade_inference`
  — the real batched inference call.
- Model path via `cursor_ml_detect::resolve_verifier_model()`.

**Session construction, the actual sweep variable** — build a fresh
`Session` per sweep point (matching the TS harness's own per-config
session creation, not one shared session):

```rust
use ort::session::Session;

fn build_session(model_path: &Path, intra: Option<usize>) -> anyhow::Result<Session> {
    ort::init().commit();
    let mut builder = Session::builder()?;
    if let Some(n) = intra {
        builder = builder.with_intra_threads(n)?.with_inter_threads(1)?;
    }
    Ok(builder.commit_from_file(model_path)?)
}
```

(`ort::session::builder::SessionBuilder::with_intra_threads(usize)` /
`with_inter_threads(usize)` confirmed to exist at the pinned `ort`
version `2.0.0-rc.13` — direct source read, same discipline as the
XNNPACK design doc's own API verification.)

**Sweep loop**, mirroring the TS harness exactly:

```rust
for label in ["default(unset)", "1", "2", "4"] {
    let session = build_session(&model_path, match label {
        "default(unset)" => None,
        n => Some(n.parse().unwrap()),
    })?;
    // 1 untimed warmup run, then 10 timed runs against the SAME real
    // frame + SAME real grid (build the grid once outside the loop —
    // it doesn't depend on thread count, only re-run inference per
    // iteration, matching TS's own per-run reuse of the same batch).
    // Report median/min/max per phase (region-detect, grid-build,
    // inference, postprocess) + TOTAL, same shape as the TS output.
}
```

**Real frame input**: use the SAME real captured frame the TS harness
defaults to (`data/openloopshape-real/frame-lower-left-01.jpg`, repo
root) — load it directly from disk at runtime (not a synthetic
generator like `xnnpack_parity_check.rs` used, since that harness had
no real-frame need for a pure EP-vs-EP comparison; this harness's whole
point is measuring the real production grid/batch shape, which needs a
real frame to produce a realistic N). This does mean the example needs
filesystem access to the repo's `data/` dir at runtime, same as the TS
harness already assumes (`process.cwd()`-relative) — run it from the
repo root.

## What to report back

1. The Rust-side sweep table (median ms per `intraOpNumThreads` value,
   same shape as the TS harness's own output) — does an explicit
   thread count beat the default on real Pi4, unlike the (non-
   predictive) x86_64 result?
2. The TS-side sweep re-run on the SAME real Pi4 box, if not already
   done — a direct comparison point.
3. Whether the best Rust configuration narrows the ~13.5%/15.5%
   Rust-vs-Node gap from `docs/rust-vs-node-cascade-inference-benchmark.md`,
   using the SAME methodology that benchmark used (same 2 frames, both
   no-hint and hint=gt configs, 10 runs) — not just this sweep's own
   single-frame numbers, so the result is directly comparable to the
   number that motivated this investigation.
4. If forcing `intraOpNumThreads` doesn't help, that's a real, useful
   negative result too — report it as such rather than continuing to
   chase this lever past the point it's paying off, same discipline as
   the XNNPACK/INT8/Vulkan investigations.

## Correctness note

This sweep only varies threading config, not model/inputs — no parity
check needed (unlike XNNPACK, which was a genuinely different execution
path). Cursor coordinates should be identical across all sweep points;
worth a quick sanity assert but not the focus.

## What changed

- Initial version: designed the Rust-side mirror harness, sweep values,
  and reporting requirements.
- Correction (it-03400, while implementing): the design's suggested
  region-detection function was wrong — verified against source that
  `run_cascade` (the actual benchmarked function) calls
  `ipad_region_detect::detect_ipad_region`, not
  `orientation::detect_ipad_bounds_from_buffer`. Fixed above so the
  sweep mirrors the real reference implementation, not a different code
  path that happens to look similar.
