//! The R0-R3b HID-recovery ladder: presence gate, escalation, and the
//! post-escalation wait-for-recovery poll.
//!
//! Split out of `hid_recovery.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use std::time::Duration;

use super::types::{
    is_hid_broken, BoxFuture, HidRecoveryClient, HidVerifier, HostRecoveryAction, LadderAction,
    RecoverOpts, RecoverResult, RecoveryTrigger, ResetHidOpts, RungAttempt, RungLabel, WaitResult,
    LADDER,
};

/// R0 — target presence. Behavioral: a screenshot must return a non-empty
/// image. A dead/asleep target (no HDMI) fails here, and NO rung can recover
/// it.
pub async fn check_target_present(
    screenshot_fn: &(dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync),
) -> bool {
    match screenshot_fn().await {
        Ok(buf) => !buf.is_empty(),
        Err(_) => false,
    }
}

fn rung_of(action: LadderAction) -> RungLabel {
    match action {
        LadderAction::SoftReset => "R1",
        LadderAction::Host(HostRecoveryAction::SoftConnect) => "R2",
        LadderAction::Host(HostRecoveryAction::UdcRebind) => "R3a",
        LadderAction::Host(HostRecoveryAction::Reboot) => "R3b",
    }
}

fn action_label(action: LadderAction) -> &'static str {
    match action {
        LadderAction::SoftReset => "soft-reset",
        LadderAction::Host(h) => h.as_str(),
    }
}

pub async fn wait_for_recovery(
    verifier: &HidVerifier,
    timeout_ms: u64,
    interval_ms: u64,
) -> WaitResult {
    let start = tokio::time::Instant::now();
    let mut polls = 0u32;
    loop {
        polls += 1;
        let healthy = verifier.verify().await.healthy;
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if healthy {
            return WaitResult {
                recovered: true,
                elapsed_ms,
                polls,
            };
        }
        if elapsed_ms >= timeout_ms {
            return WaitResult {
                recovered: false,
                elapsed_ms,
                polls,
            };
        }
        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
    }
}

/// Detect (cheap flag trigger) → escalate the ladder → verify BEHAVIORALLY
/// after each rung. R0 presence-gates the whole thing; R4 (human re-plug) is
/// the honest terminal state when every allowed remote rung fails. Pure
/// orchestration over the injected client/trigger/verifier, so it is
/// unit-testable with fakes.
pub async fn recover_hid(
    client: &HidRecoveryClient,
    trigger: &RecoveryTrigger,
    verifier: &HidVerifier,
    opts: RecoverOpts,
) -> RecoverResult {
    let mut attempts = Vec::new();

    // R0 — presence gate. No rung recovers a target that isn't there.
    if !check_target_present(&*client.screenshot_fn.clone() as &_).await {
        return RecoverResult {
            target_present: false,
            initially_broken: true,
            recovered: false,
            attempts,
            human_action_required: Some(
                "Target is not present (no screenshot / HDMI). Wake or power on the target first \
                 — no HID rung can recover an absent/asleep target."
                    .to_string(),
            ),
        };
    }

    let initially_broken = match client.get_hid_profile().await {
        Ok(profile) => is_hid_broken(&profile),
        Err(_) => true,
    };
    // Cheap trigger says fine → confirm behaviorally (flags lie); if truly
    // healthy, done.
    if !initially_broken {
        let v = verifier.verify().await;
        if v.healthy {
            return RecoverResult {
                target_present: true,
                initially_broken: false,
                recovered: true,
                attempts,
                human_action_required: None,
            };
        }
    }

    let mut steps: Vec<LadderAction> = LADDER[..(opts.max_rung as usize).min(4)].to_vec();
    if opts.skip_soft_reset {
        steps.retain(|a| *a != LadderAction::SoftReset);
    }

    for action in steps {
        let rung = rung_of(action);
        let label = action_label(action);

        match action {
            LadderAction::SoftReset => {
                let _ = client
                    .reset_hid(ResetHidOpts {
                        reconnect_usb: true,
                        settle_ms: Some(opts.soft_settle_ms.unwrap_or(2000)),
                    })
                    .await;
                let v = verifier.verify().await;
                let detail = if v.healthy {
                    v.detail.clone()
                } else {
                    format!(
                        "{} (soft reset rarely fixes a controller-level drop)",
                        v.detail
                    )
                };
                attempts.push(RungAttempt {
                    rung,
                    action: label,
                    performed: true,
                    recovered: v.healthy,
                    detail,
                });
                if v.healthy {
                    return RecoverResult {
                        target_present: true,
                        initially_broken,
                        recovered: true,
                        attempts,
                        human_action_required: None,
                    };
                }
            }
            LadderAction::Host(host_action) => {
                if host_action == HostRecoveryAction::Reboot && !opts.allow_reboot {
                    attempts.push(RungAttempt {
                        rung,
                        action: label,
                        performed: false,
                        recovered: false,
                        detail:
                            "reboot skipped (allowReboot=false) — worked once but is destructive \
                                  (~30-90s); re-run with allowReboot to use it"
                                .to_string(),
                    });
                    continue;
                }
                if !trigger.configured {
                    attempts.push(RungAttempt {
                        rung,
                        action: label,
                        performed: false,
                        recovered: false,
                        detail: format!(
                            "{} unavailable: the host recovery trigger is not configured \
                             (pikvm-nixos must provide it — see docs/runbooks/hid-recovery.md)",
                            label
                        ),
                    });
                    continue;
                }
                let res = trigger.escalate(host_action).await;
                if !res.ok && host_action != HostRecoveryAction::Reboot {
                    attempts.push(RungAttempt {
                        rung,
                        action: label,
                        performed: false,
                        recovered: false,
                        detail: res.message,
                    });
                    continue;
                }
                // For reboot, the endpoint drops — wait a long window; else a
                // short one.
                let timeout_ms = if host_action == HostRecoveryAction::Reboot {
                    opts.reboot_wait_ms.unwrap_or(120_000)
                } else {
                    opts.host_wait_ms.unwrap_or(15_000)
                };
                let wait = wait_for_recovery(verifier, timeout_ms, 3_000).await;
                attempts.push(RungAttempt {
                    rung,
                    action: label,
                    performed: res.ok,
                    recovered: wait.recovered,
                    detail: format!(
                        "{} — {}",
                        res.message,
                        if wait.recovered {
                            "behavioral verify healthy"
                        } else {
                            "still not driving input (UNTESTED rung / may need next rung)"
                        }
                    ),
                });
                if wait.recovered {
                    return RecoverResult {
                        target_present: true,
                        initially_broken,
                        recovered: true,
                        attempts,
                        human_action_required: None,
                    };
                }
            }
        }
    }

    // R4 — every allowed remote rung failed. Honest terminal state.
    RecoverResult {
        target_present: true,
        initially_broken,
        recovered: false,
        attempts,
        human_action_required: Some(
            "All allowed remote rungs failed. Physical intervention required: re-plug the target \
             USB data cable (not charge-only) or power-cycle the target. Remote recovery cannot \
             always fix a controller-level HID teardown (confirmed 2026-07-22)."
                .to_string(),
        ),
    }
}
