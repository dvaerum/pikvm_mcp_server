//! Approximate-absolute move-to-pixel for PiKVM targets in relative mouse
//! mode (mouse.absolute=false, e.g. iPad). Faithful port of
//! `src/pikvm/move-to.ts`, split into a directory of submodules per
//! docs/rust-port-plan.md's move-to.ts decomposition note (2026-08-28,
//! georgs-mac-mini) rather than one ~2,700-line file.
//!
//! **Built in parallel across two agents, reconciled via branch merge**:
//! `correction_math`/`template_cache`/`motion_diff`/`wiggle_verify`/
//! `pointer_accel_bridge` (this declaration list) are nixos-dev's;
//! `types`/`origin`/`legacy_move` are georgs-mac-mini's, built
//! independently on a separate branch at the same time. This file
//! currently only declares the modules built so far — `mod types;`/
//! `mod origin;`/`mod legacy_move;` and this crate's own `curve-one-shot`
//! dispatch (the TS root file's own remaining job: one `if`, delegating
//! to `curve_mover::move_by_curve_one_shot`) land when the two branches
//! are merged.

pub mod correction_math;
pub mod motion_diff;
pub mod pointer_accel_bridge;
pub mod template_cache;
pub mod wiggle_verify;
