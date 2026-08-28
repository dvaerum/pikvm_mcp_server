//! `HidModeResolver`: the mode-derivation + settling-gate state machine.
//!
//! Split out of `hid_mode.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use pikvm_mcp_detection_vision::brightness::VERY_DIM_THRESHOLD;
use pikvm_mcp_ipad_primitives::click_verify::{
    default_chunk_pace_ms_for, default_max_residual_px_for,
};
use std::sync::Arc;

use super::types::{
    default_now, mode_is_absolute, mode_str, HidMode, HidModeEndpoint, HidModeReading,
    HidModeResolverOpts, HidModeStatus, HidPolicy, ModeSource, MoverGate, Strategy, WriteResult,
    DEFAULT_SETTLE_WINDOW_MS, DEFAULT_TTL_MS,
};

/// Resolves the HID mode the mover should use. Declared sources are trivial
/// and always allow moving. Endpoint sources cache the last good read for a
/// short TTL, fail closed when the endpoint can't be read (mover ops
/// REFUSE), and gate the mover during the re-enumeration window after a
/// detected switch.
pub struct HidModeResolver {
    declared: Option<HidMode>,
    endpoint: Option<HidModeEndpoint>,
    ttl_ms: u64,
    settle_window_ms: u64,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,

    last_good_mode: Option<HidMode>, // last VALID observed mode (persists across failures for change-detection)
    last_ok_at: Option<u64>,         // when last_good_mode was read (TTL anchor)
    current_mode: Option<HidMode>, // mode as of the last resolve: None when unreachable OR unsettled
    last_reading: Option<HidModeReading>, // last endpoint parse, for the drift diagnostic
    reachable: bool, // did the endpoint answer on the most recent resolve / cache-fresh
    settle_until: Option<u64>, // re-enum window deadline; settling === now() < settle_until (re-derived, never latches)
}

impl HidModeResolver {
    pub fn new(opts: HidModeResolverOpts) -> Self {
        let now = opts.now.unwrap_or_else(|| Arc::new(default_now));
        // Declared is known + reachable from the start; endpoint is UNKNOWN until read.
        let reachable = opts.declared.is_some();
        let (last_good_mode, current_mode) = match opts.declared {
            Some(d) => (Some(d), Some(d)),
            None => (None, None),
        };
        Self {
            declared: opts.declared,
            endpoint: opts.endpoint,
            ttl_ms: opts.ttl_ms.unwrap_or(DEFAULT_TTL_MS),
            settle_window_ms: opts.settle_window_ms.unwrap_or(DEFAULT_SETTLE_WINDOW_MS),
            now,
            last_good_mode,
            last_ok_at: None,
            current_mode,
            last_reading: None,
            reachable,
            settle_until: None,
        }
    }

    /// True when this resolver derives from an endpoint (vs a declared target).
    pub fn is_endpoint(&self) -> bool {
        self.endpoint.is_some()
    }

    /// Resolve the current mode. Declared -> the fixed value. Endpoint ->
    /// the cached value when fresh, else a re-read; a failed read yields
    /// **`None`** (fail-closed) and is never cached (so recovery is
    /// immediate). A read that returns a mode DIFFERENT from the last good
    /// one begins settling (a switch happened elsewhere).
    pub async fn resolve(&mut self) -> Option<HidMode> {
        if let Some(d) = self.declared {
            return Some(d);
        }
        let ep = self
            .endpoint
            .as_ref()
            .expect("endpoint must be set when declared is None");
        let t = (self.now)();
        if let Some(last_ok_at) = self.last_ok_at {
            if t.saturating_sub(last_ok_at) < self.ttl_ms {
                self.reachable = true;
                self.current_mode = self.last_good_mode; // fresh cache — no I/O
                return self.last_good_mode;
            }
        }
        let reading = (ep.read)().await;
        self.last_reading = reading.clone();
        let Some(reading) = reading else {
            self.reachable = false; // UNREACHABLE -> FAIL-CLOSED; never cached, so recovery is immediate
            self.current_mode = None;
            return None;
        };
        self.reachable = true;
        let Some(m) = reading.mode else {
            self.current_mode = None; // reachable but UNSETTLED (gadget mid-reassembly) -> fail-closed; not cached
            return None;
        };
        // The endpoint reports the OBSERVED gadget, so a changed observed
        // mode means the gadget re-assembled elsewhere — begin settling. (A
        // drift, where the gadget did NOT change, is surfaced separately in
        // status; it is not a settling event.)
        if let Some(last_good) = self.last_good_mode {
            if m != last_good {
                self.settle_until = Some(t + self.settle_window_ms);
            }
        }
        self.last_good_mode = Some(m);
        self.last_ok_at = Some(t);
        self.current_mode = Some(m);
        Some(m)
    }

    /// The mode as of the last resolve(): declared value, or the observed
    /// gadget mode, fail-closed to `None` when unreachable OR unsettled.
    fn resolved_mode(&self) -> Option<HidMode> {
        self.declared.or(self.current_mode)
    }

    /// Settling is RE-DERIVED from the clock, never a latched flag: true
    /// only while the bounded re-enum window is still open. It
    /// auto-expires (so a missed clear_settling() can't dead-latch the
    /// mover) and clear_settling() clears it early on confirmed UDC-online.
    fn is_settling(&self) -> bool {
        match self.settle_until {
            Some(until) => (self.now)() < until,
            None => false,
        }
    }

    /// requested(next-boot)!=observed while the gadget is recognisable =>
    /// a next-boot-pending divergence.
    fn drift(&self) -> bool {
        if self.declared.is_some() {
            return false;
        }
        match &self.last_reading {
            Some(r) if r.settled => {
                matches!((r.requested, r.mode), (Some(req), Some(m)) if req != m)
            }
            _ => false,
        }
    }

    /// Whether a mover op may proceed, and why not.
    pub fn mover_gate(&self) -> MoverGate {
        let mode = self.resolved_mode();
        if mode.is_none() {
            let reason = if self.declared.is_none() && self.reachable {
                "HID gadget not recognisable — it is mid-reassembly (unsettled); refusing to move until it settles"
            } else {
                "HID mode unknown — the appliance /hidmode endpoint is unreachable; refusing to move rather than guess the mode"
            };
            return MoverGate {
                allowed: false,
                reason: Some(reason.to_string()),
            };
        }
        if self.is_settling() {
            return MoverGate {
                allowed: false,
                reason: Some("HID re-enumerating after a mode switch — the target USB is not back online yet; retry once it reconnects".to_string()),
            };
        }
        MoverGate {
            allowed: true,
            reason: None,
        }
    }

    /// The mode-derived defaults a mover-adjacent handler needs, computed
    /// once. Returns **`None`** exactly when `mover_gate().allowed` is
    /// false (mode unknown or settling) — mirrors `mover_gate`'s
    /// fail-closed contract.
    pub fn policy(&self) -> Option<HidPolicy> {
        let gate = self.mover_gate();
        if !gate.allowed {
            return None;
        }
        // mover_gate().allowed === true implies resolved_mode() is Some
        // (see mover_gate's own None check above) — this expect documents
        // that invariant rather than re-deriving it.
        let m = self
            .resolved_mode()
            .expect("mover_gate().allowed implies resolved_mode() is Some");
        let mouse_absolute = mode_is_absolute(m);
        Some(HidPolicy {
            mode: m,
            mouse_absolute,
            strategy: if mouse_absolute {
                Strategy::DetectThenMove
            } else {
                Strategy::CurveOneShot
            },
            forbid_slam_fallback: !mouse_absolute,
            forbid_slam_on_ipad: !mouse_absolute,
            chunk_pace_ms: default_chunk_pace_ms_for(mouse_absolute),
            max_residual_px: default_max_residual_px_for(mouse_absolute),
            dim_threshold: if mouse_absolute {
                0.0
            } else {
                VERY_DIM_THRESHOLD
            },
            apply_tap_bias: !mouse_absolute,
        })
    }

    pub fn status(&self) -> HidModeStatus {
        let gate = self.mover_gate();
        let drift_detected = self.drift();
        let mut warnings = Vec::new();
        if drift_detected {
            let r = self
                .last_reading
                .as_ref()
                .expect("drift() true implies last_reading is Some");
            warnings.push(format!(
                "NEXT-BOOT PENDING: the appliance will boot into \"{}\" but the gadget is currently assembled as \"{}\" — the mover is correctly driving the current gadget \"{}\" (no wrong-mode risk); the requested mode takes effect on the next reboot.",
                mode_str(r.requested.expect("drift() true implies requested is Some")),
                mode_str(r.mode.expect("drift() true implies mode is Some")),
                mode_str(r.mode.expect("drift() true implies mode is Some")),
            ));
        }
        HidModeStatus {
            mode: self.resolved_mode(),
            source: if self.declared.is_some() {
                ModeSource::Declared
            } else {
                ModeSource::Endpoint
            },
            reachable: self.reachable,
            settling: self.is_settling(),
            last_read_at: self.last_ok_at,
            requested_mode: if self.declared.is_some() {
                None
            } else {
                self.last_reading.as_ref().and_then(|r| r.requested)
            },
            drift_detected,
            mover_allowed: gate.allowed,
            mover_block_reason: gate.reason,
            warnings,
        }
    }

    /// Force the next resolve() to re-read (a switch drops the session; on
    /// reconnect we must not trust the cache). Keeps last_good_mode for
    /// change-detection.
    pub fn mark_reconnect(&mut self) {
        self.last_ok_at = None;
    }

    /// Open a bounded settling window from now (a switch we initiated).
    /// Auto-expires after settle_window_ms; clear_settling() ends it early
    /// on confirmed UDC-online.
    pub fn begin_settling(&mut self) {
        self.settle_until = Some((self.now)() + self.settle_window_ms);
    }

    /// Clear the settling gate early — the integration calls this once the
    /// target HID is confirmed ONLINE (UDC ground truth; the kvmd flags
    /// lie). The window ALSO auto-expires without this, so a missed call
    /// can't dead-latch the mover (the #51 bug).
    pub fn clear_settling(&mut self) {
        self.settle_until = None;
    }

    /// Switch the appliance mode (POST /hidmode). Begins settling and
    /// forces a re-read on reconnect. The returned message is HONEST: the
    /// switch is requested, the session WILL drop, and the new mode is NOT
    /// live yet. Declared resolvers cannot switch (there is no endpoint to
    /// POST).
    pub async fn set(&mut self, mode: HidMode) -> WriteResult {
        let Some(endpoint) = &self.endpoint else {
            return WriteResult {
                ok: false,
                message:
                    "HID mode is fixed (declared target); there is no /hidmode endpoint to switch"
                        .to_string(),
            };
        };
        let r = (endpoint.write)(mode).await;
        self.begin_settling();
        self.mark_reconnect();
        WriteResult {
            ok: r.ok,
            message: format!(
                "mode switch to \"{}\" requested ({}). The session WILL drop and the new mode is NOT live yet — reconnect and re-read /hidmode before driving input.",
                mode_str(mode),
                r.message
            ),
        }
    }
}
