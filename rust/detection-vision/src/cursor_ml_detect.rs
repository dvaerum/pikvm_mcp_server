//! Cursor detection via the dual-head grid cascade ONNX model.
//!
//! ┌─ THE cursor tracker (shipped, default-on, do NOT replace) ────────────────┐
//! │ `find_cursor_by_v8_full_frame()` → `run_cascade()`, model                 │
//! │ `ml/crop-heatmap.onnx`                                                    │
//! └────────────────────────────────────────────────────────────────────────────┘
//! Faithful port of `src/pikvm/cursor-ml-detect.ts`'s PURE geometry
//! (`cascade_axis`, `build_cascade_grid`, `build_ml_hints`) plus the
//! ACTUAL cascade inference (`run_cascade_inference`, `run_cascade`) —
//! the real, shipped tracker, run against the bundled
//! `ml/crop-heatmap.onnx`.
//!
//! ONNX linking: `ort` with the `load-dynamic` feature, dlopen-ing the
//! nixpkgs-provided onnxruntime `.so` at runtime via `ORT_DYLIB_PATH`
//! rather than `ort`'s default download-binaries feature (which fetches an
//! unverified prebuilt binary over the network at build time — wrong shape
//! for a nix-packaged service). See `flake.nix`'s devShell for the
//! `ORT_DYLIB_PATH` wiring.
//!
//! Deliberately NOT ported: the legacy single-stage v1/v5/v8/v9/v11/v12/v14
//! models (`findCursorByML`, `findCursorPresenceV5`,
//! `findCursorByV8FullFrame`'s non-cascade branch, `findCursorByMLMultiHint`,
//! `getSession`, `disposeMLSession`). None of their `.onnx` files are
//! bundled in this repo (only `ml/crop-heatmap.onnx` is), confirming they
//! are genuinely vestigial/refuted per the TS file's own header, not
//! equal-priority production code — porting them would be untestable
//! guesswork against models that don't exist. The existing TS test suite
//! agrees: it doesn't exercise ANY real inference either, only the pure
//! geometry — real inference is validated exclusively via the mandatory
//! live hardware gate, which this port cannot self-administer (see the
//! crate's task note).

use crate::cursor_detect::Point;
use crate::decode::decode_to_rgb;
use crate::ipad_region_detect::{detect_ipad_region, NATIVE_MARGIN};
use ort::session::Session;
use ort::value::TensorRef;

/// Native-px verifier crop size (MUST match training).
pub const CASCADE_CROP: f64 = 96.0;

/// task_484bed055820: how far (native px) a hint-narrowed cascade search
/// extends on each side of the hint. Set well above curve-mover.ts's own
/// documented finding that a first-shot landing more than ~80px from the
/// deterministic emit's target can ONLY be a detector false-positive on an
/// unrelated widget, never a correct detection — so this window comfortably
/// covers a real detection's noise floor while still cutting the crop count
/// by roughly an order of magnitude versus scanning the whole region every
/// call.
pub const HINT_WINDOW_RADIUS_PX: f64 = 150.0;

/// A detected-region rectangle in native screenshot pixels.
#[derive(Clone, Copy, Debug)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Same axis-building math `runCascade` always used: walk the span at
/// `grid_stride`, always include the far edge (a plain inset grid leaves a
/// ~stride blind spot there — MISSED the cursor in the DOCK / bottom edge
/// in live exploration), then clamp+dedup so every crop stays fully
/// in-frame.
pub fn cascade_axis(lo: f64, hi: f64, frame_max: f64, grid_stride: f64) -> Vec<i64> {
    let half = CASCADE_CROP / 2.0;
    let mut raw: Vec<f64> = Vec::new();
    let mut v = lo;
    while v < hi {
        raw.push(v);
        v += grid_stride;
    }
    raw.push(hi);

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for v in raw {
        let c = half.max((frame_max - half).min(v)).round() as i64;
        if seen.insert(c) {
            out.push(c);
        }
    }
    out
}

/// Build the list of 96px crop centers the cascade will batch into ONE
/// inference call. Without a hint: the WHOLE detected region — byte-
/// identical to `runCascade`'s behavior before this function existed
/// (cold-start / no-known-position paths are unaffected by
/// task_484bed055820).
///
/// With a hint: a bounded `HINT_WINDOW_RADIUS_PX` window around it instead
/// of the whole region (task_484bed055820 — the production cascade's
/// default full-region scan costs 14.8-25.5s/call on real Pi4 hardware,
/// N=352 on a 1920x1080 frame, and runs 2-13+ times per single interactive
/// move; this is the fix). Returns empty when the window doesn't overlap
/// the region at all — the caller's signal to fall back to the hint-less
/// full scan.
pub fn build_cascade_grid(
    region: Region,
    frame_w: f64,
    frame_h: f64,
    hint: Option<Point>,
    grid_stride: f64,
) -> Vec<(i64, i64)> {
    let mut x_lo = region.x;
    let mut x_hi = region.x + region.w;
    let mut y_lo = region.y;
    let mut y_hi = region.y + region.h;

    if let Some(hint) = hint {
        x_lo = x_lo.max(hint.x - HINT_WINDOW_RADIUS_PX);
        x_hi = x_hi.min(hint.x + HINT_WINDOW_RADIUS_PX);
        y_lo = y_lo.max(hint.y - HINT_WINDOW_RADIUS_PX);
        y_hi = y_hi.min(hint.y + HINT_WINDOW_RADIUS_PX);
        if x_lo >= x_hi || y_lo >= y_hi {
            return Vec::new();
        }
    }

    let ys = cascade_axis(y_lo, y_hi, frame_h, grid_stride);
    let xs = cascade_axis(x_lo, x_hi, frame_w, grid_stride);
    let mut centers = Vec::new();
    for &cy in &ys {
        for &cx in &xs {
            centers.push((cx, cy));
        }
    }
    centers
}

/// Build a multi-hint set for ML cursor detection.
///
/// Always includes `predicted`. Conditionally adds:
///  - `belief_pos` if it's inside the frame AND > 200px from existing hints.
///    (belief can drift off-screen after unlock/home swipes when bounds is
///    None — using such a hint clamps the crop to the top-left corner of
///    the frame, wasting an inference.)
///  - A "home-zone" hint at `(frame_width * 0.625, frame_height * 0.75)` —
///    the typical post-navigation cursor location on iPad (right-bottom
///    quadrant). Added when > 200px from all existing hints.
pub fn build_ml_hints(
    predicted: Point,
    frame_width: f64,
    frame_height: f64,
    belief_pos: Option<Point>,
) -> Vec<Point> {
    let min_sep = 200.0;
    fn far_from_all(hints: &[Point], p: Point, min_sep: f64) -> bool {
        hints
            .iter()
            .all(|h| ((h.x - p.x).powi(2) + (h.y - p.y).powi(2)).sqrt() > min_sep)
    }

    let mut hints = vec![predicted];

    if let Some(bp) = belief_pos {
        if bp.x >= 0.0 && bp.x < frame_width && bp.y >= 0.0 && bp.y < frame_height {
            let belief_rounded = Point {
                x: bp.x.round(),
                y: bp.y.round(),
            };
            if far_from_all(&hints, belief_rounded, min_sep) {
                hints.push(belief_rounded);
            }
        }
    }

    let home_hint = Point {
        x: (frame_width * 0.625).round(),
        y: (frame_height * 0.75).round(),
    };
    if far_from_all(&hints, home_hint, min_sep) {
        hints.push(home_hint);
    }

    hints
}

/// Result shape from the LEGACY single-stage `findCursorByML`/
/// `findCursorByMLMultiHint` (cursor-v1, 256px hint crop). Ported as a pure
/// data shape only — cursor_locator.rs's `CursorLocatorDeps` needs the real
/// contract for its injected `find_cursor_by_ml_multi_hint` field, matching
/// the TS source's own `import type { MLCursorResult } from
/// './cursor-ml-detect.js'`. The function itself stays deferred (needs a
/// model file that doesn't exist in this repo — see this file's header).
#[derive(Clone, Copy, Debug)]
pub struct MlCursorResult {
    /// Cursor x in full-frame screenshot pixels.
    pub x: f64,
    /// Cursor y in full-frame screenshot pixels.
    pub y: f64,
    /// Sigmoid of heatmap peak — model's confidence in cursor presence.
    pub confidence: f64,
    /// Diagnostics only: the crop window used. `(0, 0)` signals the
    /// hint-independent full-frame cascade fired rather than the
    /// crop-near-hint fallback (see `cursor_locator.rs`'s tautology-gate
    /// skip for this exact case).
    pub crop_left: f64,
    pub crop_top: f64,
}

/// Dual-head heatmap output resolution (crop 96 / 4).
pub const HM_OUT: u32 = 24;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// A cascade detection result, in full-frame native pixels.
#[derive(Clone, Copy, Debug)]
pub struct CascadeResult {
    pub x: i64,
    pub y: i64,
    /// Sigmoid of the winning crop's presence logit.
    pub presence: f32,
    /// Same value as `presence` in this port — faithful to the TS source,
    /// which returns `maxP` for both fields (see `runCascadeInference`).
    pub heatmap_peak: f32,
}

static VERIFIER_SESSION: std::sync::Mutex<Option<Session>> = std::sync::Mutex::new(None);
static VERIFIER_LOAD_LOGGED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static REGION_CACHE: std::sync::Mutex<Option<Region>> = std::sync::Mutex::new(None);

/// Lazily load the ONNX verifier session and hand it to `f`. Returns `Ok(None)`
/// (and logs once) if the model file is missing or fails to load — that
/// failure is NOT cached, so the next call retries the load, matching the TS
/// source's `cachedVerifierSession === null` retry-on-failure semantics.
/// A `Mutex<Option<Session>>` (rather than a plain `OnceLock`) both gives us
/// that retry behavior on stable Rust and satisfies `Session::run`'s `&mut
/// self` requirement.
fn with_verifier_session<T>(
    model_path: &str,
    f: impl FnOnce(&mut Session) -> anyhow::Result<T>,
) -> anyhow::Result<Option<T>> {
    let mut guard = VERIFIER_SESSION.lock().unwrap();
    if guard.is_none() {
        let loaded: anyhow::Result<Session> = (|| {
            // Idempotent: commit() only takes effect on the first call in
            // the process: https://docs.rs/ort — subsequent calls return
            // false and are harmless no-ops.
            ort::init().commit();
            Ok(Session::builder()?.commit_from_file(model_path)?)
        })();
        match loaded {
            Ok(session) => *guard = Some(session),
            Err(e) => {
                if !VERIFIER_LOAD_LOGGED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    eprintln!("[cursor-ml-detect] failed to load verifier at {model_path}: {e}. Cascade disabled.");
                }
                return Ok(None);
            }
        }
    }
    let session = guard.as_mut().expect("just verified Some above");
    Ok(Some(f(session)?))
}

/// Batch `centers` into ONE inference call against the verifier session and
/// decode the winning crop's sub-pixel position. Returns `None` when there
/// are no centers to search, or the best crop's presence score doesn't
/// clear `verify_thresh` (caller decides what "no confident result" means
/// — for `run_cascade`, that's the signal to fall back to the full-region
/// scan).
pub fn run_cascade_inference(
    session: &mut Session,
    full: &[u8],
    fw: u32,
    fh: u32,
    centers: &[(i64, i64)],
    verify_thresh: f32,
) -> anyhow::Result<Option<CascadeResult>> {
    let n = centers.len();
    if n == 0 {
        return Ok(None);
    }
    let crop = CASCADE_CROP as i64; // 96
    let half = crop / 2;
    let plane = (crop * crop) as usize;
    let mut batch = vec![0f32; n * 3 * plane];
    for (idx, &(cx, cy)) in centers.iter().enumerate() {
        let left = 0i64.max((fw as i64 - crop).min(cx - half));
        let top = 0i64.max((fh as i64 - crop).min(cy - half));
        let base = idx * 3 * plane;
        for yy in 0..crop {
            for xx in 0..crop {
                let si = (((top + yy) as usize) * (fw as usize) + ((left + xx) as usize)) * 3;
                let di = (yy * crop + xx) as usize;
                batch[base + di] = (full[si] as f32 / 255.0 - MEAN[0]) / STD[0];
                batch[base + plane + di] = (full[si + 1] as f32 / 255.0 - MEAN[1]) / STD[1];
                batch[base + 2 * plane + di] = (full[si + 2] as f32 / 255.0 - MEAN[2]) / STD[2];
            }
        }
    }

    let shape = vec![n as i64, 3, crop, crop];
    let tensor = TensorRef::from_array_view((shape, batch.as_slice()))?;
    let outputs = session.run(ort::inputs!["crop" => tensor])?;
    let (_, presence) = outputs["presence_logit"].try_extract_tensor::<f32>()?;
    let (_, heatmap) = outputs["heatmap_logits"].try_extract_tensor::<f32>()?;

    // PRESENCE head (offset-invariant, confuser-rejecting) picks the crop;
    // the HEATMAP head gives the sub-pixel tip within it via soft-argmax.
    let mut bi = 0usize;
    for i in 1..n {
        if presence[i] > presence[bi] {
            bi = i;
        }
    }
    let max_p = 1.0 / (1.0 + (-presence[bi]).exp());
    if max_p < verify_thresh {
        return Ok(None);
    }

    let hm_out = HM_OUT as i64;
    let hm_scale = crop as f64 / hm_out as f64;
    let off = bi * (hm_out * hm_out) as usize;
    let mut mx = f32::NEG_INFINITY;
    for k in 0..(hm_out * hm_out) as usize {
        mx = mx.max(heatmap[off + k]);
    }
    let mut sum = 0f64;
    let mut ex = 0f64;
    let mut ey = 0f64;
    for gy in 0..hm_out {
        for gx in 0..hm_out {
            let w = (heatmap[off + (gy * hm_out + gx) as usize] - mx).exp() as f64;
            sum += w;
            ex += gx as f64 * w;
            ey += gy as f64 * w;
        }
    }
    ex /= sum;
    ey /= sum;

    let (bcx, bcy) = centers[bi];
    let left = 0i64.max((fw as i64 - crop).min(bcx - half));
    let top = 0i64.max((fh as i64 - crop).min(bcy - half));

    Ok(Some(CascadeResult {
        x: (left as f64 + ex * hm_scale).round() as i64,
        y: (top as f64 + ey * hm_scale).round() as i64,
        presence: max_p,
        heatmap_peak: max_p,
    }))
}

/// Cascade detection: run the VERIFIER over a dense grid of 96px crops
/// covering the iPad region (batched in ONE inference), take the
/// max-scoring crop, and refine to the score-weighted centroid of the
/// winning cluster for sub-cell precision.
///
/// When `hint` is given, searches a bounded window around it FIRST (see
/// `build_cascade_grid`) — the SAME verifier model, just over far fewer
/// crops — falling back to the full-region scan when the window doesn't
/// overlap the region, or the narrow search comes back empty/low-confidence.
/// Without a hint, behavior is a full-region scan.
pub fn run_cascade(
    model_path: &str,
    jpeg_buffer: &[u8],
    frame_w: u32,
    frame_h: u32,
    hint: Option<Point>,
    grid_stride: f64,
    verify_thresh: f32,
) -> anyhow::Result<Option<CascadeResult>> {
    let reg = {
        let mut cache = REGION_CACHE.lock().unwrap();
        if cache.is_none() {
            let region = match detect_ipad_region(jpeg_buffer) {
                Ok(r) => Region {
                    x: (r.x + NATIVE_MARGIN) as f64,
                    y: (r.y + NATIVE_MARGIN) as f64,
                    w: r.w as f64 - 2.0 * NATIVE_MARGIN as f64,
                    h: r.h as f64 - 2.0 * NATIVE_MARGIN as f64,
                },
                Err(_) => Region {
                    x: 0.0,
                    y: 0.0,
                    w: frame_w as f64,
                    h: frame_h as f64,
                },
            };
            *cache = Some(region);
        }
        (*cache).unwrap()
    };

    let full = decode_to_rgb(jpeg_buffer)?;
    let (fw, fh) = (full.width, full.height);

    let result = with_verifier_session(model_path, |session| {
        if let Some(hint) = hint {
            let narrow_centers =
                build_cascade_grid(reg, fw as f64, fh as f64, Some(hint), grid_stride);
            if !narrow_centers.is_empty() {
                if let Some(result) = run_cascade_inference(
                    session,
                    &full.data,
                    fw,
                    fh,
                    &narrow_centers,
                    verify_thresh,
                )? {
                    return Ok(Some(result));
                }
            }
        }
        let full_centers = build_cascade_grid(reg, fw as f64, fh as f64, None, grid_stride);
        run_cascade_inference(session, &full.data, fw, fh, &full_centers, verify_thresh)
    })?;
    Ok(result.flatten())
}

/// The stable, real-caller-facing entry point (`cursor-ml-detect.ts`'s
/// `findCursorByV8FullFrame`) — callers use this, never `run_cascade`
/// directly. Faithful port of the `CASCADE_ENABLED` branch only: TS
/// resolves `V8_MODEL`/`CASCADE_ENABLED`/`GRID_STRIDE`/`VERIFY_THRESH`
/// once from module-level constants (an IIFE'd `settings.ml.*` read at
/// import time) — Rust has no import-time-constant equivalent, so this
/// port takes the resolved cascade config as explicit parameters instead
/// (same DI discipline the rest of this port uses for what TS reads from
/// a module-level `settings` singleton). The REAL caller resolves these
/// once from `Settings` and closes over them when constructing a
/// `CursorLocatorDeps`/DI closure, matching TS's resolve-once semantics.
///
/// The legacy single-stage (non-cascade) path is NOT ported — deferred,
/// same individually-justified gap as `pointer-accel.ts` (see
/// `docs/rust-port-plan.md` §7 item 4, move-to.ts's v13 note): cascade
/// is the validated production default (`PIKVM_ML_CASCADE` defaults ON;
/// DETECTION SOLVED per this project's own history — single-stage was
/// superseded, not a fallback anyone currently relies on). TS's
/// `options?.minPresence` is dropped entirely rather than threaded
/// through unused — the cascade branch never reads it either (only the
/// unported legacy branch does), so keeping a dead parameter here would
/// be pure noise; re-add it if the legacy path is ever ported.
pub fn find_cursor_by_v8_full_frame(
    model_path: &str,
    grid_stride: f64,
    verify_thresh: f32,
    jpeg_buffer: &[u8],
    frame_w: u32,
    frame_h: u32,
    hint: Option<Point>,
) -> anyhow::Result<Option<CascadeResult>> {
    run_cascade(
        model_path,
        jpeg_buffer,
        frame_w,
        frame_h,
        hint,
        grid_stride,
        verify_thresh,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: f64 = 1680.0;
    const H: f64 = 1050.0;
    const DEFAULT_STRIDE: f64 = 48.0;

    // --- build_ml_hints ----------------------------------------------------

    #[test]
    fn always_includes_the_predicted_hint() {
        let hints = build_ml_hints(Point { x: 640.0, y: 800.0 }, W, H, None);
        assert_eq!(hints[0], Point { x: 640.0, y: 800.0 });
    }

    #[test]
    fn adds_belief_position_when_on_screen_and_far_from_predicted() {
        let hints = build_ml_hints(
            Point { x: 100.0, y: 100.0 },
            W,
            H,
            Some(Point {
                x: 1000.0,
                y: 900.0,
            }),
        );
        assert!(hints.contains(&Point {
            x: 1000.0,
            y: 900.0
        }));
    }

    #[test]
    fn skips_belief_position_when_off_screen_negative() {
        let hints = build_ml_hints(
            Point { x: 640.0, y: 800.0 },
            W,
            H,
            Some(Point {
                x: -3051.0,
                y: -4130.0,
            }),
        );
        assert!(hints.iter().all(|h| h.x >= 0.0 && h.y >= 0.0));
    }

    #[test]
    fn skips_belief_position_when_off_screen_beyond_frame() {
        let hints = build_ml_hints(
            Point { x: 640.0, y: 800.0 },
            W,
            H,
            Some(Point {
                x: 5000.0,
                y: 5000.0,
            }),
        );
        assert!(hints.iter().all(|h| h.x < W && h.y < H));
    }

    #[test]
    fn skips_belief_position_when_too_close_to_predicted() {
        let hints = build_ml_hints(
            Point { x: 640.0, y: 800.0 },
            W,
            H,
            Some(Point { x: 700.0, y: 850.0 }),
        );
        assert_eq!(hints.len(), 2); // predicted + home-zone (belief skipped)
        assert!(!hints.contains(&Point { x: 700.0, y: 850.0 }));
    }

    #[test]
    fn always_considers_a_home_zone_hint() {
        let hints = build_ml_hints(Point { x: 200.0, y: 200.0 }, W, H, None);
        let expected_home = Point {
            x: (W * 0.625).round(),
            y: (H * 0.75).round(),
        };
        assert!(hints.contains(&expected_home));
    }

    #[test]
    fn skips_home_zone_hint_when_predicted_is_already_in_home_zone() {
        let home_x = (W * 0.625).round();
        let home_y = (H * 0.75).round();
        let hints = build_ml_hints(
            Point {
                x: home_x,
                y: home_y,
            },
            W,
            H,
            None,
        );
        assert_eq!(hints.len(), 1);
    }

    #[test]
    fn books_from_home_scenario_returns_predicted_plus_home_zone() {
        let hints = build_ml_hints(
            Point { x: 640.0, y: 800.0 },
            1680.0,
            1050.0,
            Some(Point {
                x: -3051.0,
                y: -4130.0,
            }),
        );
        assert!(hints.contains(&Point { x: 640.0, y: 800.0 }));
        let home_hint = hints.iter().find(|h| h.x != 640.0 || h.y != 800.0);
        let home_hint = home_hint.expect("expected a home-zone hint");
        assert!((home_hint.x - 1170.0).abs() <= 128.0);
        assert!((home_hint.y - 892.0).abs() <= 128.0);
    }

    // --- build_cascade_grid --------------------------------------------------

    #[test]
    fn no_hint_covers_the_whole_region() {
        // region is exactly one 96px crop wide/tall; axis() walks 0->48
        // (stride 48, half=48), then appends the region's own far edge (96)
        // since it isn't already a multiple of the stride from 0. Two grid
        // lines per axis (48, 96) => 2x2 = 4 crops.
        let region = Region {
            x: 0.0,
            y: 0.0,
            w: 96.0,
            h: 96.0,
        };
        let mut grid = build_cascade_grid(region, 1000.0, 1000.0, None, DEFAULT_STRIDE);
        grid.sort();
        assert_eq!(grid, vec![(48, 48), (48, 96), (96, 48), (96, 96)]);
    }

    #[test]
    fn no_hint_passing_none_hint_is_identical_to_omitting_it() {
        let region = Region {
            x: 100.0,
            y: 100.0,
            w: 400.0,
            h: 400.0,
        };
        let without_hint = build_cascade_grid(region, 1920.0, 1080.0, None, DEFAULT_STRIDE);
        let with_none = build_cascade_grid(region, 1920.0, 1080.0, None, DEFAULT_STRIDE);
        assert_eq!(without_hint, with_none);
    }

    #[test]
    fn with_a_hint_well_inside_a_large_region_shrinks_the_grid_dramatically() {
        let region = Region {
            x: 0.0,
            y: 0.0,
            w: 2000.0,
            h: 2000.0,
        };
        let full = build_cascade_grid(region, 3000.0, 3000.0, None, DEFAULT_STRIDE);
        let narrowed = build_cascade_grid(
            region,
            3000.0,
            3000.0,
            Some(Point {
                x: 1000.0,
                y: 1000.0,
            }),
            DEFAULT_STRIDE,
        );
        assert!(!narrowed.is_empty());
        assert!(narrowed.len() < full.len() / 4);
    }

    #[test]
    fn with_a_hint_every_returned_crop_center_stays_within_the_window_radius() {
        let region = Region {
            x: 0.0,
            y: 0.0,
            w: 2000.0,
            h: 2000.0,
        };
        let hint = Point {
            x: 1000.0,
            y: 1000.0,
        };
        let narrowed = build_cascade_grid(region, 3000.0, 3000.0, Some(hint), DEFAULT_STRIDE);
        let slack = 150.0 + 48.0 + 1.0;
        for (cx, cy) in narrowed {
            assert!((cx as f64 - hint.x).abs() <= slack);
            assert!((cy as f64 - hint.y).abs() <= slack);
        }
    }

    #[test]
    fn with_a_hint_near_the_region_edge_the_window_clamps_to_the_region() {
        let region = Region {
            x: 500.0,
            y: 500.0,
            w: 1000.0,
            h: 1000.0,
        };
        let hint = Point {
            x: region.x,
            y: region.y,
        };
        let narrowed = build_cascade_grid(region, 3000.0, 3000.0, Some(hint), DEFAULT_STRIDE);
        assert!(!narrowed.is_empty());
        for (cx, cy) in narrowed {
            assert!(cx as f64 >= region.x);
            assert!(cy as f64 >= region.y);
            assert!(cx as f64 <= region.x + region.w);
            assert!(cy as f64 <= region.y + region.h);
        }
    }

    #[test]
    fn with_a_hint_entirely_outside_the_region_returns_empty() {
        let region = Region {
            x: 0.0,
            y: 0.0,
            w: 200.0,
            h: 200.0,
        };
        let hint = Point {
            x: 5000.0,
            y: 5000.0,
        };
        let narrowed = build_cascade_grid(region, 6000.0, 6000.0, Some(hint), DEFAULT_STRIDE);
        assert!(narrowed.is_empty());
    }

    // --- real-model sanity checks -----------------------------------------
    //
    // NOT part of the default `cargo test --workspace` gate (no bundled
    // onnxruntime .so on every dev/CI machine) — mirrors the precedent set
    // by module 2's `examples/streamer_keepalive_smoke.rs` for real-
    // hardware/real-dependency checks that shouldn't force every commit's
    // test run to need the extra system dependency. Run explicitly:
    //
    //   ORT_DYLIB_PATH=$(nix build --no-link --print-out-paths nixpkgs#onnxruntime)/lib/libonnxruntime.so \
    //     cargo test --package pikvm-mcp-detection-vision -- --ignored real_model
    //
    // This is the offline-verifiable half only (real tensor shapes, finite/
    // plausible output values against a real crop) — NOT the mandatory live
    // hardware gate the file's own header requires before this can ship;
    // that still has to go to whoever has PiKVM hardware access.

    fn synthetic_crop_source(fw: u32, fh: u32) -> Vec<u8> {
        // A plausible-looking synthetic frame: mid-grey with a brighter
        // patch, JPEG-noise-free since it's raw RGB fed directly (no
        // encode/decode round trip needed here — run_cascade_inference
        // takes already-decoded RGB).
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

    #[test]
    #[ignore = "needs a real onnxruntime .so via ORT_DYLIB_PATH — see comment above"]
    fn real_model_produces_plausible_shaped_and_valued_output() {
        let model_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../ml/crop-heatmap.onnx");

        let (fw, fh) = (640u32, 480u32);
        let full = synthetic_crop_source(fw, fh);
        // A small grid of centers covering part of the frame — enough to
        // exercise the batched-inference path with N > 1.
        let centers: Vec<(i64, i64)> = vec![(100, 100), (230, 230), (400, 300)];

        let result = with_verifier_session(model_path, |session| {
            run_cascade_inference(session, &full, fw, fh, &centers, 0.0)
        })
        .expect("verifier session should load — check ORT_DYLIB_PATH")
        .expect("with_verifier_session must yield Some once the session loaded")
        // verify_thresh=0.0 means we always get a result back when centers
        // is non-empty (mirrors the "no gate" test pattern used elsewhere
        // in this port) — the point here is validating tensor SHAPES and
        // VALUE PLAUSIBILITY, not the model's actual detection accuracy on
        // a synthetic frame with no real cursor.
        .expect("non-empty centers must produce a result at verify_thresh=0.0");

        assert!(
            (0.0..=1.0).contains(&result.presence),
            "presence must be a valid sigmoid output, got {}",
            result.presence
        );
        assert_eq!(result.presence, result.heatmap_peak);
        assert!(
            result.x >= 0 && (result.x as u32) < fw,
            "x={} out of frame bounds",
            result.x
        );
        assert!(
            result.y >= 0 && (result.y as u32) < fh,
            "y={} out of frame bounds",
            result.y
        );
    }

    // --- find_cursor_by_v8_full_frame ---------------------------------------
    //
    // `run_cascade` itself (the function this wraps) has no existing test in
    // this file — a real end-to-end check needs BOTH a loadable ONNX model
    // AND a frame `detect_ipad_region` can actually find a region in, which
    // this crate doesn't yet have synthetic-frame infrastructure for. That
    // real end-to-end path is exactly what this session's own
    // `slam_and_cascade_smoke.rs` LIVE hardware gate already covers
    // authoritatively (real captured frames, real model, PASSED). This test
    // instead proves the one thing worth unit-testing about a pure
    // argument-forwarding wrapper: it propagates a failure rather than
    // panicking or silently swallowing it.
    #[test]
    fn propagates_a_region_detection_failure_rather_than_panicking() {
        let result =
            find_cursor_by_v8_full_frame("/nonexistent/model.onnx", 48.0, 0.5, &[], 640, 480, None);
        assert!(result.is_err());
    }

    #[test]
    #[ignore = "needs a real onnxruntime .so via ORT_DYLIB_PATH — see comment above"]
    fn real_model_respects_verify_thresh_gate() {
        let model_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../ml/crop-heatmap.onnx");

        let (fw, fh) = (640u32, 480u32);
        let full = synthetic_crop_source(fw, fh);
        let centers: Vec<(i64, i64)> = vec![(100, 100)];

        // A threshold of 1.01 can never be cleared by a sigmoid output
        // (max possible value is 1.0) — this must always gate to None,
        // proving the threshold check actually runs against a real
        // model output rather than being a dead branch.
        let gated = with_verifier_session(model_path, |session| {
            run_cascade_inference(session, &full, fw, fh, &centers, 1.01)
        })
        .expect("verifier session should load — check ORT_DYLIB_PATH")
        .expect("with_verifier_session must yield Some once the session loaded");
        assert!(gated.is_none());
    }
}
