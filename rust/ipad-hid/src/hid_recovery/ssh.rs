//! SSH-backed `RecoveryTrigger` and UDC-state reader — the STOCK-PiKVM
//! counterpart to `http.rs`, for boxes with no recovery endpoint.
//!
//! Split out of `hid_recovery.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use std::sync::Arc;
use std::time::Duration;

use regex::Regex;

use super::types::{
    BoxFuture, EscalateResult, HostRecoveryAction, RecoveryTrigger, UdcState, UdcStateReaderFn,
};

/// Runs one remote command. Injectable so the SSH trigger is unit-testable.
pub type SshExecFn =
    Arc<dyn Fn(Vec<String>, u64) -> BoxFuture<'static, SshExecResult> + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// UDC / gadget directory names we are willing to interpolate into a command.
fn safe_sysfs_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn default_ssh_exec() -> SshExecFn {
    Arc::new(
        |args: Vec<String>, timeout_ms: u64| -> BoxFuture<'static, SshExecResult> {
            Box::pin(async move {
                let fut = tokio::process::Command::new("ssh").args(&args).output();
                match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
                    Ok(Ok(out)) => SshExecResult {
                        code: out.status.code().unwrap_or(255),
                        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
                    },
                    Ok(Err(_)) => SshExecResult {
                        code: 255,
                        stdout: String::new(),
                        stderr: String::new(),
                    },
                    Err(_) => SshExecResult {
                        code: 255,
                        stdout: String::new(),
                        stderr: "ssh timed out".to_string(),
                    },
                }
            })
        },
    )
}

/// SSH host-recovery transport — the STOCK-PiKVM backend for the same
/// [`RecoveryTrigger`] contract the appliance serves over loopback HTTP.
///
/// SCOPE: deliberately NOT a remote shell. Each action is a fixed
/// sysfs/configfs sequence with only a discovered, charset-validated
/// UDC/gadget name interpolated. `reboot` is intentionally unsupported here.
pub fn make_ssh_recovery_trigger(
    host: Option<String>,
    udc: Option<String>,
    gadget: Option<String>,
    exec: Option<SshExecFn>,
    timeout_ms: u64,
) -> anyhow::Result<RecoveryTrigger> {
    let host = host.and_then(|h| {
        let t = h.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    if let Some(u) = &udc {
        if !safe_sysfs_name(u) {
            anyhow::bail!("make_ssh_recovery_trigger: refusing unsafe udc name {u:?}");
        }
    }
    if let Some(g) = &gadget {
        if !safe_sysfs_name(g) {
            anyhow::bail!("make_ssh_recovery_trigger: refusing unsafe gadget name {g:?}");
        }
    }
    let exec = exec.unwrap_or_else(default_ssh_exec);
    let configured = host.is_some();

    let escalate_fn = move |action: HostRecoveryAction| -> BoxFuture<'static, EscalateResult> {
        let host = host.clone();
        let udc = udc.clone();
        let gadget = gadget.clone();
        let exec = exec.clone();
        Box::pin(async move {
            let Some(host) = host else {
                return EscalateResult {
                    ok: false,
                    message: "ssh host recovery transport not configured".to_string(),
                };
            };
            if action == HostRecoveryAction::Reboot {
                return EscalateResult {
                    ok: false,
                    message: "reboot is not supported over the SSH recovery transport (scoped to UDC \
                              actions); reboot the PiKVM manually or use the appliance recovery endpoint"
                        .to_string(),
                };
            }

            let udc_expr = match &udc {
                Some(u) => format!("U={u}"),
                None => "U=$(ls -1 /sys/class/udc 2>/dev/null | head -n1)".to_string(),
            };
            let guard = "[ -n \"$U\" ] || { echo \"no UDC under /sys/class/udc\" >&2; exit 3; }";
            let read_before = "B=$(cat /sys/class/udc/$U/state 2>/dev/null)";
            let read_after =
                "A=$(cat /sys/class/udc/$U/state 2>/dev/null); echo \"udc=$U before=$B after=$A\"";

            let script = match action {
                HostRecoveryAction::SoftConnect => [
                    udc_expr.as_str(),
                    guard,
                    read_before,
                    "printf disconnect > /sys/class/udc/$U/soft_connect",
                    "sleep 2",
                    "printf connect > /sys/class/udc/$U/soft_connect",
                    "sleep 5",
                    read_after,
                ]
                .join("; "),
                HostRecoveryAction::UdcRebind => {
                    let gadget_expr = match &gadget {
                        Some(g) => format!("G=/sys/kernel/config/usb_gadget/{g}"),
                        None => {
                            "G=$(ls -1d /sys/kernel/config/usb_gadget/*/ 2>/dev/null | head -n1)"
                                .to_string()
                        }
                    };
                    [
                        udc_expr.as_str(), guard, gadget_expr.as_str(),
                        "[ -n \"$G\" ] || { echo \"no usb_gadget configfs dir\" >&2; exit 4; }",
                        read_before,
                        "echo \"\" > $G/UDC",
                        "sleep 3",
                        "echo $U > $G/UDC",
                        "sleep 5",
                        "A=$(cat /sys/class/udc/$U/state 2>/dev/null)",
                        "[ \"$A\" = \"configured\" ] || { R=retried; echo \"\" > $G/UDC 2>/dev/null; sleep 2; echo $U > $G/UDC; sleep 8; A=$(cat /sys/class/udc/$U/state 2>/dev/null); }",
                        "echo \"udc=$U before=$B after=$A retry=${R:-no}\"",
                    ].join("; ")
                }
                HostRecoveryAction::Reboot => unreachable!(),
            };

            let args = vec![
                "-o".to_string(),
                "BatchMode=yes".to_string(),
                "-o".to_string(),
                "ConnectTimeout=10".to_string(),
                host,
                script,
            ];
            let result = exec(args, timeout_ms).await;
            let out = format!("{}{}", result.stdout, result.stderr);
            let out = out.trim();
            let out_collapsed: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
            let after_re = Regex::new(r"after=(\S+)").unwrap();
            let after = after_re.captures(&result.stdout).map(|c| c[1].to_string());

            if result.code != 0 {
                return EscalateResult {
                    ok: false,
                    message: format!(
                        "ssh {} failed (exit {}): {}",
                        action.as_str(),
                        result.code,
                        &out_collapsed[..out_collapsed.len().min(200)]
                    ),
                };
            }
            if after.as_deref() != Some("configured") {
                return EscalateResult {
                    ok: false,
                    message: format!(
                        "ssh {} ran but the UDC did NOT come up — {} (state must read \"configured\"; \
                         escalate to udc-rebind or check the cable/target)",
                        action.as_str(),
                        &out_collapsed[..out_collapsed.len().min(200)]
                    ),
                };
            }
            EscalateResult {
                ok: true,
                message: format!(
                    "ssh {}: {}",
                    action.as_str(),
                    &out_collapsed[..out_collapsed.len().min(200)]
                ),
            }
        })
    };

    Ok(RecoveryTrigger {
        configured,
        escalate_fn: Arc::new(escalate_fn),
    })
}

/// GROUND-TRUTH UDC state over SSH — the STOCK-PiKVM counterpart to
/// [`make_udc_state_reader`], so a box with no recovery endpoint still gets
/// KERNEL truth instead of the kvmd flags. Read-only: it runs
/// `cat /sys/class/udc/<udc>/state` for the discovered UDC and nothing else.
pub fn make_ssh_udc_state_reader(
    host: Option<String>,
    udc: Option<String>,
    exec: Option<SshExecFn>,
    timeout_ms: u64,
) -> anyhow::Result<UdcStateReaderFn> {
    let host = host.and_then(|h| {
        let t = h.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let Some(host) = host else {
        return Ok(Arc::new(|| Box::pin(async { None })));
    };
    if let Some(u) = &udc {
        if !safe_sysfs_name(u) {
            anyhow::bail!("make_ssh_udc_state_reader: refusing unsafe udc name {u:?}");
        }
    }
    let exec = exec.unwrap_or_else(default_ssh_exec);
    let script = format!(
        "{}; [ -n \"$U\" ] || {{ echo \"udc= state=absent\"; exit 0; }}; echo \"udc=$U state=$(cat /sys/class/udc/$U/state 2>/dev/null)\"",
        match &udc {
            Some(u) => format!("U={u}"),
            None => "U=$(ls -1 /sys/class/udc 2>/dev/null | head -n1)".to_string(),
        }
    );

    let re = Regex::new(r"(?m)udc=(\S*)\s+state=(.*)$").unwrap();
    Ok(Arc::new(move || -> BoxFuture<'static, Option<UdcState>> {
        let host = host.clone();
        let script = script.clone();
        let exec = exec.clone();
        let re = re.clone();
        Box::pin(async move {
            let args = vec![
                "-o".to_string(),
                "BatchMode=yes".to_string(),
                "-o".to_string(),
                "ConnectTimeout=10".to_string(),
                host,
                script,
            ];
            let result = exec(args, timeout_ms).await;
            if result.code != 0 {
                return None;
            }
            let caps = re.captures(result.stdout.trim())?;
            let state = caps[2].trim().to_string();
            if state.is_empty() {
                return None;
            }
            let udc_name = caps[1].to_string();
            Some(UdcState {
                udc: if udc_name.is_empty() {
                    None
                } else {
                    Some(udc_name)
                },
                online: state == "configured",
                state,
            })
        })
    }))
}
