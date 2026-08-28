//! HID-recovery ladder — detection + escalation for when the emulated USB HID
//! gadget stops driving the target (mouse/keyboard dead while video is fine).
//!
//! Faithful port of `src/pikvm/hid-recovery.ts`. Canonical runbook:
//! `docs/runbooks/hid-recovery.md`.
//!
//! The ladder (firsthand-confirmed 2026-07-22/23), honestly ranked:
//!   R0  PRESENCE GATE — the target must be awake/present or NOTHING recovers.
//!   R1  SOFT RESET — resetHid(). Cheap first try; LOW reliability.
//!   R2  SOFT_CONNECT — toggle the UDC's D+ pull-up. VALIDATED 2026-07-23: the
//!       primary no-reboot fix.
//!   R3a UDC REBIND — configfs UDC unbind→bind. Still UNTESTED (soft_connect
//!       recovered first, didn't need to escalate); must be idempotent.
//!   R3b REBOOT — reboot the PiKVM host. DESTRUCTIVE, opt-in, rarely needed.
//!   R4  HUMAN — physical re-plug / power-on. Honest terminal state.
//!
//! VERIFY BEHAVIORALLY: the mouseOnline/keyboardOnline flags have lied, so
//! recovery is confirmed by emitting a mouse move and checking the pointer
//! actually responded — not by the flags. `is_hid_broken` on the flags stays
//! only as the CHEAP TRIGGER for whether to start the ladder at all.
//!
//! The R2/R3a/R3b HOST mechanisms are provided by pikvm-nixos against the
//! [`RecoveryTrigger`] contract. Until wired, host rungs report unavailable.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use regex::Regex;

/// The subset of HID flag-state the cheap trigger reasons about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HidOnlineState {
    pub online: bool,
    pub mouse_online: bool,
    pub keyboard_online: bool,
}

/// Cheap TRIGGER only: the flags say the HID isn't fully usable. NB the flags
/// are known to lie both ways — use a [`HidVerifier`] for authoritative
/// "recovered".
pub fn is_hid_broken(s: &HidOnlineState) -> bool {
    !(s.mouse_online && s.keyboard_online)
}

/// Privileged HOST recovery actions (R2/R3a/R3b), performed via the trigger.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HostRecoveryAction {
    SoftConnect,
    UdcRebind,
    Reboot,
}

impl HostRecoveryAction {
    fn as_str(self) -> &'static str {
        match self {
            HostRecoveryAction::SoftConnect => "soft_connect",
            HostRecoveryAction::UdcRebind => "udc-rebind",
            HostRecoveryAction::Reboot => "reboot",
        }
    }
}

/// Every ladder step that performs an action (R1 is MCP-native, the rest host).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LadderAction {
    SoftReset,
    Host(HostRecoveryAction),
}

/// Ordered escalation. `max_rung` 1..4 slices this (1=soft-reset … 4=reboot).
const LADDER: [LadderAction; 4] = [
    LadderAction::SoftReset,
    LadderAction::Host(HostRecoveryAction::SoftConnect),
    LadderAction::Host(HostRecoveryAction::UdcRebind),
    LadderAction::Host(HostRecoveryAction::Reboot),
];

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The MCP↔nixos trigger contract. The unprivileged MCP service can't toggle
/// a UDC or reboot the host, so it delegates to a privileged host helper
/// pikvm-nixos provides. `configured: false` ⇒ the orchestrator reports host
/// rungs unavailable instead of failing opaquely.
pub struct RecoveryTrigger {
    pub configured: bool,
    escalate_fn:
        Arc<dyn Fn(HostRecoveryAction) -> BoxFuture<'static, EscalateResult> + Send + Sync>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscalateResult {
    pub ok: bool,
    pub message: String,
}

impl RecoveryTrigger {
    pub async fn escalate(&self, action: HostRecoveryAction) -> EscalateResult {
        (self.escalate_fn)(action).await
    }
}

/// Client surface the ladder needs (satisfied by the real kvmd client, module 2).
pub struct HidRecoveryClient {
    get_hid_profile_fn:
        Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<HidOnlineState>> + Send + Sync>,
    reset_hid_fn: Arc<
        dyn Fn(ResetHidOpts) -> BoxFuture<'static, anyhow::Result<HidOnlineState>> + Send + Sync,
    >,
    screenshot_fn: Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync>,
    mouse_move_relative_fn:
        Arc<dyn Fn(i32, i32) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ResetHidOpts {
    pub reconnect_usb: bool,
    pub settle_ms: Option<u64>,
}

impl HidRecoveryClient {
    pub fn new(
        get_hid_profile_fn: impl Fn() -> BoxFuture<'static, anyhow::Result<HidOnlineState>>
            + Send
            + Sync
            + 'static,
        reset_hid_fn: impl Fn(ResetHidOpts) -> BoxFuture<'static, anyhow::Result<HidOnlineState>>
            + Send
            + Sync
            + 'static,
        screenshot_fn: impl Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync + 'static,
        mouse_move_relative_fn: impl Fn(i32, i32) -> BoxFuture<'static, anyhow::Result<()>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            get_hid_profile_fn: Arc::new(get_hid_profile_fn),
            reset_hid_fn: Arc::new(reset_hid_fn),
            screenshot_fn: Arc::new(screenshot_fn),
            mouse_move_relative_fn: Arc::new(mouse_move_relative_fn),
        }
    }

    pub async fn get_hid_profile(&self) -> anyhow::Result<HidOnlineState> {
        (self.get_hid_profile_fn)().await
    }
    pub async fn reset_hid(&self, opts: ResetHidOpts) -> anyhow::Result<HidOnlineState> {
        (self.reset_hid_fn)(opts).await
    }
    pub async fn screenshot(&self) -> anyhow::Result<Vec<u8>> {
        (self.screenshot_fn)().await
    }
    pub async fn mouse_move_relative(&self, dx: i32, dy: i32) -> anyhow::Result<()> {
        (self.mouse_move_relative_fn)(dx, dy).await
    }
}

/// Authoritative recovery check — behavioral, because the flags lie.
pub struct HidVerifier {
    verify_fn: Arc<dyn Fn() -> BoxFuture<'static, VerifyResult> + Send + Sync>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifyResult {
    pub healthy: bool,
    pub detail: String,
}

impl HidVerifier {
    pub fn new(
        verify_fn: impl Fn() -> BoxFuture<'static, VerifyResult> + Send + Sync + 'static,
    ) -> Self {
        Self {
            verify_fn: Arc::new(verify_fn),
        }
    }
    pub async fn verify(&self) -> VerifyResult {
        (self.verify_fn)().await
    }
}

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

pub type RungLabel = &'static str; // "R0" | "R1" | "R2" | "R3a" | "R3b"

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RungAttempt {
    pub rung: RungLabel,
    pub action: &'static str,
    pub performed: bool,
    pub recovered: bool,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoverResult {
    /// R0: was the target present at all? When false, no rung is attempted.
    pub target_present: bool,
    /// Cheap-trigger read of the flags at entry.
    pub initially_broken: bool,
    pub recovered: bool,
    pub attempts: Vec<RungAttempt>,
    /// Set when unrecovered: the R4 human escalation (physical re-plug / power).
    pub human_action_required: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RecoverOpts {
    /// How far to escalate: 1=soft-reset, 2=+soft_connect, 3=+udc-rebind, 4=+reboot.
    pub max_rung: u8,
    /// R3b reboot is destructive (whole appliance ~30-90s) — must be opted in.
    pub allow_reboot: bool,
    pub soft_settle_ms: Option<u64>,
    /// Post-host-action recovery wait (ms). Default 15000 for R2/R3a.
    pub host_wait_ms: Option<u64>,
    /// Post-reboot recovery wait (ms). Default 120000.
    pub reboot_wait_ms: Option<u64>,
    /// Skip R1 (the kvmd soft-reset, a no-op on our unit) and start at R2
    /// soft_connect. Used by pikvm_usb_reconnect.
    pub skip_soft_reset: bool,
}

impl Default for RecoverOpts {
    fn default() -> Self {
        Self {
            max_rung: 3,
            allow_reboot: false,
            soft_settle_ms: None,
            host_wait_ms: None,
            reboot_wait_ms: None,
            skip_soft_reset: false,
        }
    }
}

/// Poll a behavioral verifier until healthy or timeout (used for the reboot
/// wait-for-online, where the endpoint is down for a while). A thrown/failed
/// verify counts as "keep waiting".
pub struct WaitResult {
    pub recovered: bool,
    pub elapsed_ms: u64,
    pub polls: u32,
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

/// HTTP client for the host recovery trigger (R2/R3a/R3b). POSTs `{ action }`
/// to the pikvm-nixos localhost helper with a bearer token. MCP end of the
/// [`RecoveryTrigger`] contract; unset `url` ⇒ `configured: false`.
pub fn make_http_recovery_trigger(
    url: Option<String>,
    token: Option<String>,
    verify_ssl: bool,
) -> RecoveryTrigger {
    let url = url.and_then(|u| {
        let trimmed = u.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let configured = url.is_some();
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!verify_ssl)
        .build()
        .expect("reqwest client build");

    let escalate_fn = {
        let url = url.clone();
        let token = token.clone();
        move |action: HostRecoveryAction| -> BoxFuture<'static, EscalateResult> {
            let url = url.clone();
            let token = token.clone();
            let client = client.clone();
            Box::pin(async move {
                let Some(url) = url else {
                    return EscalateResult {
                        ok: false,
                        message: "host recovery trigger not configured".to_string(),
                    };
                };
                let mut req = client
                    .post(&url)
                    .json(&serde_json::json!({ "action": action.as_str() }));
                if let Some(t) = &token {
                    req = req.bearer_auth(t);
                }
                match req.send().await {
                    Ok(res) => {
                        let status = res.status();
                        let ok = status.is_success();
                        let mut message =
                            format!("host trigger {}: HTTP {}", action.as_str(), status.as_u16());
                        if let Ok(body) = res.json::<serde_json::Value>().await {
                            if let Some(m) = body.get("message").and_then(|v| v.as_str()) {
                                message = m.to_string();
                            }
                        }
                        EscalateResult { ok, message }
                    }
                    Err(err) => {
                        if action == HostRecoveryAction::Reboot {
                            EscalateResult {
                                ok: true,
                                message: format!(
                                    "reboot initiated (host connection dropped: {err})"
                                ),
                            }
                        } else {
                            EscalateResult {
                                ok: false,
                                message: format!("host trigger {} failed: {err}", action.as_str()),
                            }
                        }
                    }
                }
            })
        }
    };

    RecoveryTrigger {
        configured,
        escalate_fn: Arc::new(escalate_fn),
    }
}

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

/// GROUND-TRUTH UDC state from the host recovery endpoint (M4). The kvmd HID
/// online flags lie; the kernel `/sys/class/udc/<udc>/state` node is the
/// truth, exposed read-only over the same authenticated loopback as the
/// trigger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UdcState {
    /// The bound gadget's UDC name (e.g. "fe980000.usb"), or `None` when none is bound.
    pub udc: Option<String>,
    /// Raw kernel state: "configured" | "not attached" | "addressed" | … | "absent" (synthetic: no UDC).
    pub state: String,
    /// Clean HID-live signal: state === "configured".
    pub online: bool,
}

/// The udc-state GET URL is the recovery base URL + "/udc-state".
pub fn udc_state_url(base: &str) -> String {
    format!("{}/udc-state", base.trim_end_matches('/'))
}

pub type UdcStateReaderFn = Arc<dyn Fn() -> BoxFuture<'static, Option<UdcState>> + Send + Sync>;

/// Build a reader for `GET {PIKVM_HID_RECOVERY_URL}/udc-state`. Returns the
/// parsed [`UdcState`] on HTTP 200, or **`None`** when the route is
/// unconfigured / unreachable / non-200 (so callers degrade: unknown ≠ down).
/// Reuses the same bearer token + TLS-verify as the recovery trigger.
pub fn make_udc_state_reader(
    url: Option<String>,
    token: Option<String>,
    verify_ssl: bool,
) -> UdcStateReaderFn {
    let base = url.and_then(|u| {
        let t = u.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let Some(base) = base else {
        return Arc::new(|| Box::pin(async { None }));
    };
    let full_url = udc_state_url(&base);
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!verify_ssl)
        .build()
        .expect("reqwest client build");

    Arc::new(move || -> BoxFuture<'static, Option<UdcState>> {
        let url = full_url.clone();
        let token = token.clone();
        let client = client.clone();
        Box::pin(async move {
            let mut req = client.get(&url);
            if let Some(t) = &token {
                req = req.bearer_auth(t);
            }
            let res = req.send().await.ok()?;
            if res.status().as_u16() != 200 {
                return None;
            }
            let body: serde_json::Value = res.json().await.ok()?;
            let state = body.get("state")?.as_str()?.to_string();
            let udc = body
                .get("udc")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let online = body
                .get("online")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Some(UdcState { udc, state, online })
        })
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

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn make_ssh_recovery_trigger_soft_connect_reports_failure_when_udc_not_configured_after()
    {
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
}
