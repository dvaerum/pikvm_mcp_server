//! Selected functions from `src/pikvm/click-verify.ts` — NOT the whole
//! file (it also holds `verifyClickByDecodedFrames`/`verifyClickByDiff`/
//! `chunkMickeys`/`biasCorrectedAimPoint`/etc., which belong to
//! move-to.ts's/click-at.ts's own future port, parked pending that work).
//! Ported here: two pure default-lookup functions (needed by module 4 AND
//! module 5's hid-mode.ts — same shared-primitive pattern this codebase
//! already used for ipad-keys.ts, given a real crate boundary this time),
//! plus `runDismissRecipe`/`formatDismissResult` (Module 6's
//! `pikvm_dismiss_popup` tool's only real dependency from this file — pulled
//! in on demand rather than porting the whole file up front). See
//! `docs/rust-port-plan.md` §7.

use std::future::Future;
use std::pin::Pin;

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

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type SendKeyFn<'a> = &'a (dyn Fn(&str) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync);
pub type SendShortcutFn<'a> =
    &'a (dyn Fn(&[&str]) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync);

/// The result of a dismiss attempt: how many keys actually went out, and
/// any per-key errors (best-effort — a failed key doesn't stop the rest).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DismissResult {
    pub keys_sent: u32,
    pub errors: Vec<String>,
}

/// Faithful port of `runDismissRecipe` (`src/pikvm/click-verify.ts`).
/// Escape → settle → Enter → settle → (optional, when `try_cmd_h` and a
/// `send_shortcut` is provided) Cmd+H → settle. Best-effort: a failed key
/// is recorded in `errors` but does not stop the remaining keys from
/// being attempted.
pub async fn run_dismiss_recipe(
    send_key: SendKeyFn<'_>,
    send_shortcut: Option<SendShortcutFn<'_>>,
    try_cmd_h: bool,
) -> DismissResult {
    let mut result = DismissResult::default();

    match send_key("Escape").await {
        Ok(()) => {
            result.keys_sent += 1;
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        }
        Err(e) => result.errors.push(format!("Escape: {e}")),
    }

    match send_key("Enter").await {
        Ok(()) => {
            result.keys_sent += 1;
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        }
        Err(e) => result.errors.push(format!("Enter: {e}")),
    }

    if try_cmd_h {
        if let Some(send_shortcut) = send_shortcut {
            match send_shortcut(&["MetaLeft", "KeyH"]).await {
                Ok(()) => {
                    result.keys_sent += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                }
                Err(e) => result.errors.push(format!("Cmd+H: {e}")),
            }
        }
    }

    result
}

/// Faithful port of `formatDismissResult` (`src/pikvm/click-verify.ts`,
/// Phase 172). Pure: deterministic, no I/O. Mentioning `pikvm_screenshot`
/// is load-bearing — the caller needs to verify the dismiss took effect.
pub fn format_dismiss_result(result: &DismissResult) -> String {
    if result.errors.is_empty() {
        format!(
            "Dismiss recipe sent {} keys (Escape, Enter). If a hidden popup was eating input, it should now be \
             cleared — verify with pikvm_screenshot and retry the original action.",
            result.keys_sent
        )
    } else {
        format!(
            "Dismiss recipe sent {} keys with {} error(s): {}. Best-effort dismiss continued anyway.",
            result.keys_sent,
            result.errors.len(),
            result.errors.join("; ")
        )
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

    // -- run_dismiss_recipe / format_dismiss_result --

    fn ok_key() -> SendKeyFn<'static> {
        &|_key| Box::pin(async { Ok(()) })
    }

    /// Fails only for "Escape" — lets the "does not stop the remaining
    /// keys" test observe Enter/Cmd+H still going out afterward.
    fn escape_failing_key() -> SendKeyFn<'static> {
        &|key| {
            let key = key.to_string();
            Box::pin(async move {
                if key == "Escape" {
                    anyhow::bail!("{key} failed")
                }
                Ok(())
            })
        }
    }

    fn ok_shortcut() -> SendShortcutFn<'static> {
        &|_keys| Box::pin(async { Ok(()) })
    }

    #[tokio::test]
    async fn sends_escape_then_enter_with_no_cmd_h_by_default() {
        let result = run_dismiss_recipe(ok_key(), Some(ok_shortcut()), false).await;
        assert_eq!(result.keys_sent, 2);
        assert!(result.errors.is_empty());
    }

    #[tokio::test]
    async fn try_cmd_h_true_sends_the_third_key_when_a_shortcut_fn_is_given() {
        let result = run_dismiss_recipe(ok_key(), Some(ok_shortcut()), true).await;
        assert_eq!(result.keys_sent, 3);
    }

    #[tokio::test]
    async fn try_cmd_h_true_with_no_shortcut_fn_stays_at_two_keys() {
        // Mirrors the TS `opts?.tryCmdH && client.sendShortcut` guard — Cmd+H
        // is skipped (not an error) when no send_shortcut is wired.
        let result = run_dismiss_recipe(ok_key(), None, true).await;
        assert_eq!(result.keys_sent, 2);
        assert!(result.errors.is_empty());
    }

    #[tokio::test]
    async fn a_failing_key_is_recorded_but_does_not_stop_the_remaining_keys() {
        let result = run_dismiss_recipe(escape_failing_key(), Some(ok_shortcut()), true).await;
        // Escape fails, Enter succeeds, Cmd+H succeeds.
        assert_eq!(result.keys_sent, 2);
        assert_eq!(result.errors, vec!["Escape: Escape failed".to_string()]);
    }

    #[test]
    fn format_dismiss_result_reports_success_with_no_errors() {
        let text = format_dismiss_result(&DismissResult {
            keys_sent: 2,
            errors: vec![],
        });
        assert!(text.contains("sent 2 keys"));
        assert!(text.contains("pikvm_screenshot"));
        assert!(!text.contains("error"));
    }

    #[test]
    fn format_dismiss_result_reports_errors_when_present() {
        let text = format_dismiss_result(&DismissResult {
            keys_sent: 1,
            errors: vec!["Escape: boom".to_string()],
        });
        assert!(text.contains("1 error(s)"));
        assert!(text.contains("Escape: boom"));
        assert!(text.contains("Best-effort dismiss continued anyway"));
    }
}
