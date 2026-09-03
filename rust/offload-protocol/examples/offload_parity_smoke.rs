//! Wire-codec fidelity proof for the cascade-inference offload feature
//! (docs/cursor-offload-inference-design.md §6.3, task_d06561d91f58) —
//! mirrors `detection-vision/examples/cascade_hint_narrowing_smoke.rs`'s
//! own "no live hardware needed, runs against real frames already
//! committed to this repo" shape (see that crate's
//! `calibrate_crop_tolerance.rs` for the identical convention).
//!
//! Lives in THIS crate (`offload-protocol`), not `detection-vision`,
//! despite the design doc naming `rust/detection-vision/examples/
//! offload_parity_smoke.rs` — `detection-vision` cannot depend on
//! `offload-protocol` (the dependency runs the other way: this crate
//! depends on `detection-vision` to reuse its real `CascadeResult`/
//! `RawCrop` types), so an example that needs the real wire codec must
//! live here instead. Corrected during implementation rather than
//! forcing a circular dependency to match the spec's literal path.
//!
//! Deliberately narrower in scope than the design's own required
//! REAL HARDWARE gate (Mac mini + real Pi4, §6.4) — this proves only
//! that the WIRE PROTOCOL itself is lossless: round-trip real captured
//! crop bytes through `offload_protocol::encode`/`decode` (an in-process
//! loopback — no socket, no subprocess, no helper binary involved) and
//! confirm inference on the round-tripped bytes produces EXACTLY the
//! same `CascadeResult`s as inference on the original bytes. A
//! corruption bug in the wire codec itself (a byte-order slip, an
//! off-by-one in a length prefix, a dropped crop) would show up here
//! without needing real network hardware to catch it.
//!
//! Run: PIKVM_ML_VERIFIER_MODEL=... ORT_DYLIB_PATH=... \
//!      cargo run -p pikvm-mcp-offload-protocol --example offload_parity_smoke

use pikvm_mcp_detection_vision::cursor_ml_detect::{
    resolve_verifier_model, run_cascade_inference_all, run_cascade_inference_all_from_raw_crops,
    CascadeResult, RawCrop, CASCADE_CROP,
};
use pikvm_mcp_detection_vision::decode::decode_to_rgb;
use pikvm_mcp_offload_protocol::{decode as protocol_decode, encode as protocol_encode, Frame};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .canonicalize()
        .expect("repo root should exist two levels up from this crate")
}

fn find_jpegs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            find_jpegs(&path, out);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
                out.push(path);
            }
        }
    }
}

/// Same clamped-bounds crop extraction `crop_cache::extract_crop_bytes`
/// uses internally (that function is `pub(crate)`, not reachable from an
/// example) — deliberately reimplemented rather than exposed further,
/// since a real extraction-formula MISMATCH here would surface as an
/// immediate, honest diff failure below (comparing against
/// `run_cascade_inference_all`'s own internal extraction), not a
/// silently-passing test.
fn extract_crop_bytes(full: &[u8], fw: u32, fh: u32, crop: i64, cx: i64, cy: i64) -> Vec<u8> {
    let half = crop / 2;
    let left = 0i64.max((fw as i64 - crop).min(cx - half));
    let top = 0i64.max((fh as i64 - crop).min(cy - half));
    let mut out = Vec::with_capacity((crop * crop * 3) as usize);
    for yy in 0..crop {
        for xx in 0..crop {
            let si = (((top + yy) as usize) * (fw as usize) + ((left + xx) as usize)) * 3;
            out.extend_from_slice(&full[si..si + 3]);
        }
    }
    out
}

fn assert_exact_match(
    frame_path: &std::path::Path,
    direct: &[CascadeResult],
    round_tripped: &[CascadeResult],
) {
    assert_eq!(
        direct.len(),
        round_tripped.len(),
        "FAILED ({}): crop count mismatch after wire round-trip",
        frame_path.display()
    );
    for (i, (d, r)) in direct.iter().zip(round_tripped.iter()).enumerate() {
        assert_eq!(
            d.x,
            r.x,
            "FAILED ({}): crop {i} x mismatch after wire round-trip",
            frame_path.display()
        );
        assert_eq!(
            d.y,
            r.y,
            "FAILED ({}): crop {i} y mismatch after wire round-trip",
            frame_path.display()
        );
        assert_eq!(
            d.presence,
            r.presence,
            "FAILED ({}): crop {i} presence mismatch after wire round-trip",
            frame_path.display()
        );
        assert_eq!(
            d.heatmap_peak,
            r.heatmap_peak,
            "FAILED ({}): crop {i} heatmap_peak mismatch after wire round-trip",
            frame_path.display()
        );
    }
}

fn main() -> anyhow::Result<()> {
    let root = repo_root();
    let mut frames = Vec::new();
    for dir in ["data", "benches/fixtures"] {
        find_jpegs(&root.join(dir), &mut frames);
    }
    frames.sort();
    if frames.is_empty() {
        eprintln!("FAILED: no .jpg/.jpeg frames found under {}/{{data,benches/fixtures}} — nothing to round-trip", root.display());
        std::process::exit(1);
    }
    // A representative handful, not all of them — this proves codec
    // fidelity, which doesn't get MORE proven by the 100th frame than
    // the 5th; keeps the example fast to run in CI.
    frames.truncate(5);
    eprintln!(
        "round-tripping {} real captured frames through the wire codec",
        frames.len()
    );

    ort::init().commit();
    let model_path = resolve_verifier_model();
    let mut session = ort::session::Session::builder()?.commit_from_file(&model_path)?;

    let crop = CASCADE_CROP as i64;
    for frame_path in &frames {
        let jpeg_bytes = std::fs::read(frame_path)?;
        let full = decode_to_rgb(&jpeg_bytes)?;
        let (fw, fh) = (full.width, full.height);

        // A small, deterministic scatter of crop centers across the
        // frame — real captured pixel content, not synthetic/uniform.
        let centers: Vec<(i64, i64)> = [
            (0.15, 0.15),
            (0.5, 0.3),
            (0.85, 0.5),
            (0.3, 0.8),
            (0.7, 0.9),
        ]
        .iter()
        .map(|&(fx, fy)| ((fw as f64 * fx) as i64, (fh as f64 * fy) as i64))
        .collect();

        // The "local" reference result, computed the normal way.
        let direct = run_cascade_inference_all(&mut session, &full.data, fw, fh, &centers)?;

        // The SAME crops, but round-tripped through the real wire codec
        // (in-process loopback — no socket) before inference, exactly
        // as an offload helper would receive and answer them.
        let crops: Vec<RawCrop> = centers
            .iter()
            .map(|&(cx, cy)| RawCrop {
                center: (cx, cy),
                bytes: extract_crop_bytes(&full.data, fw, fh, crop, cx, cy),
            })
            .collect();
        let request = Frame::InferRequest {
            request_id: 0,
            frame_w: fw,
            frame_h: fh,
            crop_size: crop as u32,
            crops,
        };
        let wire_bytes = protocol_encode(&request)?;
        let Frame::InferRequest {
            frame_w,
            frame_h,
            crops: round_tripped_crops,
            ..
        } = protocol_decode(&wire_bytes)?
        else {
            anyhow::bail!("decode returned a different Frame variant than InferRequest");
        };
        let round_tripped = run_cascade_inference_all_from_raw_crops(
            &mut session,
            frame_w,
            frame_h,
            &round_tripped_crops,
        )?;

        assert_exact_match(frame_path, &direct, &round_tripped);
        eprintln!(
            "PASS: {} — {} crops, exact match after wire round-trip",
            frame_path.display(),
            direct.len()
        );
    }

    eprintln!(
        "PASS: all {} frames — wire codec is lossless for real captured crop data",
        frames.len()
    );
    Ok(())
}
