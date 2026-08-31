//! Correctness-first parity check for the XNNPACK execution provider
//! (docs/xnnpack-rust-execution-provider-design.md §4, task_476e2fd57bc2).
//!
//! Compares `run_cascade_inference`'s output (x, y, presence,
//! heatmap_peak) between a CPU-only session and an XNNPACK-registered
//! session, against the SAME real model and SAME deterministic synthetic
//! input — same input-generation convention as
//! `cursor_ml_detect::tests::synthetic_crop_source` (real captured
//! frames aren't part of this crate's checked-in fixtures; a
//! deterministic synthetic crop is what the existing `#[ignore]`
//! real-model tests already use, and is sufficient here since this is an
//! EP-vs-EP comparison on identical input, not a model-accuracy check).
//!
//! The EP choice is a COMPILE-TIME feature (`xnnpack-ep`, see Cargo.toml)
//! because `ort`'s `with_execution_providers` call is gated behind
//! `#[cfg(feature = "xnnpack-ep")]` in `cursor_ml_detect.rs` — so this
//! example is run TWICE, once per build, and the two runs' output is
//! diffed externally (same pattern the earlier Python
//! `compare_int8.py` investigation used for its own EP-vs-EP comparison).
//!
//! Run:
//!   ORT_DYLIB_PATH=/path/to/xnnpack-enabled/libonnxruntime.so \
//!     cargo run -p pikvm-mcp-detection-vision --example xnnpack_parity_check \
//!     > cpu_result.txt
//!   ORT_DYLIB_PATH=/path/to/xnnpack-enabled/libonnxruntime.so \
//!     cargo run -p pikvm-mcp-detection-vision --example xnnpack_parity_check --features xnnpack-ep \
//!     > xnnpack_result.txt
//!   diff cpu_result.txt xnnpack_result.txt   # expect identical/near-identical CascadeResult lines
//!
//! Both runs need the SAME ORT_DYLIB_PATH — an XNNPACK-enabled .so is
//! required either way (the CPU-only run just doesn't register the EP,
//! it still dlopens the same non-stock library) so the only variable
//! between the two runs is EP registration itself, not the underlying
//! onnxruntime build.

use ort::session::Session;
use pikvm_mcp_detection_vision::cursor_ml_detect::run_cascade_inference;

/// Same generator as `cursor_ml_detect::tests::synthetic_crop_source` —
/// duplicated here (that helper is `#[cfg(test)]`-private, and widening
/// the crate's public API for a benchmark-only example isn't worth it).
/// Must stay byte-identical to that helper for the two to be comparable
/// if anyone ever runs both.
fn synthetic_crop_source(fw: u32, fh: u32) -> Vec<u8> {
    let mut buf = vec![120u8; (fw as usize) * (fh as usize) * 3];
    for y in 200..260u32 {
        for x in 200..260u32 {
            let i = ((y * fw + x) as usize) * 3;
            buf[i] = 230;
            buf[i + 1] = 230;
            buf[i + 2] = 230;
        }
    }
    buf
}

fn build_session(model_path: &std::path::Path) -> anyhow::Result<Session> {
    ort::init().commit();
    #[allow(unused_mut)]
    let mut builder = Session::builder()?;
    #[cfg(feature = "xnnpack-ep")]
    let mut builder = builder
        .with_execution_providers([ort::ep::XNNPACK::default().build()])
        .map_err(|e| anyhow::anyhow!("XNNPACK EP registration failed: {e}"))?;
    Ok(builder.commit_from_file(model_path)?)
}

fn main() -> anyhow::Result<()> {
    let ep_label = if cfg!(feature = "xnnpack-ep") {
        "XNNPACK"
    } else {
        "CPU"
    };

    let model_path = pikvm_mcp_detection_vision::cursor_ml_detect::resolve_verifier_model();
    // Explicitly confirm which EP actually ran, per the design doc's §4
    // item 3 — a build that silently falls back to CPU must never be
    // reported as an XNNPACK result. `ort` 2.0.0-rc.13's `Session` has no
    // post-hoc "list active providers" query (only `Environment::
    // execution_providers()`, which reflects what was CONFIGURED, not
    // necessarily what actually activated for this session) — but per
    // the design doc's own analysis, `with_execution_providers` calls the
    // generic `SessionOptionsAppendExecutionProvider` C API entry point,
    // which fails LOUDLY (a real `ort::Error`, already `?`-propagated
    // above in `build_session`) if the dlopen'd .so wasn't built with
    // onnxruntime_USE_XNNPACK=ON, rather than silently no-op'ing. So
    // simply reaching this line under the xnnpack-ep feature IS the
    // confirmation — a silent CPU fallback isn't possible here.
    let mut session = build_session(&model_path)?;
    eprintln!("[{ep_label} run] session built + EP registration (if any) succeeded without error");

    let (fw, fh) = (640u32, 480u32);
    let full = synthetic_crop_source(fw, fh);
    // N=1 only. An earlier N=6 (batched) run confirmed a real
    // onnxruntime-XNNPACK incompatibility — presence_logit comes back
    // length 1 instead of the batch size, an index-out-of-bounds panic
    // — see docs/xnnpack-rust-execution-provider-design.md §7.3. This
    // harness stays at N=1 so it can still run at all under XNNPACK;
    // it is explicitly NOT the production batch shape (§7.4) — the
    // timing below is a decision-input signal only ("is fixing the
    // batch crash worth anyone's time"), not a production benchmark.
    let centers: Vec<(i64, i64)> = vec![(230, 230)];

    let result = run_cascade_inference(&mut session, &full, fw, fh, &centers, 0.0)?
        .expect("non-empty centers must produce a result at verify_thresh=0.0");

    println!("ep={ep_label}");
    println!("x={}", result.x);
    println!("y={}", result.y);
    println!("presence={:.6}", result.presence);
    println!("heatmap_peak={:.6}", result.heatmap_peak);

    // --- N=1 timing (decision-input only, see the note above) ---
    // A few warmup calls (thread-pool spin-up, allocator warmup, first-
    // call JIT-ish effects some EPs have) discarded before timing, per
    // the design doc's "multiple runs" discipline (§5 last item).
    const WARMUP: usize = 5;
    const ITERS: usize = 30;
    for _ in 0..WARMUP {
        run_cascade_inference(&mut session, &full, fw, fh, &centers, 0.0)?;
    }
    let mut samples_us = Vec::with_capacity(ITERS);
    for _ in 0..ITERS {
        let start = std::time::Instant::now();
        let r = run_cascade_inference(&mut session, &full, fw, fh, &centers, 0.0)?;
        samples_us.push(start.elapsed().as_micros());
        std::hint::black_box(r);
    }
    samples_us.sort_unstable();
    let median_us = samples_us[samples_us.len() / 2];
    let min_us = samples_us[0];
    let max_us = samples_us[samples_us.len() - 1];
    println!("timing_n=1_median_us={median_us}");
    println!("timing_n=1_min_us={min_us}");
    println!("timing_n=1_max_us={max_us}");
    println!("timing_n=1_iters={ITERS}");

    Ok(())
}
