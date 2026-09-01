//! Proves `with_verifier_session`'s own documented graceful-degradation
//! claim ("Returns `Ok(None)` ... if the model file is missing or fails
//! to load") actually holds for a genuinely broken `ORT_DYLIB_PATH`, not
//! just a disabled cascade — the real gap found live while working on
//! task_d06561d91f58: `ort`'s own dylib loading PANICS on this failure
//! rather than returning an `Err`, which previously crashed the whole
//! process instead of degrading gracefully.
//!
//! Deliberately a SEPARATE integration-test file (its own process, per
//! Cargo's own `tests/*.rs` convention) rather than a `#[test]` inside
//! `cursor_ml_detect.rs`'s own `mod tests`: `ort::init().commit()` is a
//! real, process-global, one-shot operation — once anything in a process
//! has successfully initialized it, later calls are silent no-ops
//! (confirmed in `with_verifier_session`'s own doc comment), so this test
//! MUST run in a process where nothing has already loaded a real
//! onnxruntime dylib, or it wouldn't actually exercise the failure path
//! it claims to. A dedicated single-test process (Cargo's own convention
//! for `tests/`) is the only way to guarantee that, rather than hoping
//! test execution order/isolation happens to cooperate inside a shared
//! `cargo test` process alongside the crate's other (many) unit tests.
//!
//! Deliberately SETS `ORT_DYLIB_PATH` to a bogus path (not just leaves it
//! unset) — deterministic regardless of whatever the ambient shell/CI
//! environment happens to have configured; an "unset" version of this
//! test could accidentally pass without testing anything real if some
//! environment variable were already set globally, or fail to even
//! reach the intended failure mode.

use pikvm_mcp_detection_vision::cursor_ml_detect::{
    find_cursor_by_v8_full_frame, V8FullFrameOptions,
};

fn uniform_jpeg(width: u32, height: u32, gray: u8) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(width, height, image::Rgb([gray, gray, gray]));
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("encode uniform test JPEG");
    buf.into_inner()
}

#[test]
fn a_genuinely_broken_ort_dylib_path_degrades_gracefully_instead_of_panicking() {
    // SAFETY (env mutation in tests): this file is its own single-test
    // process (see module doc) — no other test in this binary could
    // observe or race on this env var.
    std::env::set_var(
        "ORT_DYLIB_PATH",
        "/definitely/does/not/exist/libonnxruntime.dylib",
    );

    let jpeg = uniform_jpeg(64, 64, 128);
    // Cascade left at its default (ENABLED) — this must reach
    // `with_verifier_session` and hit the real dylib-load failure, not
    // short-circuit past it the way the disabled-cascade test does.
    let result = find_cursor_by_v8_full_frame(&jpeg, 64, 64, V8FullFrameOptions::default());

    // The real assertion: this call must return, not panic. If it
    // panics, the test harness reports this test as failed with the
    // panic message — proving the regression directly rather than via a
    // separate catch_unwind wrapper here (a real panic escaping to the
    // test runner IS the failure signal Cargo already understands).
    let result =
        result.expect("must not error — a broken dylib is documented as Ok(None), not Err");
    assert!(
        result.is_none(),
        "no real onnxruntime was loadable, so no real detection could have happened"
    );
}
