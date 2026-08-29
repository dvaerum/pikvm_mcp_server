//! Bridge to the learned-ballistics forward model. Faithful port of
//! `learnedBallisticsEnabled` (`src/pikvm/move-to.ts` lines 78-82) —
//! fully portable, since it only reads `foundation::settings`, which is
//! already ported.
//!
//! `learned_ballistics_px_per_mickey` (mirrors `learnedBallisticsPxPer
//! Mickey`, lines 111-170) is a DELIBERATE, DOCUMENTED gap: it depends
//! entirely on `pointer-accel.ts`'s `buildFeatures`/`predictDisplacement`/
//! `pointerAccelModelExists`, none of which are ported.
//! docs/rust-port-plan.md's move-to.ts decomposition note recommends
//! scoping `pointer-accel.ts` OUT of the initial port — it's opt-in
//! (`PIKVM_USE_LEARNED_BALLISTICS=1`), off by default, gated behind a
//! real bundled ONNX model file, and isn't the iPad-critical path
//! (curve-one-shot is). This file is isolated specifically so that
//! deferred opt-in path doesn't entangle with the default path's other
//! three files in this directory.
//!
//! Faithful-port discipline still applies: this is a STUB, not a silent
//! drop. It always returns `None` — the exact result the TS source's own
//! `if (!pointerAccelModelExists()) return null;` early-exit ALSO
//! produces in this build today, since no `pointer_accel.rs`/bundled
//! model exists yet. Callers already treat `None` as "fall back to the
//! default ratio" (the caller in `legacy_move.rs`, once assembled), so
//! behavior is honest and correct for the current build, not a silently
//! wrong answer. Un-stubbing this later means porting `pointer-accel.ts`
//! first — tracked here, not forgotten.

use pikvm_mcp_foundation::settings::{env_snapshot, load_settings};

/// Read the learned-ballistics feature flag at call time (not memoized)
/// so tests can flip env and re-run without module-eval-style caching —
/// faithful port of `learnedBallisticsEnabled`. Uses `load_settings`
/// (not the memoized `get_settings`), matching the TS source's own
/// `loadSettings()` vs `getSettings()` distinction.
pub fn learned_ballistics_enabled() -> bool {
    load_settings(&env_snapshot())
        .movement
        .use_learned_ballistics
}

/// Faithful port of `learnedBallisticsPxPerMickey`'s return shape
/// (`{ pxPerMickeyX, pxPerMickeyY }`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LearnedPxPerMickey {
    pub px_per_mickey_x: f64,
    pub px_per_mickey_y: f64,
}

/// Faithful STUB of `learnedBallisticsPxPerMickey` — see this file's
/// header for why. Always returns `None`.
pub fn learned_ballistics_px_per_mickey(
    _origin: (f64, f64),
    _dx_px: f64,
    _dy_px: f64,
    _chunk_mag: f64,
) -> Option<LearnedPxPerMickey> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn learned_ballistics_px_per_mickey_always_returns_none() {
        // No pointer_accel.rs/model exists in this build — every input
        // shape must fall back the same way `pointerAccelModelExists()
        // === false` does in the TS source.
        assert!(learned_ballistics_px_per_mickey((0.0, 0.0), 0.0, 0.0, 0.0).is_none());
        assert!(learned_ballistics_px_per_mickey((500.0, 400.0), 100.0, -30.0, 25.0).is_none());
    }

    // Real-process-env test — Rust's default test runner runs tests in
    // parallel threads within one binary, so mutating ambient env vars
    // is a race hazard against any OTHER test in THIS crate that also
    // reads real env. Grepped the whole `mover` crate first: nothing
    // else touches `PIKVM_USE_LEARNED_BALLISTICS`, `env_snapshot`, or
    // `load_settings`/`get_settings` — this is the sole exception, same
    // reasoning `foundation::settings`'s own
    // `get_settings_memoizes_and_reset_settings_for_test` test documents
    // for itself. Flag this comment if a future test in this crate is
    // ever added that also needs real env.
    #[test]
    fn learned_ballistics_enabled_reflects_the_live_env_flag_at_call_time() {
        std::env::remove_var("PIKVM_USE_LEARNED_BALLISTICS");
        assert!(!learned_ballistics_enabled());

        std::env::set_var("PIKVM_USE_LEARNED_BALLISTICS", "1");
        assert!(learned_ballistics_enabled());

        // Leave the environment clean for any other process-env-reading code.
        std::env::remove_var("PIKVM_USE_LEARNED_BALLISTICS");
        assert!(!learned_ballistics_enabled());
    }
}
