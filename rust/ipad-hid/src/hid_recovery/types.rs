//! Shared HID-recovery data model: the ladder's action/rung vocabulary,
//! the client/trigger/verifier DI contracts, and the small pure
//! HID-online-flag helper.
//!
//! Split out of `hid_recovery.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

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
    pub(super) fn as_str(self) -> &'static str {
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
pub(super) const LADDER: [LadderAction; 4] = [
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
    pub(super) escalate_fn:
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
/// `Clone` is cheap (every field is an `Arc<dyn Fn...>`) — needed so
/// `make_behavioral_verifier`'s `HidVerifier::new` closure (called
/// repeatedly, `Fn` not `FnOnce`) can hold its own owned copy.
#[derive(Clone)]
pub struct HidRecoveryClient {
    get_hid_profile_fn:
        Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<HidOnlineState>> + Send + Sync>,
    reset_hid_fn: Arc<
        dyn Fn(ResetHidOpts) -> BoxFuture<'static, anyhow::Result<HidOnlineState>> + Send + Sync,
    >,
    pub(super) screenshot_fn:
        Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync>,
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

pub type RungLabel = &'static str; // "R0" | "R1" | "R2" | "R3a" | "R3b"

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
