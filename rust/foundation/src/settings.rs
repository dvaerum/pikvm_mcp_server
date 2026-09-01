//! Feature / tuning settings for the PiKVM MCP server.
//!
//! Faithful port of `src/settings.ts`.
//!
//! This is the single home for every OPTIONAL `PIKVM_*` flag that tunes
//! cursor detection, movement, and click behaviour. Distinct from `config`:
//!   - `config` owns the CONNECTION config (host/password/…) and panics
//!     (mirroring the TS `throw`) when a required value is missing —
//!     appropriate for "we can't talk to the device".
//!   - `settings` owns OPTIONAL tuning flags and NEVER panics — a missing
//!     flag just falls back to its documented default.
//!
//! Behaviour note, ported verbatim from the TS source: unlike `config`, this
//! module deliberately does NOT load `.env`. These flags have always been
//! read straight from the real process environment (set via the MCP
//! launcher / systemd unit / shell), not from `.env`. Paths are kept as
//! their raw env strings — path resolution / fallback chains stay in the
//! modules that own that concern (module 3's detection chain).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Snapshot the real process environment into the `HashMap<String, String>`
/// shape [`load_settings`] takes. Faithful port's answer to the TS default
/// parameter `env: NodeJS.ProcessEnv = process.env` — Rust has no ambient
/// process-env type to hand a pure function directly, so callers that want
/// "read the real environment" call this explicitly at the boundary instead.
pub fn env_snapshot() -> HashMap<String, String> {
    std::env::vars().collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct MlSettings {
    /// PIKVM_ML_MODEL — raw override path for the single-stage v1 model.
    pub model: Option<String>,
    /// PIKVM_ML_V5_MODEL — raw override path for the v5 presence model.
    pub v5_model: Option<String>,
    /// PIKVM_ML_V5_PRESENCE_GATE=1 — gate v1 behind the v5 presence head.
    pub v5_presence_gate: bool,
    /// PIKVM_ML_V8_MODEL — raw override path; suppresses the v12→v11→… chain.
    pub v8_model: Option<String>,
    /// PIKVM_ML_CASCADE — dual-head cascade tracker. DEFAULT ON (opt out with =0).
    pub cascade_enabled: bool,
    /// PIKVM_ML_VERIFIER_MODEL — raw override path for the crop verifier.
    pub verifier_model: Option<String>,
    /// PIKVM_ML_GRID_STRIDE — native-px grid step for the cascade (default 48).
    pub grid_stride: f64,
    /// PIKVM_ML_VERIFY_THRESH — verifier accept threshold (default 0.5).
    pub verify_thresh: f64,
    /// PIKVM_ML_CAPTURE_DIR — when set, dump detection crops here for labelling.
    pub capture_dir: Option<String>,
    /// PIKVM_ML_DISABLE=1 — force the probe-and-diff path, skip ML entirely.
    pub disabled: bool,
    /// PIKVM_ML_CHANGE_DETECTION_PREFILTER=1 — enable the cascade's
    /// byte-exact per-crop change-detection pre-filter (task_3a0440a91a05,
    /// docs/cascade-change-detection-prefilter-design.md). DEFAULT OFF:
    /// real, correctness-verified, ~2.7x-108x win on real Pi4 hardware
    /// (see the design doc's "Real result" section), but the cache's
    /// emit-based invalidation only recently gained absolute-mode
    /// coverage (task_c8c4b0f2083f) — leave opt-in until that fix has its
    /// own live re-confirmation, matching this session's standing
    /// discipline of proving a change on real hardware before it
    /// defaults on.
    pub change_detection_prefilter_enabled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MovementSettings {
    /// PIKVM_USE_LEARNED_BALLISTICS=1 — use the learned pointer-accel model.
    pub use_learned_ballistics: bool,
    /// PIKVM_DISABLE_RETRY_SKIP_PROBE=1 — force a fresh probe on every retry.
    pub disable_retry_skip_probe: bool,
    /// PIKVM_PREDOWN_DIR — when set, dump pre-click-down screenshots here.
    pub predown_dir: Option<String>,
    /// PIKVM_FORCE_WAKE=1 — always emit the wake wiggle before a click.
    pub force_wake: bool,
    /// PIKVM_CLICK_MAX_RESIDUAL_PX — proximity-gate override, kept as the RAW
    /// string. Its "off"/"0"/positive-number parsing and the per-mode
    /// default live in module 3/4's click-verify port, which needs the
    /// runtime mouse-mode to decide the fallback.
    pub click_max_residual_px_raw: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub ml: MlSettings,
    pub movement: MovementSettings,
    /// PIKVM_POINTER_ACCEL_MODEL — raw override path for the pointer-accel ONNX.
    pub pointer_accel_model: Option<String>,
    /// PIKVM_EMIT_LOG — when set, append every relative emit to this file.
    pub emit_log: Option<String>,
}

/// Non-empty env lookup — mirrors the TS `env.X || undefined` pattern (an
/// empty string is treated the same as unset).
fn get(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key).filter(|v| !v.is_empty()).cloned()
}

/// Parse a [`Settings`] from an environment map. Pure: reads only the passed
/// `env`, never panics, applies each flag's documented default. Faithful
/// port of `loadSettings(env)`.
pub fn load_settings(env: &HashMap<String, String>) -> Settings {
    Settings {
        ml: MlSettings {
            model: get(env, "PIKVM_ML_MODEL"),
            v5_model: get(env, "PIKVM_ML_V5_MODEL"),
            v5_presence_gate: env.get("PIKVM_ML_V5_PRESENCE_GATE").map(String::as_str) == Some("1"),
            v8_model: get(env, "PIKVM_ML_V8_MODEL"),
            cascade_enabled: env.get("PIKVM_ML_CASCADE").map(String::as_str) != Some("0"),
            verifier_model: get(env, "PIKVM_ML_VERIFIER_MODEL"),
            grid_stride: env
                .get("PIKVM_ML_GRID_STRIDE")
                .and_then(|v| v.parse().ok())
                .unwrap_or(48.0),
            verify_thresh: env
                .get("PIKVM_ML_VERIFY_THRESH")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.5),
            capture_dir: get(env, "PIKVM_ML_CAPTURE_DIR"),
            disabled: env.get("PIKVM_ML_DISABLE").map(String::as_str) == Some("1"),
            change_detection_prefilter_enabled: env
                .get("PIKVM_ML_CHANGE_DETECTION_PREFILTER")
                .map(String::as_str)
                == Some("1"),
        },
        movement: MovementSettings {
            use_learned_ballistics: env.get("PIKVM_USE_LEARNED_BALLISTICS").map(String::as_str)
                == Some("1"),
            disable_retry_skip_probe: env
                .get("PIKVM_DISABLE_RETRY_SKIP_PROBE")
                .map(String::as_str)
                == Some("1"),
            predown_dir: get(env, "PIKVM_PREDOWN_DIR"),
            force_wake: env.get("PIKVM_FORCE_WAKE").map(String::as_str) == Some("1"),
            // Deliberately NOT filtered through `get()`'s empty-string-as-
            // unset rule — the TS source reads this one as the bare
            // `env.PIKVM_CLICK_MAX_RESIDUAL_PX` (no `|| undefined`), so an
            // explicitly-set empty string is preserved here too, faithfully.
            click_max_residual_px_raw: env.get("PIKVM_CLICK_MAX_RESIDUAL_PX").cloned(),
        },
        pointer_accel_model: get(env, "PIKVM_POINTER_ACCEL_MODEL"),
        emit_log: get(env, "PIKVM_EMIT_LOG"),
    }
}

// Memoised process-wide singleton. Reads the real environment on first
// access, matching the TS module's "read once at import" semantics for the
// consts it replaced. A Mutex<Option<_>> rather than OnceLock because
// reset_settings_for_test() needs to clear it, which OnceLock doesn't
// support — the TS singleton (a plain module-level `let`) has no such
// restriction either.
static CACHED: OnceLock<Mutex<Option<Settings>>> = OnceLock::new();

fn cell() -> &'static Mutex<Option<Settings>> {
    CACHED.get_or_init(|| Mutex::new(None))
}

/// The process-wide settings, parsed once from the real environment.
/// Faithful port of `getSettings()`.
pub fn get_settings() -> Settings {
    let mut guard = cell().lock().unwrap();
    if guard.is_none() {
        *guard = Some(load_settings(&env_snapshot()));
    }
    guard.as_ref().unwrap().clone()
}

/// Test hook: drop the memoised singleton so the next `get_settings()`
/// re-reads the environment. Faithful port of `resetSettingsForTest()`.
pub fn reset_settings_for_test() {
    *cell().lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_from(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn empty_env_yields_all_documented_defaults() {
        let s = load_settings(&HashMap::new());
        assert_eq!(s.ml.model, None);
        assert!(!s.ml.v5_presence_gate);
        assert!(s.ml.cascade_enabled); // DEFAULT ON
        assert_eq!(s.ml.grid_stride, 48.0);
        assert_eq!(s.ml.verify_thresh, 0.5);
        assert!(!s.ml.disabled);
        assert!(!s.movement.use_learned_ballistics);
        assert!(!s.movement.force_wake);
        assert_eq!(s.movement.click_max_residual_px_raw, None);
        assert_eq!(s.pointer_accel_model, None);
        assert_eq!(s.emit_log, None);
    }

    #[test]
    fn cascade_is_disabled_only_by_the_literal_string_zero() {
        let s = load_settings(&env_from(&[("PIKVM_ML_CASCADE", "0")]));
        assert!(!s.ml.cascade_enabled);
        // Any other value (including "false") leaves it ON — faithful to
        // the TS `!== '0'` check, not a generic truthy/falsy parse.
        let s2 = load_settings(&env_from(&[("PIKVM_ML_CASCADE", "false")]));
        assert!(s2.ml.cascade_enabled);
    }

    #[test]
    fn boolean_flags_require_the_literal_string_one() {
        let s = load_settings(&env_from(&[
            ("PIKVM_ML_V5_PRESENCE_GATE", "yes"),
            ("PIKVM_ML_DISABLE", "true"),
        ]));
        // Neither "yes" nor "true" is the literal "1" the TS source checks for.
        assert!(!s.ml.v5_presence_gate);
        assert!(!s.ml.disabled);

        let s2 = load_settings(&env_from(&[
            ("PIKVM_ML_V5_PRESENCE_GATE", "1"),
            ("PIKVM_ML_DISABLE", "1"),
        ]));
        assert!(s2.ml.v5_presence_gate);
        assert!(s2.ml.disabled);
    }

    #[test]
    fn numeric_flags_parse_when_present() {
        let s = load_settings(&env_from(&[
            ("PIKVM_ML_GRID_STRIDE", "64"),
            ("PIKVM_ML_VERIFY_THRESH", "0.75"),
        ]));
        assert_eq!(s.ml.grid_stride, 64.0);
        assert_eq!(s.ml.verify_thresh, 0.75);
    }

    #[test]
    fn unparseable_numeric_flags_fall_back_to_the_default() {
        // Faithful port note: TS's `Number("garbage")` is NaN, not a thrown
        // error — but this module's own contract ("NEVER throws") plus the
        // documented-default discipline mean the Rust port treats an
        // unparseable override the same way a caller would want: fall back
        // to the documented default rather than propagate a NaN into
        // downstream detection math. This is the one place the port makes an
        // explicit, deliberate behavioral choice rather than a byte-for-byte
        // NaN-propagation match — flagged here rather than silently done.
        let s = load_settings(&env_from(&[("PIKVM_ML_GRID_STRIDE", "not-a-number")]));
        assert_eq!(s.ml.grid_stride, 48.0);
    }

    #[test]
    fn empty_string_env_values_are_treated_as_unset_for_optional_paths() {
        let s = load_settings(&env_from(&[("PIKVM_ML_MODEL", "")]));
        assert_eq!(s.ml.model, None);
    }

    #[test]
    fn click_max_residual_px_raw_preserves_an_explicit_empty_string() {
        // The one deliberate exception to the "empty string = unset" rule —
        // see the inline comment in load_settings for why.
        let s = load_settings(&env_from(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", "")]));
        assert_eq!(s.movement.click_max_residual_px_raw, Some("".to_string()));
    }

    #[test]
    fn click_max_residual_px_raw_stays_a_raw_string_not_parsed_here() {
        let s = load_settings(&env_from(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", "off")]));
        assert_eq!(
            s.movement.click_max_residual_px_raw,
            Some("off".to_string())
        );
    }

    #[test]
    fn get_settings_memoizes_and_reset_settings_for_test_clears_it() {
        // Real-process-env test — Rust's default test runner runs tests in
        // parallel threads within one binary, so mutating ambient env vars
        // is a race hazard against any OTHER test that also reads real env.
        // Every other test in this module passes an explicit HashMap and
        // never touches process env, so this is safe as the sole exception
        // — flag this comment if a future settings test is ever added that
        // also needs real env, since it would need to be serialized against
        // this one (e.g. via a shared Mutex guard).
        reset_settings_for_test();
        std::env::remove_var("PIKVM_ML_DISABLE");
        let first = get_settings();
        assert!(!first.ml.disabled);

        // Changing the real env after the first call must NOT be visible
        // until reset_settings_for_test() — that's the whole point of
        // memoization.
        std::env::set_var("PIKVM_ML_DISABLE", "1");
        let still_memoized = get_settings();
        assert!(!still_memoized.ml.disabled);

        reset_settings_for_test();
        let after_reset = get_settings();
        assert!(after_reset.ml.disabled);

        // Leave the environment clean for any other process-env-reading code.
        std::env::remove_var("PIKVM_ML_DISABLE");
        reset_settings_for_test();
    }

    #[test]
    fn all_optional_path_flags_pass_through_when_set() {
        let s = load_settings(&env_from(&[
            ("PIKVM_ML_MODEL", "/path/a.onnx"),
            ("PIKVM_ML_V5_MODEL", "/path/b.onnx"),
            ("PIKVM_ML_V8_MODEL", "/path/c.onnx"),
            ("PIKVM_ML_VERIFIER_MODEL", "/path/d.onnx"),
            ("PIKVM_ML_CAPTURE_DIR", "/tmp/crops"),
            ("PIKVM_PREDOWN_DIR", "/tmp/predown"),
            ("PIKVM_POINTER_ACCEL_MODEL", "/path/e.onnx"),
            ("PIKVM_EMIT_LOG", "/tmp/emit.log"),
        ]));
        assert_eq!(s.ml.model.as_deref(), Some("/path/a.onnx"));
        assert_eq!(s.ml.v5_model.as_deref(), Some("/path/b.onnx"));
        assert_eq!(s.ml.v8_model.as_deref(), Some("/path/c.onnx"));
        assert_eq!(s.ml.verifier_model.as_deref(), Some("/path/d.onnx"));
        assert_eq!(s.ml.capture_dir.as_deref(), Some("/tmp/crops"));
        assert_eq!(s.movement.predown_dir.as_deref(), Some("/tmp/predown"));
        assert_eq!(s.pointer_accel_model.as_deref(), Some("/path/e.onnx"));
        assert_eq!(s.emit_log.as_deref(), Some("/tmp/emit.log"));
    }
}
