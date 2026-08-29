//! Live-hardware gate for task_f04c3909db11's dead-zone guard
//! (`pikvm_mcp_detection_vision::orientation::point_in_known_letterbox`,
//! wired into `pikvm_mouse_move_to`/`pikvm_mouse_click_at` via
//! `mouse.rs`'s `dead_zone_warning`/`with_dead_zone_warning`). NOT a TS
//! port — this is a brand-new advisory-only safety feature, so it gets
//! its own real-hardware behavioural check rather than relying on the
//! (already real) unit tests alone.
//!
//! Drives the REAL `pikvm_mouse_move_to` tool handler through the actual
//! `tool_registry()` dispatch table — not `move_to_pixel` in isolation —
//! matching this session's "gate through the SAME entry point a user
//! hits" discipline. Moves only, no clicks (this feature is a text-only
//! addition to the response message; it changes no click/HID safety
//! logic, so a moves-only gate is sufficient to prove the wiring fires
//! correctly on real detected bounds).
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run -p pikvm-mcp-server --example dead_zone_guard_smoke

use std::sync::Arc;

use pikvm_mcp_detection_vision::orientation::{detect_ipad_bounds_from_buffer, DetectOptions};
use pikvm_mcp_foundation::config::load_config;
use pikvm_mcp_ipad_hid::hid_mode::{HidMode, HidModeResolver, HidModeResolverOpts};
use pikvm_mcp_kvmd_client::client::{create_default_belief, PiKVMClient, PiKVMConfig};
use pikvm_mcp_server::server::SharedState;
use pikvm_mcp_server::tools::ToolContent;

fn text_of(content: &[ToolContent]) -> String {
    content
        .iter()
        .filter_map(|c| match c {
            ToolContent::Text(t) => Some(t.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const WARNING_MARKER: &str = "black letterbox bar";

#[tokio::main]
async fn main() {
    let host = std::env::var("PIKVM_HOST").expect("set PIKVM_HOST");
    let username = std::env::var("PIKVM_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = std::env::var("PIKVM_PASSWORD").expect("set PIKVM_PASSWORD");
    let proxy_url = std::env::var("PIKVM_PROXY").ok();

    let full_config = load_config();
    let client_config = PiKVMConfig {
        verify_ssl: false,
        proxy_url,
        ..PiKVMConfig::new(host, username, password)
    };
    let client = PiKVMClient::new(client_config, Some(create_default_belief()));

    // Mandatory health-check FIRST: screenshot, confirm awake/unlocked
    // before running anything.
    let health = client
        .screenshot(None)
        .await
        .expect("health-check screenshot failed");
    std::fs::write("/tmp/dead_zone_guard_smoke_health.jpg", &health.buffer)
        .expect("write health-check screenshot");
    eprintln!(
        "=== HEALTH CHECK: screenshot saved to /tmp/dead_zone_guard_smoke_health.jpg — STOP AND \
         INSPECT IT before trusting this run. Confirm: iPad awake, unlocked, real home screen. ==="
    );

    // Prime the SAME last-good-bounds cache the guard reads, using the
    // SAME real detection function (`ipad_content_region_from_buffer`)
    // that already runs in production every time `pikvm_mouse_click_at`
    // hits its own brightness precheck (min_brightness>0.0, the iPad
    // policy default) or nixos-dev's auto-crop `pikvm_screenshot` runs.
    // REAL FINDING from this gate's first run: `pikvm_mouse_move_to` has
    // no brightness precheck and so never warms this cache on its own —
    // both trials came back with no warning (dead-zone target included),
    // because the cache was cold, not because the wiring is broken. This
    // explicit priming step isolates "does the guard correctly read an
    // already-warm cache" (this branch's actual scope) from "does
    // move_to's own call chain warm the cache" (it doesn't, and isn't
    // expected to — that's click_at's/auto-crop's job, not move_to's).
    let bounds = detect_ipad_bounds_from_buffer(&health.buffer, DetectOptions::default()).expect(
        "expected a real iPad content-bounds detection on the health-check frame — if this \
             fails, the health-check screen itself is probably not showing real iPad content \
             (re-check the saved screenshot)",
    );
    eprintln!("Primed orientation cache with real detected bounds: {bounds:?}");

    let mut hid_mode_resolver = HidModeResolver::new(HidModeResolverOpts {
        declared: Some(HidMode::Ipad),
        endpoint: None,
        ttl_ms: None,
        settle_window_ms: None,
        now: None,
    });
    hid_mode_resolver.resolve().await;

    let scale_learner =
        pikvm_mcp_mover::scale_learner::ScaleLearner::new(Default::default(), false);
    let shared = Arc::new(SharedState::new(
        client,
        hid_mode_resolver,
        scale_learner,
        full_config.calibration,
        None,
    ));

    let handler = shared
        .tools
        .iter()
        .find(|t| t.name == "pikvm_mouse_move_to")
        .expect("pikvm_mouse_move_to must be registered")
        .handler
        .clone();

    // Trial 1: a normal on-content target — the real detected bounds'
    // own center, guaranteed on-content by construction — must NOT carry
    // the warning.
    let mut args_content = serde_json::Map::new();
    args_content.insert("x".into(), serde_json::json!(bounds.center_x as f64));
    args_content.insert("y".into(), serde_json::json!(bounds.center_y as f64));
    let result_content = handler(shared.clone(), args_content)
        .await
        .expect("move to on-content target failed");
    let text_content = text_of(&result_content.content);
    eprintln!("--- on-content move result ---\n{text_content}\n---");
    let false_positive = text_content.contains(WARNING_MARKER);

    // Trial 2: a target derived from the SAME real detected bounds (not
    // a hardcoded guess) — clearly left of the content's left edge when
    // there's room for it, else clearly right of the content's right
    // edge. Either way it's guaranteed in-frame (clamped to the real
    // resolution) and guaranteed outside `bounds`.
    let (frame_w, _frame_h) = bounds.resolution;
    let dead_zone_x = if bounds.x > 50 {
        (bounds.x - 50) as f64
    } else {
        ((bounds.x + bounds.width + 50).min(frame_w.saturating_sub(1))) as f64
    };
    let mut args_deadzone = serde_json::Map::new();
    args_deadzone.insert("x".into(), serde_json::json!(dead_zone_x));
    args_deadzone.insert("y".into(), serde_json::json!(bounds.center_y as f64));
    eprintln!(
        "Dead-zone trial target: ({dead_zone_x}, {})",
        bounds.center_y
    );
    let result_deadzone = handler(shared.clone(), args_deadzone)
        .await
        .expect("move to dead-zone target failed");
    let text_deadzone = text_of(&result_deadzone.content);
    eprintln!("--- dead-zone move result ---\n{text_deadzone}\n---");
    let true_positive = text_deadzone.contains(WARNING_MARKER);

    eprintln!(
        "=== RESULT: on-content false_positive={false_positive} (want false), \
         dead-zone true_positive={true_positive} (want true) ==="
    );
    if false_positive || !true_positive {
        eprintln!("=== FAIL: dead-zone guard did not behave as designed on real hardware ===");
        std::process::exit(1);
    }
    eprintln!("=== PASS ===");
}
