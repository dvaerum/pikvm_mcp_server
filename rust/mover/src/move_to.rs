//! Approximate-absolute move-to-pixel for PiKVM targets in relative
//! mouse mode (mouse.absolute=false, e.g. iPad).
//!
//! Faithful port of `src/pikvm/move-to.ts` (2711 lines, the single
//! largest file in the codebase).
//!
//! **Built in parallel across two agents, reconciled via branch merge
//! (2026-08-29)** — see `docs/rust-port-plan.md` §7 item 4 (v13, v16,
//! v17) for the full planned layout. `correction_math`/`motion_diff`/
//! `template_cache`/`wiggle_verify`/`pointer_accel_bridge` are
//! nixos-dev's; `types`/`origin`/`resolved_options`/`legacy_move` are
//! georgs-mac-mini's. Each nixos-dev file shipped with its own
//! provisional stand-in for `move_to::types`' shared types (documented
//! inline in each file as "independently buildable/testable now,
//! superseded once merged") — reconciled at merge time by switching each
//! file to `super::types`' real shapes; see this crate's git history for
//! the exact diffs. `pointer_accel_bridge` (the opt-in
//! `PIKVM_USE_LEARNED_BALLISTICS` path) is a deliberate stub —
//! `legacy_move.rs` doesn't call it (v13 scoped the real forward-model
//! query out of the initial port; off by default, gated behind a model
//! file this repo doesn't bundle) — kept isolated in its own file per
//! the original decomposition note so this opt-in path never entangles
//! with the default path's files.

mod correction_math;
mod legacy_move;
mod motion_diff;
mod origin;
pub mod pointer_accel_bridge;
mod resolved_options;
mod template_cache;
mod types;
mod wiggle_verify;

pub use types::{
    Axis, CorrectionPass, DetectionMode, MoveLearnSample, MovePassDiagnostic, MoveStrategy,
    MoveToOptions, MoveToResult, Point,
};

use std::sync::Arc;

use pikvm_mcp_kvmd_client::client::PiKVMClient;

/// Public entry point. Faithful port of `moveToPixel`'s own first
/// branch (move-to.ts:1467-1485): `strategy==='curve-one-shot'` (the
/// validated, "do NOT touch it" iPad-default mover) delegates entirely
/// to `curve_mover`; every other strategy runs the legacy iterative
/// correction-loop path.
pub async fn move_to_pixel(
    client: &Arc<PiKVMClient>,
    target: Point,
    options: MoveToOptions,
) -> anyhow::Result<MoveToResult> {
    if options.strategy == Some(MoveStrategy::CurveOneShot) {
        return crate::curve_mover::move_by_curve_one_shot(
            client,
            target,
            crate::curve_mover::CurveOneShotOptions {
                min_presence: options.min_presence,
                correct_gate_px: options.one_shot_correct_gate_px,
                accept_gate_px: options.accept_gate_px,
                curve_scale_x: options.curve_scale_x,
                curve_scale_y: options.curve_scale_y,
                ..Default::default()
            },
            crate::curve_mover::CurveOneShotDeps::default(),
        )
        .await;
    }
    legacy_move::move_to_pixel_legacy(client, target, &options).await
}
