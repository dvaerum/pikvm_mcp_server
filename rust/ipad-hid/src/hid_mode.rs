//! Stateless HID-mode derivation (pikvm-nixos #51).
//!
//! Faithful port of `src/pikvm/hid-mode.ts`.
//!
//! The appliance owns the HID mode (desktop = absolute/dual, ipad =
//! relative/single) and exposes it over a loopback token endpoint. The MCP
//! READS it and flips its own absolute/relative behaviour, holding no
//! second copy. Two source shapes:
//!
//!  - DECLARED (`--target ipad|desktop`, no endpoint) — the permanent,
//!    first-class config for stock-Arch pikvm01: fixed mode, always
//!    reachable, never settling.
//!  - ENDPOINT (`PIKVM_HIDMODE_URL` set) — the appliance: derive from GET
//!    /hidmode, short-TTL cached, FAIL-CLOSED when unreachable (mover ops
//!    refuse rather than guess), with a settling gate over the post-switch
//!    USB re-enumeration window.
//!
//! ADR-0002 Phase 1: the full set of mode-derived defaults a mover-adjacent
//! handler needs is computed ONCE per `resolve()` via `HidModeResolver::policy`,
//! rather than re-derived piecemeal at each call site.
//!
//! Split into one file per logical responsibility (idiomatic Rust 2018+
//! module layout) rather than kept as one ~1,560-line file mirroring the
//! single TS source file — `types` holds the shared data shapes + pure
//! helpers, `resolver` holds `HidModeResolver`'s state machine, `http_endpoint`
//! holds the real REST-backed `HidModeEndpoint` implementation. Public API
//! unchanged: every item below is re-exported from this root exactly as it
//! was when the whole module lived in one file.

mod http_endpoint;
mod resolver;
mod types;

pub use http_endpoint::{make_http_hid_mode_endpoint, HidModeHttpConfig, HidModeHttpDeps};
pub use resolver::HidModeResolver;
pub use types::{
    mode_is_absolute, should_clear_settling_for, BoxFuture, HidMode, HidModeEndpoint,
    HidModeReading, HidModeResolverOpts, HidModeStatus, HidPolicy, ModeSource, MoverGate, Strategy,
    WriteResult,
};

#[cfg(test)]
mod tests;
