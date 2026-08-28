//! Cursor detection via the dual-head grid cascade ONNX model.
//!
//! ┌─ THE cursor tracker (shipped, default-on, do NOT replace) ────────────────┐
//! │ `find_cursor_by_v8_full_frame()` → `run_cascade()`, model                 │
//! │ `ml/crop-heatmap.onnx`                                                    │
//! └────────────────────────────────────────────────────────────────────────────┘
//! Faithful port of `src/pikvm/cursor-ml-detect.ts`'s PURE geometry only —
//! `cascade_axis`, `build_cascade_grid`, `build_ml_hints`. These have zero
//! ONNX/inference dependency and are exactly what the existing TS test
//! suite (`cursor-ml-detect.test.ts`) covers: it does NOT exercise real
//! inference either (`runCascade`, `runCascadeInference`, `findCursorByML`,
//! `findCursorPresenceV5`, `findCursorByV8FullFrame`, `getSession`,
//! `disposeMLSession`) — those are validated exclusively via the mandatory
//! live hardware gate, never unit tests.
//!
//! The ONNX-dependent half is DEFERRED, not ported here — see the crate's
//! task note for the reasoning (a new `ort`/onnxruntime system dependency
//! is an architectural decision surfaced to the team before committing,
//! same discipline as every other crate-boundary finding this session).
//! Only `ml/crop-heatmap.onnx` (the canonical cascade verifier) is bundled
//! in this repo — the legacy v1/v5/v8/v9/v11/v12/v14 single-stage models
//! referenced elsewhere in the TS file are NOT present, confirming they are
//! vestigial/refuted paths per the file's own header, not live production
//! code that needs equal porting priority.

use crate::cursor_detect::Point;

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
}
