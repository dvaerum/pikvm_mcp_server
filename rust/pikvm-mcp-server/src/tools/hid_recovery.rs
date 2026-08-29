//! Faithful port of `index.ts`'s `handle_pikvm_hid_recover`/
//! `handle_pikvm_usb_reconnect`.
//!
//! `describeHidDiagnosis(diagnoseHidFromClient(...))`'s failure-path
//! diagnosis enrichment IS wired — correcting an earlier session's own
//! mistaken assumption that `hid_diagnosis::CursorLocator` was the large
//! multi-detector struct from `cursor_locator.rs`. It's actually the
//! same simple `Fn(buffer) -> Option<{x,y}>` closure `health-check.ts`'s
//! own `CursorLocator` type already uses — unblocked the moment
//! `default_cursor_locator` landed for `pikvm_health_check`.

use std::sync::Arc;

use pikvm_mcp_ipad_hid::hid_diagnosis::{
    default_cursor_locator, describe_hid_diagnosis, HidDiagnosisClient,
};
use pikvm_mcp_ipad_hid::hid_recovery::{
    make_behavioral_verifier, make_http_recovery_trigger, make_udc_state_reader, recover_hid,
    BehavioralVerifierOptions, HidRecoveryClient, RecoverOpts, ResetHidOpts,
};
use pikvm_mcp_kvmd_client::client::{HidProfile, PiKVMClient};

use crate::server::SharedState;
use crate::tool_helpers::{validate_boolean, validate_number};
use crate::tools::{BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "pikvm_hid_recover",
            description: "Full HID recovery ladder R0-R4 (soft reset -> soft_connect -> udc-rebind -> reboot -> \
                           human), verified BEHAVIORALLY (the online flags lie)."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "maxRung": {"type": "number", "description": "1-4. Default 3 (no reboot)."},
                    "allowReboot": {"type": "boolean", "description": "Permit the destructive R3b reboot rung."}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(hid_recover(shared, args))),
        },
        ToolEntry {
            name: "pikvm_usb_reconnect",
            description: "Standard 2-rung recovery (soft_connect -> udc-rebind, no reboot, no kvmd no-op soft \
                           reset)."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "settleMs": {"type": "number", "description": "0-120000."}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(usb_reconnect(shared, args))),
        },
    ]
}

/// Adapt the real `PiKVMClient` into `HidRecoveryClient`'s injected-
/// closure shape — the same crate-boundary DI adaptation this port has
/// used repeatedly (see `cursor_anchor.rs`'s own header comment for the
/// precedent).
fn hid_recovery_client(client: Arc<PiKVMClient>) -> HidRecoveryClient {
    let profile_client = client.clone();
    let reset_client = client.clone();
    let shot_client = client.clone();
    let move_client = client.clone();
    HidRecoveryClient::new(
        move || {
            let client = profile_client.clone();
            Box::pin(async move { Ok(hid_online_state(client.get_hid_profile().await?)) })
        },
        move |opts: ResetHidOpts| {
            let client = reset_client.clone();
            Box::pin(async move {
                let profile = client
                    .reset_hid(Some(pikvm_mcp_kvmd_client::client::ResetHidOptions {
                        reconnect_usb: opts.reconnect_usb,
                        settle_ms: opts.settle_ms,
                    }))
                    .await?
                    .expect("reset_hid(Some(_)) always returns Some");
                Ok(hid_online_state(profile))
            })
        },
        move || {
            let client = shot_client.clone();
            Box::pin(async move { Ok(client.screenshot(None).await?.buffer) })
        },
        move |dx: i32, dy: i32| {
            let client = move_client.clone();
            Box::pin(async move { Ok(client.mouse_move_relative(dx as f64, dy as f64).await?) })
        },
    )
}

/// Adapt the real `PiKVMClient` into `HidDiagnosisClient`'s injected-
/// closure shape — same DI-adaptation pattern as `hid_recovery_client`.
fn hid_diagnosis_client(client: Arc<PiKVMClient>) -> HidDiagnosisClient {
    let shot_client = client.clone();
    let profile_client = client;
    HidDiagnosisClient::new(
        move || {
            let client = shot_client.clone();
            Box::pin(async move { Ok(client.screenshot(None).await?.buffer) })
        },
        move || {
            let client = profile_client.clone();
            Box::pin(async move {
                let p = client.get_hid_profile().await?;
                Ok(pikvm_mcp_ipad_hid::hid_diagnosis::HidProfile {
                    mouse_online: p.mouse_online,
                    keyboard_online: p.keyboard_online,
                    mouse_absolute: p.mouse_absolute,
                })
            })
        },
    )
}

fn hid_online_state(p: HidProfile) -> pikvm_mcp_ipad_hid::hid_recovery::HidOnlineState {
    pikvm_mcp_ipad_hid::hid_recovery::HidOnlineState {
        online: p.online,
        mouse_online: p.mouse_online,
        keyboard_online: p.keyboard_online,
    }
}

/// Faithful port of `getRecoveryTrigger()`: HTTP wins if configured (the
/// appliance's authenticated loopback endpoint), else SSH ([user@]host —
/// stock PiKVM has no such endpoint). Constructed once per call rather
/// than memoized module-globally like the TS source — cheap (no I/O
/// until actually escalated) and avoids adding yet another `OnceCell` to
/// `SharedState` for something call-site-local.
fn build_recovery_trigger() -> pikvm_mcp_ipad_hid::hid_recovery::RecoveryTrigger {
    let url = std::env::var("PIKVM_HID_RECOVERY_URL")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if let Some(url) = url {
        let token = std::env::var("PIKVM_HID_RECOVERY_TOKEN").ok();
        let verify_ssl = std::env::var("PIKVM_HID_RECOVERY_VERIFY_SSL").as_deref() == Ok("true");
        return make_http_recovery_trigger(Some(url), token, verify_ssl);
    }
    let host = std::env::var("PIKVM_HID_RECOVERY_SSH").ok();
    let udc = std::env::var("PIKVM_HID_RECOVERY_UDC").ok();
    match pikvm_mcp_ipad_hid::hid_recovery::make_ssh_recovery_trigger(host, udc, None, None, 5000) {
        Ok(trigger) => trigger,
        Err(e) => {
            eprintln!("[hid-recovery] refusing unsafe SSH recovery config: {e}");
            make_http_recovery_trigger(None, None, false) // unconfigured
        }
    }
}

/// `pub(super)`: also reused by `tools/health_check.rs` (its own `udcState`
/// input, matching index.ts's shared `getUdcStateReader()`).
pub(super) fn build_udc_state_reader() -> pikvm_mcp_ipad_hid::hid_recovery::UdcStateReaderFn {
    let url = std::env::var("PIKVM_HID_RECOVERY_URL")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if let Some(url) = url {
        let token = std::env::var("PIKVM_HID_RECOVERY_TOKEN").ok();
        let verify_ssl = std::env::var("PIKVM_HID_RECOVERY_VERIFY_SSL").as_deref() == Ok("true");
        return make_udc_state_reader(Some(url), token, verify_ssl);
    }
    let host = std::env::var("PIKVM_HID_RECOVERY_SSH").ok();
    let udc = std::env::var("PIKVM_HID_RECOVERY_UDC").ok();
    match pikvm_mcp_ipad_hid::hid_recovery::make_ssh_udc_state_reader(host, udc, None, 5000) {
        Ok(reader) => reader,
        Err(_) => Arc::new(|| Box::pin(async { None })),
    }
}

fn hid_recover(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let max_rung = validate_number(&args, "maxRung", Some(1.0), Some(4.0))
            .map(|v| v as u8)
            .unwrap_or(3);
        let allow_reboot = validate_boolean(&args, "allowReboot").unwrap_or(false);

        let client = hid_recovery_client(shared.client.clone());
        let verifier =
            make_behavioral_verifier(client.clone(), BehavioralVerifierOptions::default());
        let trigger = build_recovery_trigger();
        let result = recover_hid(
            &client,
            &trigger,
            &verifier,
            RecoverOpts {
                max_rung,
                allow_reboot,
                ..Default::default()
            },
        )
        .await;

        let mut lines = Vec::new();
        if !result.target_present {
            lines.push(
                "R0 target NOT present (no screenshot / HDMI) — no HID rung can run.".to_string(),
            );
        } else if result.initially_broken {
            lines.push(format!(
                "HID flags reported broken. Escalated up to rung {max_rung}{} verifying behaviorally after each:",
                if allow_reboot { " (reboot permitted)" } else { "" }
            ));
        } else {
            lines.push(
                "HID flags reported OK; behavioral check confirmed it — nothing to recover."
                    .to_string(),
            );
        }
        for a in &result.attempts {
            let status = if a.recovered {
                "RECOVERED"
            } else if a.performed {
                "no change"
            } else {
                "skipped/unavailable"
            };
            lines.push(format!(
                "  {} ({}): {status} — {}",
                a.rung, a.action, a.detail
            ));
        }
        lines.push(format!(
            "→ {}.",
            if result.recovered {
                "RECOVERED (behavioral verify healthy)"
            } else {
                "STILL BROKEN"
            }
        ));
        if let Some(human) = &result.human_action_required {
            lines.push(format!("R4 — HUMAN ACTION REQUIRED: {human}"));
        }
        // (d): on failure, tell the operator WHICH failure mode this is —
        // a dead input path (HID DOWN → the reboot rung / re-plug make
        // sense) vs a gadget that's attached but whose pointer can't be
        // localized (usb_reconnect/reboot won't help; wake the cursor or
        // fix brightness instead).
        if !result.recovered && result.target_present {
            let diag_client = hid_diagnosis_client(shared.client.clone());
            let udc_reader = build_udc_state_reader();
            let locate = default_cursor_locator();
            let diagnosis = pikvm_mcp_ipad_hid::hid_diagnosis::diagnose_hid_from_client(
                &diag_client,
                &*udc_reader,
                &locate,
            )
            .await;
            lines.push(format!("Diagnosis: {}", describe_hid_diagnosis(&diagnosis)));
        }
        if !result.recovered && result.target_present && max_rung < 4 {
            lines.push(
                "Not recovered by the allowed rungs. Reboot (R3b) worked once and is the most reliable remote \
                 option: re-run with maxRung:4, allowReboot:true (needs the host recovery trigger configured)."
                    .to_string(),
            );
        }

        Ok(ToolOutcome {
            content: vec![crate::tools::ToolContent::Text(lines.join("\n"))],
            is_error: !result.recovered,
        })
    })
}

fn usb_reconnect(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let settle_ms =
            validate_number(&args, "settleMs", Some(0.0), Some(120000.0)).map(|v| v as u64);

        let client = hid_recovery_client(shared.client.clone());
        let behavioral =
            make_behavioral_verifier(client.clone(), BehavioralVerifierOptions::default());
        let udc_reader = build_udc_state_reader();
        // Faithful port of index.ts's combined verifier: healthy requires
        // BOTH the behavioral check AND (when a UDC reader is wired) the
        // ground-truth UDC state to be online — degrades to behavioral-
        // only when the UDC-state route is unavailable.
        let verifier = pikvm_mcp_ipad_hid::hid_recovery::HidVerifier::new({
            let behavioral = std::sync::Arc::new(behavioral);
            let udc_reader = udc_reader.clone();
            move || {
                let behavioral = behavioral.clone();
                let udc_reader = udc_reader.clone();
                Box::pin(async move {
                    let beh = behavioral.verify().await;
                    let udc = udc_reader().await;
                    let healthy = beh.healthy && udc.as_ref().map(|u| u.online).unwrap_or(true);
                    pikvm_mcp_ipad_hid::hid_recovery::VerifyResult {
                        healthy,
                        detail: beh.detail,
                    }
                })
            }
        });
        let trigger = build_recovery_trigger();
        let result = recover_hid(
            &client,
            &trigger,
            &verifier,
            RecoverOpts {
                max_rung: 2,
                allow_reboot: false,
                soft_settle_ms: settle_ms,
                skip_soft_reset: true,
                ..Default::default()
            },
        )
        .await;

        let mut lines = Vec::new();
        if !result.target_present {
            lines.push(
                "R0 target NOT present (no screenshot / HDMI) — no HID rung can run.".to_string(),
            );
        }
        for a in &result.attempts {
            let status = if a.recovered {
                "RECOVERED"
            } else if a.performed {
                "no change"
            } else {
                "skipped/unavailable"
            };
            lines.push(format!(
                "  {} ({}): {status} — {}",
                a.rung, a.action, a.detail
            ));
        }
        lines.push(format!(
            "→ {}.",
            if result.recovered {
                "RECOVERED (behavioral + UDC verify healthy)"
            } else {
                "STILL BROKEN"
            }
        ));

        Ok(ToolOutcome {
            content: vec![crate::tools::ToolContent::Text(lines.join("\n"))],
            is_error: !result.recovered,
        })
    })
}
