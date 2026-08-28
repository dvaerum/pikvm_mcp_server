//! Tests for the `hid_recovery` module family (`types`, `ladder`,
//! `http`, `ssh`). Split into its own file (Rust 2018+ submodule
//! layout) per the idiomatic-file-structure standing rule.

use super::*;
use std::sync::Arc;

fn state(mouse: bool, kb: bool) -> HidOnlineState {
    HidOnlineState {
        online: mouse || kb,
        mouse_online: mouse,
        keyboard_online: kb,
    }
}

#[test]
fn is_hid_broken_false_when_both_online() {
    assert!(!is_hid_broken(&state(true, true)));
}

#[test]
fn is_hid_broken_true_when_either_offline() {
    assert!(is_hid_broken(&state(true, false)));
    assert!(is_hid_broken(&state(false, true)));
    assert!(is_hid_broken(&state(false, false)));
}

#[tokio::test]
async fn check_target_present_true_for_nonempty_screenshot() {
    let f: Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync> =
        Arc::new(|| Box::pin(async { Ok(vec![1, 2, 3]) }));
    assert!(check_target_present(&*f).await);
}

#[tokio::test]
async fn check_target_present_false_for_empty_or_erroring_screenshot() {
    let empty: Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync> =
        Arc::new(|| Box::pin(async { Ok(vec![]) }));
    assert!(!check_target_present(&*empty).await);

    let erroring: Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync> =
        Arc::new(|| Box::pin(async { anyhow::bail!("no target") }));
    assert!(!check_target_present(&*erroring).await);
}

fn make_client(
    broken_at_first: bool,
    recovers_at: Option<LadderAction>,
) -> (HidRecoveryClient, Arc<std::sync::atomic::AtomicBool>) {
    let recovered = Arc::new(std::sync::atomic::AtomicBool::new(!broken_at_first));
    let recovered_for_reset = recovered.clone();
    let is_soft_reset_recovery = matches!(recovers_at, Some(LadderAction::SoftReset));
    (
        HidRecoveryClient::new(
            {
                let recovered = recovered.clone();
                move || {
                    let broken = !recovered.load(std::sync::atomic::Ordering::SeqCst);
                    Box::pin(async move {
                        Ok(HidOnlineState {
                            online: !broken,
                            mouse_online: !broken,
                            keyboard_online: !broken,
                        })
                    })
                }
            },
            move |_opts| {
                if is_soft_reset_recovery {
                    recovered_for_reset.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                Box::pin(async {
                    Ok(HidOnlineState {
                        online: true,
                        mouse_online: true,
                        keyboard_online: true,
                    })
                })
            },
            || Box::pin(async { Ok(vec![1u8, 2, 3]) }),
            |_dx, _dy| Box::pin(async { Ok(()) }),
        ),
        recovered,
    )
}

fn make_verifier(recovered: Arc<std::sync::atomic::AtomicBool>) -> HidVerifier {
    HidVerifier::new(move || {
        let healthy = recovered.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            VerifyResult {
                healthy,
                detail: if healthy {
                    "ok".into()
                } else {
                    "not driving input".into()
                },
            }
        })
    })
}

fn make_unconfigured_trigger() -> RecoveryTrigger {
    RecoveryTrigger {
        configured: false,
        escalate_fn: Arc::new(|_action| {
            Box::pin(async {
                EscalateResult {
                    ok: false,
                    message: "unconfigured".into(),
                }
            })
        }),
    }
}

#[tokio::test]
async fn recover_hid_returns_early_healthy_when_already_fine() {
    let (client, recovered) = make_client(false, None);
    let verifier = make_verifier(recovered);
    let trigger = make_unconfigured_trigger();
    let result = recover_hid(&client, &trigger, &verifier, RecoverOpts::default()).await;
    assert!(result.target_present);
    assert!(!result.initially_broken);
    assert!(result.recovered);
    assert!(result.attempts.is_empty());
}

#[tokio::test]
async fn recover_hid_soft_reset_recovers_and_stops_the_ladder() {
    let (client, recovered) = make_client(true, Some(LadderAction::SoftReset));
    let verifier = make_verifier(recovered);
    let trigger = make_unconfigured_trigger();
    let result = recover_hid(&client, &trigger, &verifier, RecoverOpts::default()).await;
    assert!(result.recovered);
    assert_eq!(result.attempts.len(), 1);
    assert_eq!(result.attempts[0].rung, "R1");
    assert!(result.attempts[0].recovered);
}

#[tokio::test]
async fn recover_hid_reports_r4_human_action_when_every_rung_fails() {
    let (client, recovered) = make_client(true, None); // never recovers
    let verifier = make_verifier(recovered);
    let trigger = make_unconfigured_trigger();
    let result = recover_hid(
        &client,
        &trigger,
        &verifier,
        RecoverOpts {
            max_rung: 1,
            ..Default::default()
        },
    )
    .await;
    assert!(!result.recovered);
    assert!(result.human_action_required.is_some());
    assert_eq!(result.attempts.len(), 1); // only R1, max_rung=1
}

#[tokio::test]
async fn recover_hid_r0_presence_gate_skips_every_rung() {
    let client = HidRecoveryClient::new(
        || {
            Box::pin(async {
                Ok(HidOnlineState {
                    online: false,
                    mouse_online: false,
                    keyboard_online: false,
                })
            })
        },
        |_| {
            Box::pin(async {
                Ok(HidOnlineState {
                    online: false,
                    mouse_online: false,
                    keyboard_online: false,
                })
            })
        },
        || Box::pin(async { Ok(vec![]) }), // empty screenshot = absent target
        |_dx, _dy| Box::pin(async { Ok(()) }),
    );
    let verifier = HidVerifier::new(|| {
        Box::pin(async {
            VerifyResult {
                healthy: false,
                detail: "n/a".into(),
            }
        })
    });
    let trigger = make_unconfigured_trigger();
    let result = recover_hid(&client, &trigger, &verifier, RecoverOpts::default()).await;
    assert!(!result.target_present);
    assert!(!result.recovered);
    assert!(result.attempts.is_empty());
    assert!(result
        .human_action_required
        .unwrap()
        .contains("not present"));
}

#[tokio::test]
async fn recover_hid_host_rung_unavailable_when_trigger_unconfigured() {
    let (client, recovered) = make_client(true, None);
    let verifier = make_verifier(recovered);
    let trigger = make_unconfigured_trigger();
    // skip soft-reset so we hit the host rung directly
    let result = recover_hid(
        &client,
        &trigger,
        &verifier,
        RecoverOpts {
            max_rung: 2,
            skip_soft_reset: true,
            ..Default::default()
        },
    )
    .await;
    assert!(!result.recovered);
    assert_eq!(result.attempts.len(), 1);
    assert_eq!(result.attempts[0].rung, "R2");
    assert!(!result.attempts[0].performed);
    assert!(result.attempts[0].detail.contains("not configured"));
}

#[tokio::test]
async fn recover_hid_reboot_skipped_when_not_allowed() {
    let (client, recovered) = make_client(true, None);
    let verifier = make_verifier(recovered);
    let trigger = make_unconfigured_trigger();
    let result = recover_hid(
        &client,
        &trigger,
        &verifier,
        RecoverOpts {
            max_rung: 4,
            allow_reboot: false,
            ..Default::default()
        },
    )
    .await;
    let reboot_attempt = result.attempts.iter().find(|a| a.rung == "R3b").unwrap();
    assert!(!reboot_attempt.performed);
    assert!(reboot_attempt.detail.contains("allowReboot"));
}

#[test]
fn udc_state_url_strips_trailing_slashes() {
    assert_eq!(
        udc_state_url("http://localhost:8082/"),
        "http://localhost:8082/udc-state"
    );
    assert_eq!(
        udc_state_url("http://localhost:8082"),
        "http://localhost:8082/udc-state"
    );
    assert_eq!(
        udc_state_url("http://localhost:8082///"),
        "http://localhost:8082/udc-state"
    );
}

#[tokio::test]
async fn make_udc_state_reader_returns_none_when_unconfigured() {
    let reader = make_udc_state_reader(None, None, false);
    assert!(reader().await.is_none());
    let reader2 = make_udc_state_reader(Some("  ".to_string()), None, false);
    assert!(reader2().await.is_none());
}

#[test]
fn make_ssh_recovery_trigger_rejects_unsafe_udc_name() {
    let err = make_ssh_recovery_trigger(
        Some("root@pikvm01".to_string()),
        Some("../etc/passwd".to_string()),
        None,
        None,
        5000,
    )
    .err()
    .unwrap();
    assert!(err.to_string().contains("unsafe"));
}

#[test]
fn make_ssh_recovery_trigger_accepts_safe_udc_name() {
    let trigger = make_ssh_recovery_trigger(
        Some("root@pikvm01".to_string()),
        Some("fe980000.usb".to_string()),
        None,
        None,
        5000,
    )
    .unwrap();
    assert!(trigger.configured);
}

#[tokio::test]
async fn make_ssh_recovery_trigger_reboot_is_unsupported() {
    let trigger =
        make_ssh_recovery_trigger(Some("root@pikvm01".to_string()), None, None, None, 5000)
            .unwrap();
    let res = trigger.escalate(HostRecoveryAction::Reboot).await;
    assert!(!res.ok);
    assert!(res.message.contains("not supported over the SSH"));
}

#[tokio::test]
async fn make_ssh_recovery_trigger_soft_connect_reports_failure_when_udc_not_configured_after() {
    let fake_exec: SshExecFn = Arc::new(|_args, _timeout| {
        Box::pin(async {
            SshExecResult {
                code: 0,
                stdout: "udc=fe980000.usb before=not attached after=not attached".to_string(),
                stderr: String::new(),
            }
        })
    });
    let trigger = make_ssh_recovery_trigger(
        Some("root@pikvm01".to_string()),
        None,
        None,
        Some(fake_exec),
        5000,
    )
    .unwrap();
    let res = trigger.escalate(HostRecoveryAction::SoftConnect).await;
    assert!(!res.ok);
    assert!(res.message.contains("did NOT come up"));
}

#[tokio::test]
async fn make_ssh_recovery_trigger_soft_connect_reports_success_when_configured_after() {
    let fake_exec: SshExecFn = Arc::new(|_args, _timeout| {
        Box::pin(async {
            SshExecResult {
                code: 0,
                stdout: "udc=fe980000.usb before=not attached after=configured".to_string(),
                stderr: String::new(),
            }
        })
    });
    let trigger = make_ssh_recovery_trigger(
        Some("root@pikvm01".to_string()),
        None,
        None,
        Some(fake_exec),
        5000,
    )
    .unwrap();
    let res = trigger.escalate(HostRecoveryAction::SoftConnect).await;
    assert!(res.ok);
}

#[tokio::test]
async fn make_ssh_udc_state_reader_parses_real_output() {
    let fake_exec: SshExecFn = Arc::new(|_args, _timeout| {
        Box::pin(async {
            SshExecResult {
                code: 0,
                stdout: "udc=fe980000.usb state=configured".to_string(),
                stderr: String::new(),
            }
        })
    });
    let reader = make_ssh_udc_state_reader(
        Some("root@pikvm01".to_string()),
        None,
        Some(fake_exec),
        5000,
    )
    .unwrap();
    let state = reader().await.unwrap();
    assert_eq!(state.udc, Some("fe980000.usb".to_string()));
    assert_eq!(state.state, "configured");
    assert!(state.online);
}

#[tokio::test]
async fn make_ssh_udc_state_reader_none_when_unconfigured() {
    let reader = make_ssh_udc_state_reader(None, None, None, 5000).unwrap();
    assert!(reader().await.is_none());
}

#[test]
fn make_ssh_udc_state_reader_rejects_unsafe_udc_name() {
    let err = make_ssh_udc_state_reader(
        Some("root@pikvm01".to_string()),
        Some("$(rm -rf /)".to_string()),
        None,
        5000,
    )
    .err()
    .unwrap();
    assert!(err.to_string().contains("unsafe"));
}
