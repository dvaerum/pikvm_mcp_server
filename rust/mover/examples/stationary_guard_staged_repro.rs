//! Live reproduction of the K=4 stationary-guard widening (item 6,
//! docs/final-e2e-validation-sign-off-plan.md), per
//! docs/stationary-guard-staged-observation-repro-plan.md (reviewed by
//! both team members, precise ordering pinned down in commit 5921ecc).
//!
//! "Staged" means: the OBSERVATION VALUES are supplied directly by this
//! harness (mirroring the real 2026-08-29 incident's own coordinates),
//! bypassing the unreliable step (getting the real camera cascade to
//! organically reproduce this exact 3-observation shape — 3 real prior
//! attempts confirmed too much run-to-run variance). Everything else is
//! real: a real `PiKVMClient`, real HID emits via `mouse_move_relative`
//! (which forward-predicts the SAME shared belief `legacy_move.rs`'s
//! correction loop reads from), and the real, production
//! `would_reject_as_stationary` method.
//!
//! Safety: 3 real `mouse_move_relative(50.0, 0.0)` calls, all small,
//! horizontal-only, no keys, no clicks, zero interaction with
//! `cursor_anchor.rs`/`slam_to_corner` (confirmed zero shared code,
//! sign-off doc §5) — meaningfully lower risk than categories 2/5's own
//! work.
//!
//! Run: PIKVM_PROXY=http://127.0.0.1:8888 cargo run -p pikvm-mcp-mover
//!      --example stationary_guard_staged_repro

use pikvm_mcp_cursor_belief::{CursorBelief, CursorBeliefOptions, Emit, Point};
use pikvm_mcp_kvmd_client::client::{PiKVMClient, PiKVMConfig};

/// The real, documented 2026-08-29 incident's own coordinates — kept for
/// narrative continuity; `would_reject_as_stationary`'s own logic is
/// pure `Point` math, agnostic to what's actually rendered there.
const A: Point = Point {
    x: 1092.0,
    y: 979.0,
}; // dock-icon-area cluster
const B: Point = Point {
    x: 1020.0,
    y: 662.0,
}; // genuinely different ML-recovery position

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
    let client = PiKVMClient::new(config, None);

    // Step 1: health-check — confirms the device is reachable at all,
    // makes this genuinely live, not a bare unit test.
    eprintln!("=== health-check screenshot ===");
    match client.screenshot(None).await {
        Ok(shot) => {
            std::fs::write("/tmp/stationary_guard_repro_health.jpg", &shot.buffer).unwrap();
            eprintln!(
                "=== saved /tmp/stationary_guard_repro_health.jpg ({} bytes) ===",
                shot.buffer.len()
            );
        }
        Err(e) => {
            eprintln!("=== ABORT: health-check screenshot failed ({e}) — device unreachable. ===");
            std::process::exit(1);
        }
    }

    // Step 2: reset the real shared belief to a clean slate. Anchor
    // point deliberately far from both A and B so it never interferes
    // with the drift checks below (ring has 1 entry, the anchor, after
    // this — not 0; see the design doc's own precision note).
    let anchor = Point { x: 200.0, y: 200.0 };
    client.reset_belief(anchor);
    eprintln!("=== belief reset to anchor {anchor:?} ===");

    // Step 3: stage pass 1 -- accept "A".
    eprintln!("=== pass 1: real emit (50,0), then stage-accept A={A:?} ===");
    client
        .mouse_move_relative(50.0, 0.0)
        .await
        .expect("real HID emit #1 failed");
    let accepted_a = client.observe_cursor(A, 0.9, None);
    eprintln!("observe_cursor(A) accepted={accepted_a}");

    // Step 4: stage pass 2 -- accept "B". The OLD (pre-widening) design
    // would now have forgotten A entirely, remembering only B.
    eprintln!("=== pass 2: real emit (50,0), then stage-accept B={B:?} ===");
    client
        .mouse_move_relative(50.0, 0.0)
        .await
        .expect("real HID emit #2 failed");
    let accepted_b = client.observe_cursor(B, 0.9, None);
    eprintln!("observe_cursor(B) accepted={accepted_b}");

    // Step 5: THE ACTUAL TEST -- pass 3, a candidate matching A (2
    // passes back), not B. Real fresh emit satisfies min_emit_mickeys.
    eprintln!("=== pass 3: real emit (50,0), then query A={A:?} (2 passes back, not B) ===");
    client
        .mouse_move_relative(50.0, 0.0)
        .await
        .expect("real HID emit #3 failed");
    let widened_result = client.would_reject_as_stationary(A, None);
    eprintln!(
        "=== WIDENED (real client, real shared belief): would_reject_as_stationary(A) = {widened_result} (expected: true) ==="
    );

    // Step 6: the contrast, computed for real on a SEPARATE bare belief
    // -- demonstrates what the OLD, K=1-equivalent design would have
    // concluded on the exact same candidate. Order pinned down exactly
    // (predict, observe, a SECOND fresh predict, then query) -- skipping
    // the second predict would let the min_emit_mickeys gate alone force
    // `false`, proving nothing about the actual ring-size question.
    let mut old_equivalent = CursorBelief::new(CursorBeliefOptions::new(Point {
        x: 0.0,
        y: 0.0,
    }));
    old_equivalent.predict(Emit { dx: 50.0, dy: 0.0 }, None);
    let old_accepted_b = old_equivalent.observe(B, 0.9, None);
    old_equivalent.predict(Emit { dx: 50.0, dy: 0.0 }, None); // fresh emit, post-accept reset
    let old_equivalent_result = old_equivalent.would_reject_as_stationary(A, None);
    eprintln!(
        "=== OLD-EQUIVALENT (bare belief, single observation, old_accepted_b={old_accepted_b}): would_reject_as_stationary(A) = {old_equivalent_result} (expected: false) ==="
    );

    // Step 7: report both results side by side, explicit verdict.
    let pass = widened_result && !old_equivalent_result;
    eprintln!();
    eprintln!("=== RESULT ===");
    eprintln!("widened=true && old_equivalent=false is the only passing outcome.");
    eprintln!("widened={widened_result}, old_equivalent={old_equivalent_result}");
    if pass {
        eprintln!(
            "=== PASS: the widened K=4 ring, in the real production type, wired to a real \
             client, genuinely rejects a real 2-passes-back candidate that the OLD single-slot \
             design (same real code, single observation) would have missed. Item 6 confirmed \
             live. ==="
        );
    } else {
        eprintln!("=== FAIL (real, informative — not silently reinterpreted): expected widened=true, old_equivalent=false. ===");
        std::process::exit(1);
    }
}
