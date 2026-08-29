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
//!
//! Split into one file per logical responsibility (idiomatic Rust 2018+
//! module layout) rather than kept as one ~1,300-line file mirroring the
//! single TS source file — `types` holds the shared data model, `ladder`
//! holds the R0-R3b escalation algorithm, `http`/`ssh` each hold one
//! transport's `RecoveryTrigger` + UDC-state-reader implementation. Public
//! API unchanged: every item below is re-exported from this root exactly as
//! it was when the whole module lived in one file.

mod behavioral;
mod http;
mod ladder;
mod ssh;
mod types;

pub use behavioral::{make_behavioral_verifier, BehavioralVerifierOptions};
pub use http::{make_http_recovery_trigger, make_udc_state_reader};
pub use ladder::{check_target_present, recover_hid, wait_for_recovery};
pub use ssh::{make_ssh_recovery_trigger, make_ssh_udc_state_reader, SshExecFn, SshExecResult};
pub use types::{
    is_hid_broken, udc_state_url, BoxFuture, EscalateResult, HidOnlineState, HidRecoveryClient,
    HidVerifier, HostRecoveryAction, LadderAction, RecoverOpts, RecoverResult, RecoveryTrigger,
    ResetHidOpts, RungAttempt, RungLabel, UdcState, UdcStateReaderFn, VerifyResult, WaitResult,
};

#[cfg(test)]
mod tests;
