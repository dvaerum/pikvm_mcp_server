//! Shared HID-mode types, the pure mode-string/mode-is-absolute
//! helpers, and the settling-clear predicate.
//!
//! Split out of `hid_mode.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HidMode {
    Ipad,
    Desktop,
}

pub(super) fn mode_str(m: HidMode) -> &'static str {
    match m {
        HidMode::Ipad => "ipad",
        HidMode::Desktop => "desktop",
    }
}

/// desktop => absolute mouse (dual gadget); ipad => relative mouse (single).
pub fn mode_is_absolute(mode: HidMode) -> bool {
    matches!(mode, HidMode::Desktop)
}

/// One parse of GET /hidmode. The endpoint reports the ASSEMBLED gadget, so
/// `mode` is the OBSERVED gadget (authoritative for driving); `None` =
/// unrecognisable / mid-reassembly (unsettled). `requested` is the marker's
/// INTENT and `settled` is "gadget recognisable" (NOT "the switch
/// succeeded"): `settled && requested != mode` is a next-boot-pending
/// divergence (drift) — the config (requested) will assemble on the next
/// reboot but differs from the current gadget.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HidModeReading {
    pub mode: Option<HidMode>,
    pub requested: Option<HidMode>,
    pub settled: bool,
}

pub struct WriteResult {
    pub ok: bool,
    pub message: String,
}

/// The MCP end of the /hidmode contract. `read` returns the mode, or
/// **`None`** when the route is unconfigured / unreachable / non-200
/// (unknown != a guessed mode).
pub struct HidModeEndpoint {
    pub configured: bool,
    pub read: Arc<dyn Fn() -> BoxFuture<'static, Option<HidModeReading>> + Send + Sync>,
    pub write: Arc<dyn Fn(HidMode) -> BoxFuture<'static, WriteResult> + Send + Sync>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeSource {
    Declared,
    Endpoint,
}

pub struct HidModeStatus {
    /// The resolved mode (observed gadget), or **`None`** = UNKNOWN
    /// (unreachable / unsettled / not yet read).
    pub mode: Option<HidMode>,
    pub source: ModeSource,
    pub reachable: bool,
    pub settling: bool,
    pub last_read_at: Option<u64>,
    /// The marker's intent from the last read (`None` for declared / not read).
    pub requested_mode: Option<HidMode>,
    /// The assembled gadget != the requested (next-boot) mode while
    /// recognisable => a next-boot-pending divergence.
    pub drift_detected: bool,
    pub mover_allowed: bool,
    pub mover_block_reason: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    CurveOneShot,
    DetectThenMove,
}

/// The full set of mode-derived defaults a mover-adjacent handler needs,
/// computed ONCE per `resolve()` instead of re-derived piecemeal at each
/// read site.
pub struct HidPolicy {
    pub mode: HidMode,
    pub mouse_absolute: bool,
    pub strategy: Strategy,
    // Round 2 Phase 0 / F11: do not collapse these two — both derive to
    // `!mouse_absolute` today, but forbid_slam_fallback gates the
    // AUTOMATIC fallback path, while forbid_slam_on_ipad gates even an
    // EXPLICIT caller request. A future mode/policy could need one true
    // and the other false.
    pub forbid_slam_fallback: bool,
    pub forbid_slam_on_ipad: bool,
    pub chunk_pace_ms: Option<u64>,
    pub max_residual_px: Option<f64>,
    /// Mode-only component of the dim-screen precheck threshold. Callers
    /// with a single-tap-style override still apply it on top — this is
    /// NOT the final per-call value.
    pub dim_threshold: f64,
    /// Whether the iPad tap-offset bias correction should be applied to
    /// the aim point. Desktop/absolute clicks by coordinate, no offset.
    pub apply_tap_bias: bool,
}

pub struct HidModeResolverOpts {
    /// Exactly one of `declared` / `endpoint` (enforced by the caller at startup).
    pub declared: Option<HidMode>,
    pub endpoint: Option<HidModeEndpoint>,
    /// Endpoint cache lifetime; a read within this window is reused, not re-fetched.
    pub ttl_ms: Option<u64>,
    /// Max time the settling gate stays closed after a switch before it
    /// AUTO-EXPIRES (the backstop that makes the gate un-latchable).
    pub settle_window_ms: Option<u64>,
    pub now: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
}

pub(super) const DEFAULT_TTL_MS: u64 = 5000;
// Backstop for the settling gate. clear_settling() (health_check on UDC-online)
// is the fast path; this bounds the MAX time the mover stays gated when that
// path doesn't run, so a missed clear can't dead-latch the mover (the #51
// bug: settling was a one-way flag cleared ONLY by health_check, so polling
// status left it stuck until an MCP restart). 15s comfortably covers a real
// post-switch USB re-enumeration (a few seconds).
pub(super) const DEFAULT_SETTLE_WINDOW_MS: u64 = 15000;

pub(super) fn default_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis() as u64
}

/// Whether a UDC-state reading is confident enough to clear the settling
/// gate early (see `HidModeResolver::clear_settling`). Only a CONFIRMED-
/// online reading does — `None` (the UDC reader isn't wired) or
/// `{online: false}` (confirmed still offline) both leave the gate as-is
/// rather than guessing, relying on the resolver's own auto-expiry backstop
/// instead.
pub fn should_clear_settling_for(udc_state: Option<&crate::hid_recovery::UdcState>) -> bool {
    udc_state.is_some_and(|s| s.online)
}

pub struct MoverGate {
    pub allowed: bool,
    pub reason: Option<String>,
}
