//! Two pure default-lookup functions from `src/pikvm/click-verify.ts`,
//! extracted here because both module 4 (mover/HID orchestration, where
//! click-verify.ts itself lives) and module 5 (iPad-specific/HID recovery,
//! specifically hid-mode.ts) need them — same shared-primitive pattern this
//! codebase already used for ipad-keys.ts, given a real crate boundary this
//! time. See `docs/rust-port-plan.md` §7.
//!
//! Both are genuinely pure — no client dependency, only `foundation`'s
//! settings — unlike `emit_chunked`/`take_raw_screenshot` (this crate's
//! other module), which need module 2's kvmd-client and are deferred until
//! that crate exists.

use pikvm_mcp_foundation::settings::get_settings;

/// Faithful port of `defaultChunkPaceMsFor` (`src/pikvm/click-verify.ts`).
///
/// Extracted so the iPad value is regression-pinned. A future revert to
/// 30 ms (or "let's optimise latency by halving this") would silently
/// re-introduce Phase 136's overshoot bug. Pure: deterministic, no I/O.
pub fn default_chunk_pace_ms_for(mouse_absolute_mode: bool) -> Option<u64> {
    if mouse_absolute_mode {
        None
    } else {
        Some(100)
    }
}

/// Faithful port of `defaultMaxResidualPxFor` (`src/pikvm/click-verify.ts`).
///
/// The proximity gate is an integer argument (`maxResidualPx` on
/// `pikvm_mouse_click_at`/`clickAtWithRetry`). When a positive number is
/// passed, that value is used. When it is not passed, the default is 15px
/// on iPad (tightened from 25 on 2026-07-31, task #38): an 88×58px PIN key
/// has a 29px half-height, so uncorrected a tap leaves the key once an
/// upward residual exceeds ~23px — 25 was genuinely too loose. 15 is safe
/// both uncorrected (15 + the 5.9px tap bias = 20.9 < 29) and corrected,
/// and sits comfortably above the post-Y-calibration single-shot floor
/// (~9.1px, held-out max ~11.4px) so it won't manufacture spurious skips.
/// (12 was rejected — too thin a margin.) The config line
/// `PIKVM_CLICK_MAX_RESIDUAL_PX` overrides the default without a rebuild:
///   `PIKVM_CLICK_MAX_RESIDUAL_PX=40`   → default 40 px
///   `PIKVM_CLICK_MAX_RESIDUAL_PX=off`  (or 0) → disable the gate
pub fn default_max_residual_px_for(mouse_absolute_mode: bool) -> Option<f64> {
    let raw = get_settings().movement.click_max_residual_px_raw;
    if let Some(raw) = raw {
        if raw == "0" || raw.to_lowercase() == "off" {
            return None;
        }
        if let Ok(n) = raw.parse::<f64>() {
            if n.is_finite() && n > 0.0 {
                return Some(n);
            }
        }
    }
    if mouse_absolute_mode {
        None
    } else {
        Some(15.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_foundation::settings::reset_settings_for_test;
    use std::sync::Mutex;

    // Settings are process-wide global state (memoized), so env-var-mutating
    // tests must not interleave with each other or with other test files'
    // settings assertions -- serialize via a lock, same discipline as the
    // TS test suite's own env-var isolation.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_env<T>(pairs: &[(&str, Option<&str>)], f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous: Vec<(String, Option<String>)> = pairs
            .iter()
            .map(|(k, _)| (k.to_string(), std::env::var(k).ok()))
            .collect();
        for (k, v) in pairs {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
        reset_settings_for_test();
        let result = f();
        for (k, v) in previous {
            match v {
                Some(val) => std::env::set_var(&k, val),
                None => std::env::remove_var(&k),
            }
        }
        reset_settings_for_test();
        result
    }

    #[test]
    fn default_chunk_pace_ms_for_absolute_mode_is_none() {
        assert_eq!(default_chunk_pace_ms_for(true), None);
    }

    #[test]
    fn default_chunk_pace_ms_for_relative_mode_is_100ms() {
        assert_eq!(default_chunk_pace_ms_for(false), Some(100));
    }

    #[test]
    fn default_max_residual_px_for_relative_mode_no_override_is_15() {
        with_env(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", None)], || {
            assert_eq!(default_max_residual_px_for(false), Some(15.0));
        });
    }

    #[test]
    fn default_max_residual_px_for_absolute_mode_no_override_is_none() {
        with_env(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", None)], || {
            assert_eq!(default_max_residual_px_for(true), None);
        });
    }

    #[test]
    fn default_max_residual_px_for_explicit_override_wins_over_absolute_mode() {
        with_env(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", Some("40"))], || {
            assert_eq!(default_max_residual_px_for(true), Some(40.0));
            assert_eq!(default_max_residual_px_for(false), Some(40.0));
        });
    }

    #[test]
    fn default_max_residual_px_for_off_disables_the_gate_regardless_of_mode() {
        with_env(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", Some("off"))], || {
            assert_eq!(default_max_residual_px_for(false), None);
        });
    }

    #[test]
    fn default_max_residual_px_for_zero_disables_the_gate() {
        with_env(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", Some("0"))], || {
            assert_eq!(default_max_residual_px_for(false), None);
        });
    }

    #[test]
    fn default_max_residual_px_for_garbage_override_falls_back_to_mode_default() {
        with_env(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", Some("garbage"))], || {
            assert_eq!(default_max_residual_px_for(false), Some(15.0));
        });
    }

    #[test]
    fn default_max_residual_px_for_negative_override_falls_back_to_mode_default() {
        with_env(&[("PIKVM_CLICK_MAX_RESIDUAL_PX", Some("-5"))], || {
            assert_eq!(default_max_residual_px_for(false), Some(15.0));
        });
    }
}
