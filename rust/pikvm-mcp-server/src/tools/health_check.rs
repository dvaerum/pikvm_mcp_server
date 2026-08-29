//! Faithful port of `index.ts`'s `handle_pikvm_health_check` +
//! `src/pikvm/health-check.ts`'s `runHealthCheck` orchestration.
//!
//! READ-ONLY (ADR-0002 Phase 1): takes the `HidModeResolver`'s
//! currently-known mode and reports (never reconciles/writes back) any
//! divergence against a live HID profile read. Each probe is
//! independently guarded so one failure still yields a useful partial
//! report — ported as a flat sequence of `match`-per-probe, mirroring
//! the TS source's own per-probe `try/catch` shape exactly rather than
//! propagating the first error with `?`.

use std::sync::Arc;

use pikvm_mcp_detection_vision::brightness::{
    analyze_brightness, format_brightness_report, AnalyzeBrightnessOptions, Region,
};
use pikvm_mcp_detection_vision::orientation::{
    bounds_to_region, detect_ipad_bounds_from_buffer, DetectOptions,
};
use pikvm_mcp_ipad_hid::hid_diagnosis::{
    classify_hid, default_cursor_locator, describe_hid_diagnosis, ClassifyHidInput,
};
use pikvm_mcp_ipad_hid::hid_mode::should_clear_settling_for;
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use super::hid_recovery::build_udc_state_reader;
use crate::server::SharedState;
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![ToolEntry {
        name: "pikvm_health_check",
        description: "One-call diagnostic: server version, HID mouse/keyboard online + absolute/relative mode, \
                       streamer HDMI-source online, and detected iPad bounds/orientation. Run first after \
                       deploy or when click_at misbehaves."
            .to_string(),
        input_schema: serde_json::json!({"type": "object", "properties": {}}),
        handler: Arc::new(|shared, _args| Box::pin(health_check(shared))),
    }]
}

fn health_check(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let client: Arc<PiKVMClient> = shared.client.clone();
        let mut lines = Vec::new();

        let resolver_mouse_absolute = shared
            .hid_mode_resolver
            .lock()
            .await
            .policy()
            .map(|p| p.mouse_absolute);
        lines.push(format!(
            "Server version: v{}",
            pikvm_mcp_foundation::version::VERSION
        ));
        lines.push(format!(
            "Resolver mouse mode: {}",
            match resolver_mouse_absolute {
                None => "UNKNOWN (endpoint unreachable or settling — mover ops refuse)".to_string(),
                Some(v) => v.to_string(),
            }
        ));
        if let Some(mouse_absolute) = resolver_mouse_absolute {
            lines.push(format!(
                "  → forbidSlamFallback in click_at/move_to defaults to {} (true = slam-fallback BLOCKED, safe \
                 for iPad).",
                !mouse_absolute
            ));
        }

        // Phase 189: report streamer source state up-front.
        match client.get_streamer_status().await {
            Ok((source_online, resolution)) => {
                if source_online {
                    lines.push(format!(
                        "Streamer source: online — HDMI capture has signal at {}×{}.",
                        resolution.width, resolution.height
                    ));
                } else {
                    lines.push(
                        "⚠ Streamer source: OFFLINE — no HDMI signal. The device behind the cable (iPad in our \
                         setup) has its screen off. Most common cause: the iPad is LOCKED / asleep / showing a \
                         Touch ID gate. Less commonly: powered off (dead battery), mid-reboot, or unplugged. \
                         pikvm_screenshot will return 503 UnavailableError until the screen comes back. Wake the \
                         iPad with sendKey Enter (also dismisses the lock screen on iPadOS 26 when no passcode is \
                         set) or pikvm_ipad_unlock for passcode-protected devices. Cursor/click tools are unusable \
                         in this state."
                            .to_string(),
                    );
                }
            }
            Err(e) => lines.push(format!("Streamer source state: FAILED to read ({e}).")),
        }

        // Live HID profile — re-read so a transient startup-detection
        // failure doesn't permanently mislead the operator.
        let mut hid_flags: Option<(bool, bool)> = None; // (mouse_online, keyboard_online)
        let mut hid_up: Option<bool> = None;
        match client.get_hid_profile().await {
            Ok(hid) => {
                hid_flags = Some((hid.mouse_online, hid.keyboard_online));
                hid_up = Some(hid.mouse_online || hid.keyboard_online);
                lines.push(format!(
                    "Live HID profile: mouse={}/{}, keyboard={}.",
                    if hid.mouse_online {
                        "online"
                    } else {
                        "offline"
                    },
                    if hid.mouse_absolute {
                        "absolute"
                    } else {
                        "relative"
                    },
                    if hid.keyboard_online {
                        "online"
                    } else {
                        "offline"
                    }
                ));
                if let Some(resolver_val) = resolver_mouse_absolute {
                    if hid.mouse_absolute != resolver_val {
                        lines.push(format!(
                            "  ⚠ MISMATCH: resolver mode ({resolver_val}) differs from the live profile \
                             ({}) read just now. The resolver (not this diagnostic read) is what the mover \
                             actually uses — this is report-only; nothing here writes back. See ADR 0002: for an \
                             endpoint source the resolver re-derives from the appliance /hidmode on the next \
                             mode-sensitive call or health_check, so a real mismatch should self-correct shortly; \
                             a persistent one means the appliance and the device disagree about the assembled \
                             gadget.",
                            hid.mouse_absolute
                        ));
                    }
                }
            }
            Err(e) => {
                lines.push(format!("Live HID profile: FAILED to read ({e})."));
                lines.push(format!(
                    "  → Cannot verify mouse mode from PiKVM against this diagnostic read. The resolver's mode \
                     stands (currently {}).",
                    match resolver_mouse_absolute {
                        None => "UNKNOWN".to_string(),
                        Some(v) => v.to_string(),
                    }
                ));
            }
        }

        // M4: GROUND-TRUTH USB HID gadget state.
        let udc_reader = build_udc_state_reader();
        let udc_state = udc_reader().await;
        match &udc_state {
            None => {
                lines.push(
                    "USB HID gadget: unavailable (UDC-state endpoint not configured or unreachable; falling back \
                     to the kvmd HID flags above, which may lie). Set PIKVM_HID_RECOVERY_URL to enable."
                        .to_string(),
                );
            }
            Some(udc) => {
                hid_up = Some(udc.online); // UDC ground truth overrides the advisory kvmd flags
                lines.push(format!(
                    "USB HID gadget (ground truth): {}{} — this is THE HID up/down signal.",
                    udc.state,
                    udc.udc
                        .as_ref()
                        .map(|u| format!(" [{u}]"))
                        .unwrap_or_default()
                ));
                if let Some((mouse_online, keyboard_online)) = hid_flags {
                    lines.push(format!(
                        "  kvmd HID flags: mouse={} keyboard={} (advisory — these have lied; UDC state above is \
                         ground truth).",
                        if mouse_online { "on" } else { "off" },
                        if keyboard_online { "on" } else { "off" }
                    ));
                    let flags_say_offline = !mouse_online || !keyboard_online;
                    let flags_say_online = mouse_online || keyboard_online;
                    if udc.online && flags_say_offline {
                        lines.push(
                            "  ⚠ FLAG-LIE: kvmd says HID offline but UDC is configured → HID likely UP; confirm \
                             behaviorally (move the mouse / send ⌘-H)."
                                .to_string(),
                        );
                    } else if !udc.online && flags_say_online {
                        lines.push(
                            "  ⚠ FLAG-LIE: kvmd says online but UDC not attached → HID likely DOWN; run \
                             pikvm_usb_reconnect."
                                .to_string(),
                        );
                    }
                }
                lines.push(if udc.online {
                    "  → HID verdict: UP (UDC configured).".to_string()
                } else {
                    format!(
                        "  → HID verdict: DOWN (UDC {}) → run pikvm_usb_reconnect.",
                        udc.state
                    )
                });
            }
        }

        // Capture one screenshot and reuse it for bounds + brightness so
        // we don't pay two screenshots' worth of streamer latency.
        let health_shot = match client.screenshot(None).await {
            Ok(s) => Some(s.buffer),
            Err(e) => {
                lines.push(format!(
                    "Screenshot: FAILED ({e}). Cannot run bounds or brightness checks."
                ));
                None
            }
        };

        if let Some(shot) = &health_shot {
            // (d): HID DOWN needs usb_reconnect; HID UP but cursor NOT
            // LOCALIZABLE does not. Only localize when HID might be up;
            // classify + print either way.
            let cursor = if hid_up != Some(false) {
                default_cursor_locator()(shot.clone()).await
            } else {
                None
            };
            lines.push(format!(
                "  → {}",
                describe_hid_diagnosis(&classify_hid(ClassifyHidInput {
                    hid_up,
                    cursor,
                    udc_confirmed: udc_state.is_some(),
                }))
            ));
        }

        // iPad bounds detection, scoped brightness measurement.
        if let Some(shot) = &health_shot {
            let detected_bounds = match detect_ipad_bounds_from_buffer(
                shot,
                DetectOptions {
                    verbose: false,
                    ..Default::default()
                },
            ) {
                Ok(bounds) => {
                    lines.push(format!(
                        "iPad bounds detection: {:?} {}×{} at HDMI ({},{}). The Phase 32 slam guard treats \
                         portrait bounds as iPad-letterbox.",
                        bounds.orientation, bounds.width, bounds.height, bounds.x, bounds.y
                    ));
                    Some(bounds)
                }
                Err(e) => {
                    lines.push(format!(
                        "iPad bounds detection: FAILED ({e}). Either the target isn't an iPad in letterbox, OR \
                         the screen is currently dark/uniform (e.g. lock screen, all-black canvas). Phase 32a's \
                         fail-safe still refuses slam in this state."
                    ));
                    None
                }
            };

            let region = detected_bounds.map(|b| {
                let (x, y, width, height) = bounds_to_region(&b);
                Region {
                    x,
                    y,
                    width,
                    height,
                }
            });
            match analyze_brightness(shot, AnalyzeBrightnessOptions { region }) {
                Ok(report) => {
                    lines.push(format_brightness_report(&report));
                    if region.is_some() {
                        lines.push(
                            "  (brightness measured over iPad-content region only, not the full HDMI frame — \
                             letterbox bars excluded.)"
                                .to_string(),
                        );
                    }
                }
                Err(e) => lines.push(format!("Screen brightness: FAILED to compute ({e}).")),
            }
        }

        // (#51) endpoint mode: the appliance /hidmode is authoritative,
        // so re-derive (a health_check is a natural reconnect point).
        {
            let mut resolver = shared.hid_mode_resolver.lock().await;
            if resolver.is_endpoint() {
                resolver.mark_reconnect();
                resolver.resolve().await;
                if should_clear_settling_for(udc_state.as_ref()) {
                    resolver.clear_settling();
                }
            }
        }

        Ok(ToolOutcome::text(lines.join("\n")))
    })
}
