//! Paired iPadCollector ground-truth bench — E2E validation category 1
//! (task_37374b4bce6d, docs/ipad-collector-ground-truth-bench-plan.md,
//! reviewed by pikvm-mcp-server@nixos-developer-system before this was
//! written). Follow-up to `click_at_n80_bench.rs`: that bench's
//! `verified` signal is `click_at`'s OWN pre/post-click screenshot diff,
//! not an INDEPENDENT ground-truth source — it can't catch "the mover's
//! self-report and the diff both agree but both are wrong," the exact
//! class of bug `legacy_move_smoke.rs` caught by screenshot cross-check
//! this same session. iPadCollector's `getTrackedCursor()` is this
//! project's own established independent ground truth for exactly this
//! reason.
//!
//! The iPad-side app relaunch (`xcrun devicectl device process launch
//! --terminate-existing --device <UDID> com.bb.iPadCollector`) must
//! happen BEFORE this binary runs, in a separate step (this binary only
//! waits for the app to connect — it does not itself relaunch anything,
//! matching the plan's own scoping and this project's established
//! relaunch dance).
//!
//! **REDESIGNED 2026-08-29** (see
//! docs/ipad-collector-showscene-redesign-plan.md, reviewed by
//! nixos-dev): the original per-trial `ipad_go_home()` call backgrounded
//! iPadCollector (`Cmd+H`), and its WS session does not survive being
//! backgrounded — confirmed live, every trial's `get_tracked_cursor`
//! broke with a broken pipe. Fixed by sending the health-check screenshot
//! as a ONE-TIME `show-scene` right after connecting, instead of
//! `ipad_go_home()` per trial: iPadCollector stays foreground for the
//! whole run, so its WS session never dies. Trade-off, stated plainly:
//! this bench now clicks a STATIC RENDERING of the home screen, not the
//! live interactive one — it proves detection/landing accuracy against
//! independent ground truth (category 1's actual sign-off bar), not
//! real app-interaction (already covered by `click_at_n80_bench.rs`).
//!
//! Per the reviewed plans:
//! - Cache-freshness: the logical->HDMI mapping step calls
//!   `clear_orientation_cache()` and takes its OWN fresh screenshot —
//!   never trusts whatever `click_at()`'s internal cycle happened to
//!   cache a moment earlier (the exact class of bug
//!   `calibrate_crop_tolerance.rs` found and fixed this session).
//! - WS-disconnect policy: one reconnect attempt on a `get_tracked_cursor`
//!   error; any trial spanning a reconnect is flagged, not silently
//!   trusted; a second consecutive failure aborts the whole run.
//! - Tolerance: the established detected->tap bias measurement, 5.9px,
//!   as the noise floor — not a guessed threshold.
//!
//! Run (after relaunching iPadCollector and confirming a fresh
//! health-check screenshot):
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 ORT_DYLIB_PATH=... \
//!   PIKVM_ML_VERIFIER_MODEL=$(pwd)/../ml/crop-heatmap.onnx \
//!   cargo run -p pikvm-mcp-mover --example ipad_collector_ground_truth_bench

use std::sync::Arc;
use std::time::Duration;

use pikvm_mcp_detection_vision::orientation::{
    clear_orientation_cache, detect_ipad_bounds_from_buffer, DetectOptions, IpadBounds,
};
use pikvm_mcp_ipad_hid::hid_mode::{HidMode, HidPolicy, Strategy};
use pikvm_mcp_kvmd_client::client::{MouseButton, PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::click_at::{click_at, ClickAtDeps, ClickAtOutcome, ClickAtRequest};
use pikvm_mcp_mover::ipad_collector::{wait_for_ipad_collector_session, IpadCollectorSession};
use pikvm_mcp_mover::move_to::Point;
use pikvm_mcp_mover::scale_learner::{ScaleLearner, ScaleLearnerOpts};

const PORT: u16 = 8767;
const N: u32 = 20;
/// Established detected->tap bias measurement (5.9px UP, N=36,
/// `onTapEvent` ground truth) — the real noise floor, not guessed.
const TOLERANCE_PX: f64 = 5.9;
const TARGET: Point = Point {
    x: 1027.0,
    y: 820.0,
};
const OUT_DIR: &str = "/tmp/ipad-collector-ground-truth-bench";

fn ipad_policy() -> HidPolicy {
    HidPolicy {
        mode: HidMode::Ipad,
        mouse_absolute: false,
        strategy: Strategy::CurveOneShot,
        forbid_slam_fallback: true,
        forbid_slam_on_ipad: true,
        chunk_pace_ms: Some(100),
        max_residual_px: Some(15.0),
        dim_threshold: pikvm_mcp_detection_vision::brightness::VERY_DIM_THRESHOLD,
        apply_tap_bias: true,
    }
}

/// Map an iPadCollector logical-pixel reading to HDMI pixels using a
/// FRESH bounds detection (never the cache `click_at()`'s own cycle may
/// have populated a moment earlier — the cache-freshness requirement
/// from the reviewed plan).
async fn map_logical_to_hdmi_fresh(
    client: &PiKVMClient,
    logical_x: f64,
    logical_y: f64,
    logical_w: f64,
    logical_h: f64,
) -> anyhow::Result<(f64, f64, IpadBounds)> {
    clear_orientation_cache();
    let shot = client.screenshot(None).await?;
    let bounds = detect_ipad_bounds_from_buffer(&shot.buffer, DetectOptions::default())?;
    let hdmi_x = bounds.x as f64 + (logical_x / logical_w) * bounds.width as f64;
    let hdmi_y = bounds.y as f64 + (logical_y / logical_h) * bounds.height as f64;
    Ok((hdmi_x, hdmi_y, bounds))
}

struct TrialResult {
    trial: u32,
    click_at_verified: bool,
    click_at_message: String,
    ground_truth: Option<(f64, f64)>,
    spans_reconnect: bool,
    disagreement_px: Option<f64>,
}

fn outcome_parts(outcome: &ClickAtOutcome) -> (bool, String) {
    match outcome {
        ClickAtOutcome::Clicked { message, .. } => (
            message.contains("triggered visible screen change"),
            message.clone(),
        ),
        ClickAtOutcome::CursorUnverified { message, .. }
        | ClickAtOutcome::ResidualSkip { message, .. }
        | ClickAtOutcome::BrightnessAbort { message, .. }
        | ClickAtOutcome::ModeUnknown { message }
        | ClickAtOutcome::Error { message } => (false, message.clone()),
    }
}

/// One reconnect attempt on a `get_tracked_cursor` error, per the
/// reviewed plan's stated disconnect policy. Returns the logical-pixel
/// reading (mapping to HDMI happens at the call site, via
/// `map_logical_to_hdmi_fresh`) plus whether a reconnect happened — the
/// caller flags any trial spanning one rather than trusting it silently.
async fn get_ground_truth_with_reconnect(
    session: &mut IpadCollectorSession,
) -> anyhow::Result<(Option<(f64, f64)>, bool)> {
    match session.get_tracked_cursor().await {
        Ok(reading) => Ok((reading.map(|c| (c.x, c.y)), false)),
        Err(first_err) => {
            eprintln!(
                "get_tracked_cursor failed ({first_err}) — attempting ONE reconnect, per the \
                 reviewed plan's stated policy"
            );
            let new_session = wait_for_ipad_collector_session(PORT, Duration::from_secs(30))
                .await
                .map_err(|reconnect_err| {
                    anyhow::anyhow!(
                        "reconnect also failed ({reconnect_err}) after the first \
                         get_tracked_cursor error ({first_err}) — aborting the whole bench run \
                         per the reviewed plan's policy, not continuing with unpaired trials"
                    )
                })?;
            *session = new_session;
            let reading = session.get_tracked_cursor().await?;
            Ok((reading.map(|c| (c.x, c.y)), true))
        }
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();

    let config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = Arc::new(PiKVMClient::new(config, None));

    std::fs::create_dir_all(OUT_DIR).expect("create output dir");

    let health = client
        .screenshot(None)
        .await
        .expect("health-check screenshot failed");
    std::fs::write(format!("{OUT_DIR}/00-health-check.jpg"), &health.buffer)
        .expect("write health-check screenshot");
    eprintln!(
        "=== HEALTH CHECK: {OUT_DIR}/00-health-check.jpg — STOP AND INSPECT before trusting this \
         run. Confirm: iPad awake, unlocked, real home screen, Settings icon near ({}, {}). ===",
        TARGET.x, TARGET.y
    );

    eprintln!("=== Waiting for iPadCollector app to connect on port {PORT} (relaunch it now if it hasn't already) ===");
    let mut session = wait_for_ipad_collector_session(PORT, Duration::from_secs(60))
        .await
        .expect("iPadCollector session never connected");
    eprintln!(
        "=== iPadCollector connected: model={}, logical {}x{} ===",
        session.hello.model, session.hello.logical_w, session.hello.logical_h
    );
    let (logical_w, logical_h) = (session.hello.logical_w, session.hello.logical_h);

    // ONE-TIME show-scene setup (redesign, 2026-08-29): the health-check
    // screenshot IS the raw captured frame (client.screenshot(None) — no
    // preview scaling), reused directly as the scene image per the
    // reviewed plan. iPadCollector stays foreground for the rest of the
    // run; no per-trial backgrounding, no per-trial re-sending.
    session
        .show_scene_image(&health.buffer)
        .await
        .expect("show-scene failed — see docs/ipad-collector-showscene-redesign-plan.md");
    eprintln!("=== show-scene applied (health-check image, {} bytes) — iPadCollector stays foreground for all {N} trials ===", health.buffer.len());

    let scale_learner =
        std::sync::Mutex::new(ScaleLearner::new(ScaleLearnerOpts::default(), false));
    let mut results: Vec<TrialResult> = Vec::with_capacity(N as usize);

    for trial in 1..=N {
        // No per-trial ipad_go_home() — the show-scene setup above
        // already put a static home-screen image on screen, and
        // iPadCollector must stay foreground for the whole run (that's
        // the entire point of the redesign: Cmd+H would background it
        // and kill its WS session again).
        let outcome = click_at(
            ClickAtRequest {
                client: client.clone(),
                policy: Some(ipad_policy()),
                target: TARGET,
                button: MouseButton::Left,
                strategy: None,
                assume_cursor_at: None,
                profile: None,
                verify_click: true,
                verify_settle_ms: 300,
                verify_region_half_px: None,
                verify_min_change_fraction: None,
                expect_region: None,
                single_tap: false,
                force: false,
                min_brightness: None,
                max_residual_px: None,
                capture: None,
                scale_learner: &scale_learner,
            },
            ClickAtDeps::default(),
        )
        .await;
        let (click_at_verified, click_at_message) = outcome_parts(&outcome);

        let (ground_truth_logical, spans_reconnect) =
            match get_ground_truth_with_reconnect(&mut session).await {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("trial {trial}/{N}: {e} — ABORTING the run.");
                    break;
                }
            };

        let (ground_truth, disagreement_px) = match ground_truth_logical {
            Some((lx, ly)) => {
                let (hx, hy, _bounds) =
                    map_logical_to_hdmi_fresh(&client, lx, ly, logical_w, logical_h)
                        .await
                        .expect("fresh bounds mapping failed");
                let disagreement = ((hx - TARGET.x).powi(2) + (hy - TARGET.y).powi(2)).sqrt();
                (Some((hx, hy)), Some(disagreement))
            }
            None => (None, None),
        };

        let flagged = disagreement_px.is_some_and(|d| d > TOLERANCE_PX) || ground_truth.is_none();
        if flagged || spans_reconnect {
            if let Ok(shot) = client.screenshot(None).await {
                let tag = if spans_reconnect {
                    "RECONNECT"
                } else {
                    "DISAGREE"
                };
                let _ = std::fs::write(
                    format!("{OUT_DIR}/trial-{trial:03}-{tag}.jpg"),
                    &shot.buffer,
                );
            }
        }

        eprintln!(
            "trial {trial}/{N}: click_at.verified={click_at_verified} ground_truth={ground_truth:?} \
             disagreement_px={disagreement_px:?} spans_reconnect={spans_reconnect}"
        );
        results.push(TrialResult {
            trial,
            click_at_verified,
            click_at_message,
            ground_truth,
            spans_reconnect,
            disagreement_px,
        });

        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let disagreeing: Vec<&TrialResult> = results
        .iter()
        .filter(|r| r.disagreement_px.is_some_and(|d| d > TOLERANCE_PX))
        .collect();
    let no_ground_truth: Vec<&TrialResult> = results
        .iter()
        .filter(|r| r.ground_truth.is_none())
        .collect();
    let spanning_reconnect: Vec<&TrialResult> =
        results.iter().filter(|r| r.spans_reconnect).collect();

    let mut report = String::new();
    report.push_str(&format!(
        "ipad_collector_ground_truth_bench — N={} completed of {N}\n",
        results.len()
    ));
    report.push_str(&format!(
        "disagreeing (> {TOLERANCE_PX}px): {} trials: {:?}\n",
        disagreeing.len(),
        disagreeing.iter().map(|r| r.trial).collect::<Vec<_>>()
    ));
    report.push_str(&format!(
        "no ground truth (iPadCollector not tracked): {} trials: {:?}\n",
        no_ground_truth.len(),
        no_ground_truth.iter().map(|r| r.trial).collect::<Vec<_>>()
    ));
    report.push_str(&format!(
        "spanning a reconnect: {} trials: {:?}\n\n",
        spanning_reconnect.len(),
        spanning_reconnect
            .iter()
            .map(|r| r.trial)
            .collect::<Vec<_>>()
    ));
    for r in &results {
        report.push_str(&format!(
            "[{:03}] click_at.verified={} ground_truth={:?} disagreement_px={:?} \
             spans_reconnect={} — {}\n",
            r.trial,
            r.click_at_verified,
            r.ground_truth,
            r.disagreement_px,
            r.spans_reconnect,
            r.click_at_message.lines().next().unwrap_or("")
        ));
    }
    let report_path = format!("{OUT_DIR}/report.txt");
    std::fs::write(&report_path, &report).expect("write report");

    eprintln!("=== RESULT: {}/{N} trials completed ===", results.len());
    eprintln!(
        "Disagreeing trials (this is the bug class this bench exists to catch): {:?}",
        disagreeing.iter().map(|r| r.trial).collect::<Vec<_>>()
    );
    eprintln!("Full report: {report_path}");
    eprintln!(
        "Screenshots saved for every disagreeing/no-ground-truth/reconnect-spanning trial in \
         {OUT_DIR} — INSPECT before trusting this number, same discipline as every other gate."
    );
}
