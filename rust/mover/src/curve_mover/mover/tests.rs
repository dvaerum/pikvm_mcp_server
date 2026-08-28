//! Integration tests for `move_by_curve_one_shot`. Faithful port of
//! `curve-mover.correction-gate.test.ts`'s integration describe block
//! and `curve-mover.scaley-drift.test.ts`'s wiring test — driven with an
//! injected `detect` seam (no onnxruntime) + a recording stub client.
//! `emit_pace_ms`/`settle_ms` are set to 0 in every test (this port's
//! equivalent of the TS suite's `vi.useFakeTimers()` — there's no
//! virtual-clock mock for `tokio::time::sleep` as simple as skipping the
//! real delay entirely, and these tests exercise gate/plan LOGIC, not
//! timing).

use super::*;
use pikvm_mcp_kvmd_client::client::{PiKVMConfig, RequestArgs, RequestFn, ResponseBody};
use std::sync::Mutex as StdMutex;

fn parse_delta(path: &str) -> (f64, f64) {
    let mut dx = 0.0;
    let mut dy = 0.0;
    for pair in path.split('?').nth(1).unwrap_or("").split('&') {
        if let Some(v) = pair.strip_prefix("delta_x=") {
            dx = v.parse().unwrap();
        } else if let Some(v) = pair.strip_prefix("delta_y=") {
            dy = v.parse().unwrap();
        }
    }
    (dx, dy)
}

type Moves = Arc<StdMutex<Vec<(f64, f64)>>>;

/// A real, tiny, decodable JPEG — `client.screenshot()` decodes the
/// buffer for its own `screenshot_width`/`screenshot_height` fields
/// (`image::load_from_memory`), so a placeholder byte string errors
/// rather than being ignored. `detect` is faked in every test here and
/// never reads this buffer's actual content.
fn placeholder_jpeg() -> Vec<u8> {
    let img: image::RgbImage = image::ImageBuffer::from_pixel(4, 4, image::Rgb([0, 0, 0]));
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
    encoder.encode_image(&img).unwrap();
    buf
}

/// The TS suites' `RecordingClient`: a fixed 1920x1080 resolution, a
/// fixed (meaningless — `detect` is faked, never really decodes it)
/// screenshot buffer, and every `mouse_move_relative` call recorded.
fn stub_client() -> (Arc<PiKVMClient>, Moves) {
    let moves: Moves = Arc::new(StdMutex::new(Vec::new()));
    let moves_bg = moves.clone();
    let request_fn: RequestFn = Arc::new(move |args: RequestArgs| {
        let moves = moves_bg.clone();
        Box::pin(async move {
            if args.path.starts_with("/hid/events/send_mouse_relative") {
                moves.lock().unwrap().push(parse_delta(&args.path));
                return Ok(ResponseBody::Empty);
            }
            if args.path.starts_with("/streamer/snapshot") {
                return Ok(ResponseBody::Image(placeholder_jpeg()));
            }
            if args.path == "/streamer" {
                return Ok(ResponseBody::Json(serde_json::json!({
                    "ok": true,
                    "result": { "streamer": { "source": { "online": true, "resolution": { "width": 1920, "height": 1080 } } } }
                })));
            }
            Ok(ResponseBody::Empty)
        })
    });
    let client = Arc::new(PiKVMClient::with_request_fn(
        PiKVMConfig::new("http://127.0.0.1:1", "admin", "pw"),
        None,
        request_fn,
    ));
    (client, moves)
}

/// A scripted `DetectFn`: returns `seq[i]` on the `i`-th call, clamped
/// to the last entry once exhausted — the TS suites'
/// `detectSeq[Math.min(i++, detectSeq.length - 1)]`. Ignores its own
/// params entirely, same as the TS fake.
fn sequenced_detect(seq: Vec<Option<Point>>) -> DetectFn {
    let i = Arc::new(StdMutex::new(0usize));
    let seq = Arc::new(seq);
    Arc::new(move |_client, _min_presence, _hint| {
        let i = i.clone();
        let seq = seq.clone();
        Box::pin(async move {
            let mut idx = i.lock().unwrap();
            let at = (*idx).min(seq.len() - 1);
            *idx += 1;
            Ok(seq[at])
        })
    })
}

fn fast_opts(extra: CurveOneShotOptions) -> CurveOneShotOptions {
    CurveOneShotOptions {
        emit_pace_ms: Some(0),
        settle_ms: Some(0),
        ..extra
    }
}

const TARGET: Point = Point { x: 800.0, y: 600.0 };
const START: Point = Point { x: 100.0, y: 100.0 };

/// A detected landing `px` pixels from TARGET (offset along +x).
fn landed_at(px: f64) -> Point {
    Point {
        x: TARGET.x + px,
        y: TARGET.y,
    }
}

async fn run(detect_seq: Vec<Option<Point>>, options: CurveOneShotOptions) -> MoveToResult {
    let (client, _moves) = stub_client();
    let deps = CurveOneShotDeps {
        detect: Some(sequenced_detect(detect_seq)),
    };
    move_by_curve_one_shot(&client, TARGET, fast_opts(options), deps)
        .await
        .unwrap()
}

/// Faithful port of `curve-mover.correction-gate.test.ts`'s
/// `moveByCurveOneShot — correction fires iff the shot would otherwise
/// skip (f=1.0)` describe block.
mod correction_fires_iff_would_otherwise_skip {
    use super::*;

    #[tokio::test]
    async fn a_25_3px_residual_above_accept_25_the_failing_case_takes_one_correction_lands_clean() {
        let r = run(
            vec![Some(START), Some(landed_at(25.3)), Some(landed_at(0.2))],
            CurveOneShotOptions {
                accept_gate_px: Some(25.0),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.chunk_count, 2); // the correction shot ran
        assert!(r.final_residual_px.unwrap() < 1.0);
    }

    #[tokio::test]
    async fn an_already_accepted_18px_residual_below_accept_25_does_not_correct_no_wasted_cycle() {
        let r = run(
            vec![Some(START), Some(landed_at(18.0))],
            CurveOneShotOptions {
                accept_gate_px: Some(25.0),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.chunk_count, 1); // 18 <= 25 passes; f=1.0 does not secretly tighten it
        assert!((r.final_residual_px.unwrap() - 18.0).abs() < 0.5);
    }

    #[tokio::test]
    async fn lowering_the_acceptance_gate_auto_tightens_via_the_same_knob_18px_now_corrects_when_accept_15(
    ) {
        let r = run(
            vec![Some(START), Some(landed_at(18.0)), Some(landed_at(0.3))],
            CurveOneShotOptions {
                accept_gate_px: Some(15.0),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.chunk_count, 2); // 18 > 15 => would skip => corrects
        assert!(r.final_residual_px.unwrap() < 1.0);
    }

    #[tokio::test]
    async fn a_residual_above_the_fp_cap_100px_does_not_correct_the_correct_max_px_guard_stands() {
        let r = run(
            vec![Some(START), Some(landed_at(100.0))],
            CurveOneShotOptions {
                accept_gate_px: Some(25.0),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.chunk_count, 1); // V8 false-positive territory — trust the first shot
        assert!((r.final_residual_px.unwrap() - 100.0).abs() < 0.5);
    }

    #[tokio::test]
    async fn correct_gate_px_infinity_disables_the_correction_pure_open_loop_shot_even_at_28px() {
        // The cap must NOT clamp a non-finite override down to the
        // acceptance gate — that silently corrupts open-loop
        // measurement.
        let r = run(
            vec![Some(START), Some(landed_at(28.0))],
            CurveOneShotOptions {
                accept_gate_px: Some(25.0),
                correct_gate_px: Some(f64::INFINITY),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.chunk_count, 1); // no correction fired — raw open-loop residual preserved
        assert!((r.final_residual_px.unwrap() - 28.0).abs() < 0.5);
    }

    #[tokio::test]
    async fn a_nan_correct_gate_px_does_not_silently_disable_the_correction_falls_back_to_derived()
    {
        // Only INFINITY is the disable sentinel; a garbage knob must not
        // quietly drop the safety net. NaN => derived gate 25 => a
        // 25.3px dead-band shot still corrects.
        let r = run(
            vec![Some(START), Some(landed_at(25.3)), Some(landed_at(0.2))],
            CurveOneShotOptions {
                accept_gate_px: Some(25.0),
                correct_gate_px: Some(f64::NAN),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.chunk_count, 2);
        assert!(r.final_residual_px.unwrap() < 1.0);
    }

    #[tokio::test]
    async fn floor_collision_a_sub_floor_acceptance_5px_takes_one_correction_lands_at_the_8px_floor_does_not_spin(
    ) {
        // acceptance below the achievable precision => derived gate = 8
        // (floor). An 18px shot corrects once -> ~8px; the mover allows
        // exactly ONE correction (no loop).
        let r = run(
            vec![
                Some(START),
                Some(landed_at(18.0)),
                Some(landed_at(8.0)),
                Some(landed_at(8.0)),
            ],
            CurveOneShotOptions {
                accept_gate_px: Some(5.0),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.chunk_count, 2); // exactly one correction — never a spin
        assert!((r.final_residual_px.unwrap() - 8.0).abs() < 0.5);
    }

    #[tokio::test]
    async fn an_explicit_over_gate_correct_gate_px_is_capped_at_the_acceptance_gate() {
        // correct_gate_px=30 would reopen the [25,30) dead band; capped
        // to accept=25, so a 25.3px shot still corrects.
        let r = run(
            vec![Some(START), Some(landed_at(25.3)), Some(landed_at(0.2))],
            CurveOneShotOptions {
                accept_gate_px: Some(25.0),
                correct_gate_px: Some(30.0),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.chunk_count, 2);
        assert!(r.final_residual_px.unwrap() < 1.0);
    }
}

/// Faithful port of `curve-mover.scaley-drift.test.ts`'s
/// `moveByCurveOneShot — the Y drift compensation is applied BY DEFAULT`
/// describe block.
mod y_drift_compensation_applied_by_default {
    use super::*;

    const Y_TARGET: Point = Point { x: 100.0, y: 800.0 }; // pure-Y long move (dy=700)
    const Y_START: Point = Point { x: 100.0, y: 100.0 };

    /// Land exactly on target so no correction fires — isolate the
    /// first shot's plan. Returns the summed Y-emit magnitude.
    async fn y_mickeys(options: CurveOneShotOptions) -> f64 {
        let (client, moves) = stub_client();
        let deps = CurveOneShotDeps {
            detect: Some(sequenced_detect(vec![Some(Y_START), Some(Y_TARGET)])),
        };
        move_by_curve_one_shot(&client, Y_TARGET, fast_opts(options), deps)
            .await
            .unwrap();
        // emit_toward emits X (dy=0) then Y (dx=0); sum the Y-emit
        // magnitude.
        let sum: f64 = moves
            .lock()
            .unwrap()
            .iter()
            .filter(|&&(_, dy)| dy != 0.0)
            .map(|&(_, dy)| dy.abs())
            .sum();
        sum
    }

    #[tokio::test]
    async fn the_default_plan_emits_fewer_y_mickeys_than_an_uncompensated_curve_scale_y_1_plan() {
        let with_default = y_mickeys(CurveOneShotOptions::default()).await; // uses DEFAULT_CURVE_SCALE_Y
        let uncompensated = y_mickeys(CurveOneShotOptions {
            curve_scale_y: Some(1.0),
            ..Default::default()
        })
        .await;
        // scale > 1 => D = |dy| / scale is smaller => shorter plan =>
        // compensates the Y overshoot.
        assert!(with_default < uncompensated);
    }
}
