//! Template set management — the directory-backed cursor-template store
//! used by move-to.ts. Distinct from cursor_detect.rs so the detection
//! algorithms stay focused on math; this file owns I/O, dedup, and
//! capacity policy.
//!
//! Faithful port of `src/pikvm/template-set.ts`.
//!
//! Phase 3: multi-template support. A single cached template is brittle
//! across backdrops — once the cursor moves over a different wallpaper or
//! panel, the NCC score drifts below threshold and template-match stops
//! contributing. A SET of templates is maintained instead and
//! `find_cursor_by_template_set` picks whichever one scores highest at
//! match time.
//!
//! Layout on disk: `<dir>/<n>.jpg` where `<n>` is a sequence number.
//!
//! Migration: if a legacy `./data/cursor-template.jpg` exists when the set
//! is loaded, it's adopted as the first member of the set.

use crate::cursor_detect::{load_cursor_template, save_cursor_template, CursorTemplate};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum number of templates to keep on disk. When the set is full and a
/// perceptually-distinct template arrives, the oldest entry by mtime is
/// dropped.
pub const TEMPLATE_SET_CAP: usize = 8;

/// NCC similarity above which two templates are treated as the same
/// perceptual capture and the new one is skipped (no disk write, no growth
/// of the set). 0.92 separates "different cursor over different backdrop"
/// (~0.7-0.85 self-NCC) from "same cursor same backdrop" (~0.95+ self-NCC).
pub const TEMPLATE_DEDUP_NCC: f64 = 0.92;

/// Default max-age for persisted templates: 6 hours. Templates older than
/// this are considered cross-session contamination and skipped at load
/// time. Phase 196 (v0.5.192): live bench showed Files target went from 0%
/// (deterministic 245.15px residual every trial) to 33% (varying residuals
/// 52/246/122px) when the template directory was wiped between sessions.
/// Stale templates from a prior session were consistently false-positive-
/// matching at the same wrong location. A 6-hour TTL naturally separates
/// sessions while still letting templates amortize across long-running
/// batches.
pub const DEFAULT_TEMPLATE_MAX_AGE_MS: u64 = 6 * 60 * 60 * 1000;

/// Saved here so callers can import a single source of truth.
pub const DEFAULT_TEMPLATE_DIR: &str = "./data/cursor-templates";
pub const LEGACY_TEMPLATE_PATH: &str = "./data/cursor-template.jpg";

/// TS's `maxAgeMs: number | null = DEFAULT_TEMPLATE_MAX_AGE_MS` has three
/// distinct states — unset (use the default), explicit `null` (disable),
/// explicit value — that a single `Option<u64>` can't represent
/// unambiguously. This enum makes all three explicit.
#[derive(Clone, Copy, Debug, Default)]
pub enum MaxAge {
    #[default]
    Default,
    Disabled,
    Millis(u64),
}

/// Compute zero-mean NCC between two equal-size templates at offset (0,0).
/// Used for dedup decisions when adding a new template. Returns a value in
/// [-1, 1]; 1 = identical.
pub fn template_similarity(a: &CursorTemplate, b: &CursorTemplate) -> f64 {
    if a.width != b.width || a.height != b.height {
        return 0.0;
    }
    let n = (a.width as usize) * (a.height as usize);
    let (mut sum_ar, mut sum_ag, mut sum_ab) = (0f64, 0f64, 0f64);
    let (mut sum_br, mut sum_bg, mut sum_bb) = (0f64, 0f64, 0f64);
    for i in 0..n {
        let o = i * 3;
        sum_ar += a.rgb[o] as f64;
        sum_ag += a.rgb[o + 1] as f64;
        sum_ab += a.rgb[o + 2] as f64;
        sum_br += b.rgb[o] as f64;
        sum_bg += b.rgb[o + 1] as f64;
        sum_bb += b.rgb[o + 2] as f64;
    }
    let (mean_ar, mean_ag, mean_ab) = (sum_ar / n as f64, sum_ag / n as f64, sum_ab / n as f64);
    let (mean_br, mean_bg, mean_bb) = (sum_br / n as f64, sum_bg / n as f64, sum_bb / n as f64);
    let (mut dot, mut var_a, mut var_b) = (0f64, 0f64, 0f64);
    for i in 0..n {
        let o = i * 3;
        let ar = a.rgb[o] as f64 - mean_ar;
        let ag = a.rgb[o + 1] as f64 - mean_ag;
        let ab = a.rgb[o + 2] as f64 - mean_ab;
        let br = b.rgb[o] as f64 - mean_br;
        let bg = b.rgb[o + 1] as f64 - mean_bg;
        let bb = b.rgb[o + 2] as f64 - mean_bb;
        dot += ar * br + ag * bg + ab * bb;
        var_a += ar * ar + ag * ag + ab * ab;
        var_b += br * br + bg * bg + bb * bb;
    }
    let denom = (var_a * var_b).sqrt();
    if denom == 0.0 {
        return 0.0;
    }
    dot / denom
}

fn is_jpeg_name(f: &str) -> bool {
    let lower = f.to_lowercase();
    lower.ends_with(".jpg") || lower.ends_with(".jpeg")
}

/// Load every `*.jpg`/`*.jpeg` in `dir` as a `CursorTemplate`. Returns an
/// empty vec if the directory doesn't exist. Sorted by filename so the
/// ordering is stable across processes.
///
/// `validate` (Phase 194-A, v0.5.187): templates that fail validation are
/// silently skipped — a defensive belt against any path that bypasses
/// persist-time gates.
///
/// `max_age` (Phase 196, v0.5.192): rejects templates whose file mtime is
/// older than that many milliseconds. Cross-session templates can match
/// strongly at non-cursor features and produce deterministic-wrong cursor
/// positions.
pub async fn load_template_set(
    dir: &str,
    // `+ Send + Sync` (not just `Fn`) so this async fn's own generated
    // Future stays `Send` regardless of whether a caller actually passes
    // `Some(validate)` — a bare `Option<&dyn Fn(...)>` fixes the type of
    // EVERY local binding of this signature, `None::<&dyn Fn(...)>`
    // included, so a Send-bound caller (e.g. a boxed `dyn Future + Send`
    // tool handler) could never call this at all without the bound here.
    // Found while wiring `seed_cursor_template` into Module 6's tool
    // registry (nixos-dev, 2026-08-28) — a real latent gap, not a
    // hypothetical one.
    validate: Option<&(dyn Fn(&CursorTemplate) -> bool + Send + Sync)>,
    max_age: MaxAge,
) -> anyhow::Result<Vec<CursorTemplate>> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut names: Vec<String> = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if let Some(name) = entry.file_name().to_str() {
            if is_jpeg_name(name) {
                names.push(name.to_string());
            }
        }
    }
    names.sort();

    let max_age_ms: Option<u64> = match max_age {
        MaxAge::Default => Some(DEFAULT_TEMPLATE_MAX_AGE_MS),
        MaxAge::Disabled => None,
        MaxAge::Millis(v) => Some(v),
    };

    let mut out = Vec::new();
    let now = SystemTime::now();
    for name in names {
        let full_path = Path::new(dir).join(&name);
        if let Some(max_age_ms) = max_age_ms {
            match tokio::fs::metadata(&full_path)
                .await
                .and_then(|m| m.modified())
            {
                Ok(mtime) => {
                    // Clock skew (mtime in the future) can't produce a
                    // duration via elapsed-since-mtime math; treat that as
                    // "not yet stale" rather than erroring, matching JS's
                    // `now - mtimeMs` producing a negative (< maxAgeMs) age.
                    let age_ms = now
                        .duration_since(mtime)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    if age_ms > max_age_ms {
                        continue;
                    }
                }
                Err(_) => continue,
            }
        }
        let t = match load_cursor_template(full_path.to_str().unwrap()).await? {
            Some(t) => t,
            None => continue,
        };
        if let Some(validate) = validate {
            if !validate(&t) {
                continue;
            }
        }
        out.push(t);
    }
    Ok(out)
}

/// Migrate a legacy single-template file into the set directory if the
/// directory is empty. Idempotent: re-running is a no-op once the set is
/// non-empty.
pub async fn migrate_legacy_template(legacy_path: &str, dir: &str) -> anyhow::Result<()> {
    if tokio::fs::metadata(legacy_path).await.is_err() {
        return Ok(());
    }
    let existing = load_template_set(dir, None, MaxAge::Default).await?;
    if !existing.is_empty() {
        return Ok(()); // already migrated or set non-empty
    }
    tokio::fs::create_dir_all(dir).await?;
    // Copy the legacy file in as the first set entry; we don't delete the
    // legacy file so older code paths continue to work, and so a manual
    // rollback is possible.
    let buf = tokio::fs::read(legacy_path).await?;
    tokio::fs::write(Path::new(dir).join("00.jpg"), &buf).await?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanDecision {
    Duplicate,
    Added,
    Replaced,
}

pub struct PlanResult {
    pub kept: Vec<CursorTemplate>,
    pub decision: PlanDecision,
}

/// Decide whether `candidate` should be added to `existing`. Returns the
/// updated set (new vec) and a decision describing what happened.
/// Stateless: callers persist the result if they want it on disk.
pub fn plan_addition(candidate: &CursorTemplate, existing: &[CursorTemplate]) -> PlanResult {
    for t in existing {
        let sim = template_similarity(candidate, t);
        if sim >= TEMPLATE_DEDUP_NCC {
            return PlanResult {
                kept: existing.to_vec(),
                decision: PlanDecision::Duplicate,
            };
        }
    }
    if existing.len() < TEMPLATE_SET_CAP {
        let mut kept = existing.to_vec();
        kept.push(candidate.clone());
        return PlanResult {
            kept,
            decision: PlanDecision::Added,
        };
    }
    // Cap reached — drop the first slot (oldest by load order) and append.
    let mut kept: Vec<CursorTemplate> = existing[1..].to_vec();
    kept.push(candidate.clone());
    PlanResult {
        kept,
        decision: PlanDecision::Replaced,
    }
}

/// Persist a candidate template to the set directory if `plan_addition`
/// decides to keep it. Returns the plan so the caller can update its
/// in-memory cache without re-reading the disk.
pub async fn persist_template(
    dir: &str,
    candidate: &CursorTemplate,
    existing: &[CursorTemplate],
) -> anyhow::Result<PlanResult> {
    let plan = plan_addition(candidate, existing);
    if plan.decision == PlanDecision::Duplicate {
        return Ok(plan);
    }

    tokio::fs::create_dir_all(dir).await?;

    if plan.decision == PlanDecision::Replaced {
        // Drop oldest file on disk to mirror the in-memory drop.
        let mut entries = tokio::fs::read_dir(dir).await?;
        let mut names: Vec<String> = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if let Some(name) = entry.file_name().to_str() {
                if is_jpeg_name(name) {
                    names.push(name.to_string());
                }
            }
        }
        names.sort();
        if let Some(oldest) = names.first() {
            tokio::fs::remove_file(Path::new(dir).join(oldest)).await?;
        }
    }

    // Write candidate as next sequence number. Uses a high-resolution
    // timestamp so concurrent writes don't clash; sorting orders
    // chronologically.
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .to_string();
    let stamp = &millis[millis.len().saturating_sub(10)..];
    let filename = format!("{stamp}.jpg");
    let path: PathBuf = Path::new(dir).join(filename);
    save_cursor_template(candidate, path.to_str().unwrap()).await?;
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient_template(seed: i64) -> CursorTemplate {
        let (w, h) = (24u32, 24u32);
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
        for i in 0..(w as usize) * (h as usize) {
            let x = (i % w as usize) as i64;
            let y = (i / w as usize) as i64;
            // Distinct per-seed gradient — guarantees low NCC between seeds
            // (templates of fundamentally different content).
            buf[i * 3] = ((x * 7 + seed * 53) & 0xff) as u8;
            buf[i * 3 + 1] = ((y * 11 + seed * 91) & 0xff) as u8;
            buf[i * 3 + 2] = (((x + y) * 5 + seed * 31) & 0xff) as u8;
        }
        CursorTemplate {
            rgb: buf,
            width: w,
            height: h,
            hotspot: None,
        }
    }

    // --- template_similarity ---------------------------------------------

    #[test]
    fn returns_approximately_1_for_identical_templates() {
        let t = gradient_template(7);
        assert!(template_similarity(&t, &t) > 0.99);
    }

    #[test]
    fn returns_below_dedup_threshold_for_distinct_gradient_seeds() {
        let a = gradient_template(0);
        let b = gradient_template(13);
        let sim = template_similarity(&a, &b);
        assert!(sim < TEMPLATE_DEDUP_NCC);
    }

    // --- plan_addition (dedup + cap policy) -------------------------------

    #[test]
    fn grows_the_set_when_candidate_is_perceptually_distinct() {
        let a = gradient_template(0);
        let b = gradient_template(7);
        let r = plan_addition(&b, &[a]);
        assert_eq!(r.decision, PlanDecision::Added);
        assert_eq!(r.kept.len(), 2);
    }

    #[test]
    fn treats_a_perceptually_similar_candidate_as_duplicate() {
        let a = gradient_template(3);
        let r = plan_addition(&a, std::slice::from_ref(&a));
        assert_eq!(r.decision, PlanDecision::Duplicate);
        assert_eq!(r.kept.len(), 1);
    }

    #[test]
    fn replaces_oldest_entry_when_the_set_is_at_the_cap() {
        let existing: Vec<CursorTemplate> = (1..=TEMPLATE_SET_CAP as i64)
            .map(gradient_template)
            .collect();
        let candidate = gradient_template(99); // distinct
        let r = plan_addition(&candidate, &existing);
        assert_eq!(r.decision, PlanDecision::Replaced);
        assert_eq!(r.kept.len(), TEMPLATE_SET_CAP);
        // First slot dropped — i.e. seed 1 no longer present.
        assert_eq!(r.kept[0].rgb, existing[1].rgb);
        assert_eq!(r.kept[r.kept.len() - 1].rgb, candidate.rgb);
    }

    // --- persist_template (disk-backed) -----------------------------------

    async fn temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{:?}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    #[tokio::test]
    async fn writes_a_new_file_and_grows_the_on_disk_set() {
        let dir = temp_dir("pikvm-tplset").await;
        let t1 = gradient_template(11);
        let r1 = persist_template(dir.to_str().unwrap(), &t1, &[])
            .await
            .unwrap();
        assert_eq!(r1.decision, PlanDecision::Added);
        let loaded = load_template_set(dir.to_str().unwrap(), None, MaxAge::Default)
            .await
            .unwrap();
        assert_eq!(loaded.len(), 1);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn skips_writing_when_candidate_is_a_duplicate() {
        let dir = temp_dir("pikvm-tplset").await;
        let t = gradient_template(11);
        persist_template(dir.to_str().unwrap(), &t, &[])
            .await
            .unwrap();
        let before = std::fs::read_dir(&dir).unwrap().count();
        let r = persist_template(dir.to_str().unwrap(), &t, std::slice::from_ref(&t))
            .await
            .unwrap();
        assert_eq!(r.decision, PlanDecision::Duplicate);
        let after = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(after, before);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    // --- migrate_legacy_template (one-time upgrade behaviour) --------------

    #[tokio::test]
    async fn adopts_a_legacy_single_file_template_into_an_empty_set_directory() {
        let root = temp_dir("pikvm-tplmig").await;
        let legacy_path = root.join("cursor-template.jpg");
        let dir = root.join("cursor-templates");
        save_cursor_template(&gradient_template(5), legacy_path.to_str().unwrap())
            .await
            .unwrap();

        migrate_legacy_template(legacy_path.to_str().unwrap(), dir.to_str().unwrap())
            .await
            .unwrap();

        let loaded = load_template_set(dir.to_str().unwrap(), None, MaxAge::Default)
            .await
            .unwrap();
        assert_eq!(loaded.len(), 1);
        // Legacy file should still exist (rollback safety — we copy, not move).
        assert!(tokio::fs::metadata(&legacy_path).await.is_ok());
        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[tokio::test]
    async fn is_a_no_op_when_the_set_directory_already_has_entries() {
        let root = temp_dir("pikvm-tplmig").await;
        let legacy_path = root.join("cursor-template.jpg");
        let dir = root.join("cursor-templates");
        save_cursor_template(&gradient_template(5), legacy_path.to_str().unwrap())
            .await
            .unwrap();
        tokio::fs::create_dir_all(&dir).await.unwrap();
        save_cursor_template(&gradient_template(99), dir.join("00.jpg").to_str().unwrap())
            .await
            .unwrap();

        migrate_legacy_template(legacy_path.to_str().unwrap(), dir.to_str().unwrap())
            .await
            .unwrap();

        let loaded = load_template_set(dir.to_str().unwrap(), None, MaxAge::Default)
            .await
            .unwrap();
        assert_eq!(loaded.len(), 1);
        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[tokio::test]
    async fn is_a_no_op_when_the_legacy_file_does_not_exist() {
        let root = temp_dir("pikvm-tplmig").await;
        let legacy_path = root.join("cursor-template.jpg");
        let dir = root.join("cursor-templates");

        migrate_legacy_template(legacy_path.to_str().unwrap(), dir.to_str().unwrap())
            .await
            .unwrap();

        let loaded = load_template_set(dir.to_str().unwrap(), None, MaxAge::Default)
            .await
            .unwrap();
        assert_eq!(loaded.len(), 0);
        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    // --- Phase 194-A: load_template_set validate callback -------------------

    #[tokio::test]
    async fn drops_templates_that_fail_the_validate_callback() {
        let dir = temp_dir("pikvm-validate").await;
        // Distinct seeds → distinct first-pixel R after JPEG round-trip:
        // seed=1 -> ~52, seed=2 -> ~105, seed=99 -> ~151. Reject anything
        // with R > 130 — only seed=99 fails.
        save_cursor_template(&gradient_template(1), dir.join("01.jpg").to_str().unwrap())
            .await
            .unwrap();
        save_cursor_template(&gradient_template(99), dir.join("02.jpg").to_str().unwrap())
            .await
            .unwrap();
        save_cursor_template(&gradient_template(2), dir.join("03.jpg").to_str().unwrap())
            .await
            .unwrap();

        let validate = |t: &CursorTemplate| t.rgb[0] <= 130;
        let loaded = load_template_set(dir.to_str().unwrap(), Some(&validate), MaxAge::Default)
            .await
            .unwrap();
        assert_eq!(loaded.len(), 2);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn keeps_all_templates_when_no_validator_is_supplied() {
        let dir = temp_dir("pikvm-validate").await;
        save_cursor_template(&gradient_template(11), dir.join("01.jpg").to_str().unwrap())
            .await
            .unwrap();
        save_cursor_template(&gradient_template(99), dir.join("02.jpg").to_str().unwrap())
            .await
            .unwrap();
        let loaded = load_template_set(dir.to_str().unwrap(), None, MaxAge::Default)
            .await
            .unwrap();
        assert_eq!(loaded.len(), 2);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    // --- Phase 196: load_template_set max_age TTL ---------------------------

    #[tokio::test]
    async fn drops_templates_whose_mtime_is_older_than_max_age() {
        let dir = temp_dir("pikvm-ttl").await;
        let old_file = dir.join("01-old.jpg");
        let new_file = dir.join("02-new.jpg");
        save_cursor_template(&gradient_template(1), old_file.to_str().unwrap())
            .await
            .unwrap();
        save_cursor_template(&gradient_template(2), new_file.to_str().unwrap())
            .await
            .unwrap();

        // Backdate the first file by 7 hours.
        let seven_hours_ago = SystemTime::now() - std::time::Duration::from_secs(7 * 60 * 60);
        set_mtime(&old_file, seven_hours_ago);

        // 6h TTL -> old file dropped, new file kept.
        let loaded = load_template_set(
            dir.to_str().unwrap(),
            None,
            MaxAge::Millis(6 * 60 * 60 * 1000),
        )
        .await
        .unwrap();
        assert_eq!(loaded.len(), 1);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn honors_max_age_disabled_to_skip_the_ttl_check() {
        let dir = temp_dir("pikvm-ttl").await;
        let old_file = dir.join("01-old.jpg");
        save_cursor_template(&gradient_template(1), old_file.to_str().unwrap())
            .await
            .unwrap();
        let long_time_ago = SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 60 * 60);
        set_mtime(&old_file, long_time_ago);

        let loaded = load_template_set(dir.to_str().unwrap(), None, MaxAge::Disabled)
            .await
            .unwrap();
        assert_eq!(loaded.len(), 1);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn default_ttl_drops_a_24_hour_old_template() {
        let dir = temp_dir("pikvm-ttl").await;
        let file = dir.join("01.jpg");
        save_cursor_template(&gradient_template(1), file.to_str().unwrap())
            .await
            .unwrap();
        let one_day_ago = SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
        set_mtime(&file, one_day_ago);

        // No explicit max_age -> uses MaxAge::Default (6h).
        let loaded = load_template_set(dir.to_str().unwrap(), None, MaxAge::Default)
            .await
            .unwrap();
        assert_eq!(loaded.len(), 0);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    fn set_mtime(path: &Path, t: SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(t).unwrap();
    }
}
