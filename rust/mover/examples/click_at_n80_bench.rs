//! N=80 live click-bench for `pikvm_mouse_click_at`'s Rust port —
//! task_9bb80e84c948's own regression-check mandate ("do not treat a
//! green ported-test-suite as sufficient on its own"). Runs the REAL
//! `click_at()` orchestration (safety gates included) N=80 times against
//! a fixed, safe, reversible target and reports the verified-click rate,
//! to compare against the TS baseline's own established curve-one-shot
//! numbers (docs/troubleshooting/movement-accuracy-plan.md, 2026-07-20:
//! ~98-99% production click-success, N=80).
//!
//! **N=80, not the task's own stated N≥20 floor** — this project's
//! standing rule (noise floor ±10pp at N=20) sets a stricter bar for any
//! real live-A/B verdict; manager-approved 2026-08-29.
//!
//! **Target**: Settings icon. The historical bench protocol
//! (docs/troubleshooting/2026-05-11-phase-262-current-click-rate-bench.md)
//! used (905, 800) — confirmed STALE via a fresh health-check screenshot
//! today (the home-screen layout has visibly changed since May: widgets
//! added, icon grid shifted). Re-measured via direct pixel analysis on
//! the live screenshot: **(1027, 820)**. Reusing the SAME icon the
//! established protocol used (safe, reversible, returns home cleanly),
//! just with its current real coordinate — not a newly-invented choice,
//! and not the stale one either.
//!
//! **What this bench does NOT cover** (manager-acknowledged, tracked as
//! its own follow-up task): paired iPadCollector ground-truth. The
//! `verified` signal here is `click_at`'s own pre/post-click screenshot
//! diff (`click_verify::verify_click_by_diff`) — the actual production
//! signal `pikvm_mouse_click_at` gives a caller — not an independent
//! ground-truth source. It CAN'T catch "the mover's self-report and the
//! diff both agree but both are wrong" the way iPadCollector's getCursor
//! would (that's exactly the class of bug the legacy_move_smoke.rs gate
//! caught by screenshot inspection). Per the manager's two conditions
//! (2026-08-29): every trial's verified:true/false is recorded
//! (structured, not just residual text), and a real screenshot sample is
//! saved — EVERY verified:false trial, plus a periodic sample of
//! verified:true ones — for manual visual cross-check.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 ORT_DYLIB_PATH=... \
//!   PIKVM_ML_VERIFIER_MODEL=$(pwd)/../ml/crop-heatmap.onnx \
//!   cargo run -p pikvm-mcp-mover --example click_at_n80_bench

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use pikvm_mcp_detection_vision::brightness::VERY_DIM_THRESHOLD;
use pikvm_mcp_ipad_hid::hid_mode::{HidMode, HidPolicy, Strategy};
use pikvm_mcp_kvmd_client::client::{MouseButton, PiKVMClient, PiKVMConfig};
use pikvm_mcp_mover::click_at::{click_at, ClickAtDeps, ClickAtOutcome, ClickAtRequest};
use pikvm_mcp_mover::ipad_unlock::{ipad_go_home, IpadHomeOptions};
use pikvm_mcp_mover::move_to::Point;
use pikvm_mcp_mover::scale_learner::{ScaleLearner, ScaleLearnerOpts};

const N: u32 = 80;
const TARGET: Point = Point {
    x: 1027.0,
    y: 820.0,
};
const OUT_DIR: &str = "/tmp/click-at-n80-bench";
/// Save every Nth verified:true trial's screenshot (in addition to
/// EVERY verified:false one) so the sample is real, not 1-2 trials.
const SAMPLE_EVERY: u32 = 5;

/// Real production iPad policy (mode=Ipad, mouse_absolute=false),
/// matching `HidModeResolver::policy()`'s own iPad branch exactly
/// (`resolver.rs`) rather than going through a live `/hidmode` endpoint
/// resolution for this bench script.
fn ipad_policy() -> HidPolicy {
    HidPolicy {
        mode: HidMode::Ipad,
        mouse_absolute: false,
        strategy: Strategy::CurveOneShot,
        forbid_slam_fallback: true,
        forbid_slam_on_ipad: true,
        chunk_pace_ms: Some(100),
        max_residual_px: Some(15.0),
        dim_threshold: VERY_DIM_THRESHOLD,
        apply_tap_bias: true,
    }
}

struct TrialResult {
    trial: u32,
    verified: bool,
    message: String,
}

fn outcome_parts(outcome: &ClickAtOutcome) -> (bool, String, Vec<u8>) {
    match outcome {
        ClickAtOutcome::Clicked {
            message,
            screenshot,
            ..
        } => {
            let verified = message.contains("triggered visible screen change");
            (verified, message.clone(), screenshot.clone())
        }
        ClickAtOutcome::CursorUnverified {
            message,
            screenshot,
            ..
        } => (false, message.clone(), screenshot.clone()),
        ClickAtOutcome::ResidualSkip {
            message,
            screenshot,
            ..
        } => (false, message.clone(), screenshot.clone()),
        ClickAtOutcome::BrightnessAbort { message, .. } => (false, message.clone(), Vec::new()),
        ClickAtOutcome::ModeUnknown { message } | ClickAtOutcome::Error { message } => {
            (false, message.clone(), Vec::new())
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

    // Mandatory health-check FIRST: screenshot, confirm awake/unlocked/
    // real home screen before running anything — screenshots are source
    // of truth, never trust a flag.
    let health = client
        .screenshot(None)
        .await
        .expect("health-check screenshot failed");
    let health_path = format!("{OUT_DIR}/00-health-check.jpg");
    std::fs::write(&health_path, &health.buffer).expect("write health-check screenshot");
    eprintln!(
        "=== HEALTH CHECK: screenshot saved to {health_path} — STOP AND INSPECT IT before letting \
         this run proceed. Confirm: iPad awake, unlocked, on the real home screen, Settings icon \
         visible near ({}, {}). ===",
        TARGET.x, TARGET.y
    );
    eprintln!(
        "=== click_at_n80_bench: N={N} target=({},{}) ===",
        TARGET.x, TARGET.y
    );

    // #41 passive scale learner: OFF (matches the shipped production
    // default — opt-in only via PIKVM_MOVER_LEARN=1). A bench measuring
    // the CURRENT baseline shouldn't have its own trials feeding back
    // into the scale it's being measured against.
    let scale_learner = StdMutex::new(ScaleLearner::new(ScaleLearnerOpts::default(), false));

    let mut results: Vec<TrialResult> = Vec::with_capacity(N as usize);

    for trial in 1..=N {
        if let Err(e) = ipad_go_home(
            &client,
            IpadHomeOptions {
                force_home_via_swipe: true,
                verbose: false,
                ..Default::default()
            },
        )
        .await
        {
            eprintln!(
                "trial {trial}/{N}: go-home FAILED: {e} — recording as unverified, continuing"
            );
            results.push(TrialResult {
                trial,
                verified: false,
                message: format!("go-home failed: {e}"),
            });
            continue;
        }

        let outcome = click_at(
            ClickAtRequest {
                client: client.clone(),
                policy: Some(ipad_policy()),
                target: TARGET,
                button: MouseButton::Left,
                strategy: None, // None -> policy.strategy (curve-one-shot)
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

        let (verified, message, screenshot) = outcome_parts(&outcome);

        let save = !verified || trial % SAMPLE_EVERY == 0;
        if save && !screenshot.is_empty() {
            let tag = if verified { "v" } else { "FAIL" };
            let path = format!("{OUT_DIR}/trial-{trial:03}-{tag}.jpg");
            if let Err(e) = std::fs::write(&path, &screenshot) {
                eprintln!("  (couldn't save screenshot: {e})");
            }
        }

        eprintln!(
            "trial {trial}/{N}: verified={verified} — {}",
            message.lines().next().unwrap_or("")
        );
        results.push(TrialResult {
            trial,
            verified,
            message,
        });

        // Brief pace between trials — let the UI settle before the next
        // go-home + click cycle.
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let verified_count = results.iter().filter(|r| r.verified).count();
    let rate = verified_count as f64 / N as f64 * 100.0;
    let failed_trials: Vec<u32> = results
        .iter()
        .filter(|r| !r.verified)
        .map(|r| r.trial)
        .collect();

    let mut report = String::new();
    report.push_str(&format!(
        "click_at_n80_bench — N={N} target=({},{})\n",
        TARGET.x, TARGET.y
    ));
    report.push_str(&format!("verified: {verified_count}/{N} ({rate:.1}%)\n"));
    report.push_str(&format!("failed trials: {failed_trials:?}\n\n"));
    for r in &results {
        report.push_str(&format!(
            "[{:03}] verified={} — {}\n",
            r.trial,
            r.verified,
            r.message.replace('\n', " | ")
        ));
    }
    let report_path = format!("{OUT_DIR}/report.txt");
    std::fs::write(&report_path, &report).expect("write report");

    eprintln!("=== RESULT: {verified_count}/{N} verified ({rate:.1}%) ===");
    eprintln!("Failed trials: {failed_trials:?}");
    eprintln!("Full report: {report_path}");
    eprintln!(
        "Screenshots saved for EVERY failed trial + every {SAMPLE_EVERY}th verified trial in {OUT_DIR} \
         — INSPECT a real sample before trusting this number, per this project's own screenshots-are-\
         source-of-truth rule."
    );
}
