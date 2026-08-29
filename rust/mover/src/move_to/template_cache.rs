//! Cursor template SET cache — thin, client-independent wrappers over
//! `template_set`'s already-ported load/persist/migrate primitives.
//! Faithful port of `getCachedTemplates`/`maybePersistTemplate`
//! (`src/pikvm/move-to.ts` lines 645-858).
//!
//! **New ground, no dedicated TS test file** (`move-to.detectMotion.test.ts`
//! and friends cover `move-to.ts`'s pure math helpers and `detectMotion`,
//! not this pair — confirmed by grepping every `__tests__/move-to.*`
//! file for `getCachedTemplates`/`maybePersistTemplate`; neither appears
//! outside `move-to.ts` itself).
//!
//! **Deliberate signature deviation from the TS source, for testability**:
//! TS's `getCachedTemplates()`/`maybePersistTemplate(...)` take NO
//! directory argument — they close over the hardcoded module-level
//! `DEFAULT_TEMPLATE_DIR` constant directly. Calling that same hardcoded
//! relative path from a Rust test would read/write the real
//! `./data/cursor-templates` directory relative to `cargo test`'s cwd —
//! a real filesystem side effect with no test isolation. This crate
//! already has an established precedent for exactly this shape of
//! problem: `ballistics::measure_ballistics`'s `MeasureBallisticsOptions.
//! profile_path: Option<PathBuf>` (`None` → `default_profile_path()`)
//! keeps the same external behaviour for production callers while
//! letting tests pass an explicit temp path. This file follows the same
//! idiom: both functions take `dir: &str` explicitly; the real call site
//! (once assembled into `legacy_move.rs`) passes `DEFAULT_TEMPLATE_DIR`.
//! `LEGACY_TEMPLATE_PATH` is left as the real hardcoded constant — it's
//! read-only (a stat + conditional read), never written by these
//! functions, and doesn't exist relative to this crate's own test cwd,
//! so touching the real path is inert in a test run (confirmed: no
//! `data/cursor-template.jpg` exists under `rust/mover/` or above it in
//! the paths `cargo test` resolves from).
//!
//! The process-lifetime cache is keyed by `dir` (a `HashMap`, not TS's
//! single unkeyed `let cachedTemplates`) — the direct consequence of
//! parameterizing `dir`: production only ever calls with ONE dir (so
//! behaviourally identical to TS's single-slot cache), but a test using
//! a per-test temp dir must not have its cached result bleed into a
//! DIFFERENT test's (or a later production call's) different dir.

use std::collections::HashMap;
use std::sync::Mutex;

use pikvm_mcp_detection_vision::cursor_detect::{
    diff_pixels, extract_cursor_template_decoded, CursorTemplate, DecodedScreenshot, Point,
    DEFAULT_DETECTION_CONFIG,
};
use pikvm_mcp_detection_vision::looks_like_cursor::looks_like_cursor;
use pikvm_mcp_detection_vision::seed_template::extract_masked_template;
use pikvm_mcp_detection_vision::template_set::{
    load_template_set, migrate_legacy_template, persist_template, MaxAge, LEGACY_TEMPLATE_PATH,
};

static CACHED_TEMPLATES: Mutex<Option<HashMap<String, Vec<CursorTemplate>>>> = Mutex::new(None);

fn cache_get(dir: &str) -> Option<Vec<CursorTemplate>> {
    CACHED_TEMPLATES.lock().unwrap().as_ref()?.get(dir).cloned()
}

fn cache_set(dir: &str, templates: Vec<CursorTemplate>) {
    CACHED_TEMPLATES
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(dir.to_string(), templates);
}

/// Load (and process-lifetime cache, per `dir`) the cursor template set,
/// migrating a legacy single-template file in first. Faithful port of
/// `getCachedTemplates` — see this file's header for the `dir` parameter
/// deviation.
pub async fn get_cached_templates(dir: &str) -> Vec<CursorTemplate> {
    if let Some(cached) = cache_get(dir) {
        return cached;
    }
    // Migrate the legacy single-file template into the set directory so
    // older installs don't lose their cache when this code ships.
    // Best-effort, matching the TS `.catch(() => undefined)`.
    let _ = migrate_legacy_template(LEGACY_TEMPLATE_PATH, dir).await;
    // Phase 194-A: `looks_like_cursor` as a load-time validator — a
    // defensive belt against contaminated templates that slipped past
    // the persist-time gate. Best-effort, matching the TS `.catch(() =>
    // [])`.
    let loaded = load_template_set(dir, Some(&looks_like_cursor), MaxAge::Default)
        .await
        .unwrap_or_default();
    cache_set(dir, loaded.clone());
    loaded
}

/// Extract a cursor template from `screenshot` at `cursor_pos`
/// (mask-based when `pre_frame` is available, unmasked fallback
/// otherwise), reject it if it doesn't look like a cursor, then persist
/// it into the set-aware cache (dedup + cap). Faithful port of
/// `maybePersistTemplate` — best-effort: any I/O failure is swallowed, a
/// failed persist is non-fatal to the caller's move. See this file's
/// header for the `dir` parameter deviation.
pub async fn maybe_persist_template(
    dir: &str,
    screenshot: &DecodedScreenshot,
    cursor_pos: Point,
    pre_frame: Option<&DecodedScreenshot>,
) {
    // Phase 194-G: when the caller supplies the pre-emit frame, build a
    // diff mask between pre and post and use mask-based extraction — the
    // cursor's small footprint on a 24×24 crop means an unmasked extract
    // is mostly static background context, which contaminates NCC
    // matching against similar-wallpaper regions with no cursor present.
    let template = match pre_frame {
        Some(pre) => {
            let diff_mask = diff_pixels(
                &pre.rgb,
                &screenshot.rgb,
                screenshot.width,
                screenshot.height,
                DEFAULT_DETECTION_CONFIG.diff_threshold,
                DEFAULT_DETECTION_CONFIG.brightness_floor,
                DEFAULT_DETECTION_CONFIG.max_channel_delta,
            );
            extract_masked_template(screenshot, cursor_pos, 24, &diff_mask)
        }
        None => extract_cursor_template_decoded(screenshot, cursor_pos, 24),
    };

    // Reject templates that don't look cursor-like — protects against
    // motion-diff picking a wrong pair (icon corner, animated widget)
    // poisoning all future template matches in a self-reinforcing loop.
    if !looks_like_cursor(&template) {
        return;
    }

    // Phase 3: route through the set-aware persistence layer (dedup +
    // cap). Best-effort — a failed persist is non-fatal.
    let existing = get_cached_templates(dir).await;
    let Ok(result) = persist_template(dir, &template, &existing).await else {
        return;
    };
    cache_set(dir, result.kept);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
        ));
        dir
    }

    /// A `w`×`h` frame filled with `background`, with a small bright
    /// achromatic square (a cursor-like blob) stamped at `centre` — the
    /// same "bright cohesive blob on dark background" shape
    /// `looks_like_cursor.rs`'s own tests use to guarantee the accept
    /// path (brightness + achromatic + cohesion gates all pass).
    fn make_screenshot(
        w: u32,
        h: u32,
        background: [u8; 3],
        cursor_at: Option<(u32, u32)>,
    ) -> DecodedScreenshot {
        let mut rgb = vec![0u8; (w as usize) * (h as usize) * 3];
        for i in 0..(w as usize) * (h as usize) {
            rgb[i * 3] = background[0];
            rgb[i * 3 + 1] = background[1];
            rgb[i * 3 + 2] = background[2];
        }
        if let Some((cx, cy)) = cursor_at {
            for y in cy.saturating_sub(3)..=(cy + 3).min(h - 1) {
                for x in cx.saturating_sub(3)..=(cx + 3).min(w - 1) {
                    let i = ((y * w + x) as usize) * 3;
                    rgb[i] = 240;
                    rgb[i + 1] = 240;
                    rgb[i + 2] = 240;
                }
            }
        }
        DecodedScreenshot {
            buffer: Vec::new(),
            rgb,
            width: w,
            height: h,
        }
    }

    // -- get_cached_templates --

    #[tokio::test]
    async fn returns_empty_when_the_directory_does_not_exist() {
        let dir = temp_dir("pikvm-tplcache-empty");
        let templates = get_cached_templates(dir.to_str().unwrap()).await;
        assert!(templates.is_empty());
    }

    #[tokio::test]
    async fn caches_the_result_per_directory_across_calls() {
        let dir = temp_dir("pikvm-tplcache-hit");
        let first = get_cached_templates(dir.to_str().unwrap()).await;
        // Persist a template directly on disk, bypassing the cache, then
        // confirm the SECOND call still returns the cached (empty) value
        // rather than re-scanning the directory — proves the cache, not
        // just a coincidentally-empty directory, is what's returned.
        let screenshot = make_screenshot(48, 48, [60, 60, 60], Some((24, 24)));
        let template = extract_cursor_template_decoded(&screenshot, Point { x: 24.0, y: 24.0 }, 24);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        pikvm_mcp_detection_vision::cursor_detect::save_cursor_template(
            &template,
            dir.join("00.jpg").to_str().unwrap(),
        )
        .await
        .unwrap();
        let second = get_cached_templates(dir.to_str().unwrap()).await;
        assert_eq!(first.len(), second.len());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn two_different_directories_do_not_share_a_cache_entry() {
        let dir_a = temp_dir("pikvm-tplcache-a");
        let dir_b = temp_dir("pikvm-tplcache-b");
        tokio::fs::create_dir_all(&dir_a).await.unwrap();
        let screenshot = make_screenshot(48, 48, [60, 60, 60], Some((24, 24)));
        let template = extract_cursor_template_decoded(&screenshot, Point { x: 24.0, y: 24.0 }, 24);
        pikvm_mcp_detection_vision::cursor_detect::save_cursor_template(
            &template,
            dir_a.join("00.jpg").to_str().unwrap(),
        )
        .await
        .unwrap();
        let from_a = get_cached_templates(dir_a.to_str().unwrap()).await;
        let from_b = get_cached_templates(dir_b.to_str().unwrap()).await;
        assert_eq!(from_a.len(), 1);
        assert_eq!(from_b.len(), 0);
        let _ = tokio::fs::remove_dir_all(&dir_a).await;
    }

    // -- maybe_persist_template --

    #[tokio::test]
    async fn persists_a_cursor_like_extraction_and_it_becomes_visible_via_get_cached_templates() {
        let dir = temp_dir("pikvm-tplcache-persist");
        let screenshot = make_screenshot(48, 48, [60, 60, 60], Some((24, 24)));
        maybe_persist_template(
            dir.to_str().unwrap(),
            &screenshot,
            Point { x: 24.0, y: 24.0 },
            None,
        )
        .await;
        let templates = get_cached_templates(dir.to_str().unwrap()).await;
        assert_eq!(templates.len(), 1);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn rejects_a_non_cursor_like_extraction_without_persisting() {
        let dir = temp_dir("pikvm-tplcache-reject");
        // Uniform background, no bright blob anywhere — extraction can't
        // possibly look like a cursor (fails the brightness gate).
        let screenshot = make_screenshot(48, 48, [60, 60, 60], None);
        maybe_persist_template(
            dir.to_str().unwrap(),
            &screenshot,
            Point { x: 24.0, y: 24.0 },
            None,
        )
        .await;
        let templates = get_cached_templates(dir.to_str().unwrap()).await;
        assert!(templates.is_empty());
    }

    #[tokio::test]
    async fn masked_extraction_still_persists_when_the_diff_isolates_the_cursor() {
        let dir = temp_dir("pikvm-tplcache-masked");
        // pre_frame: no cursor. screenshot: cursor stamped at (24,24).
        // The diff mask marks exactly the blob region as changed, so the
        // masked extraction keeps the bright pixels and zeroes the rest —
        // still cursor-like after masking.
        let pre_frame = make_screenshot(48, 48, [60, 60, 60], None);
        let screenshot = make_screenshot(48, 48, [60, 60, 60], Some((24, 24)));
        maybe_persist_template(
            dir.to_str().unwrap(),
            &screenshot,
            Point { x: 24.0, y: 24.0 },
            Some(&pre_frame),
        )
        .await;
        let templates = get_cached_templates(dir.to_str().unwrap()).await;
        assert_eq!(templates.len(), 1);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
