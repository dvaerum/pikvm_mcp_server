//! Skill-doc loader — F11 (Round 2 Phase 2d): `docs/skills/*.md` is the
//! source of truth for every MCP prompt's served text (tool guides +
//! workflows). Before this, each prompt's guide text was maintained
//! TWICE: once as a template literal embedded in tool-guides.ts/
//! workflows.ts (what MCP clients actually received) and once as a
//! human-readable mirror in docs/skills/*.md — the two had already
//! drifted. Loading directly from the doc at runtime makes that drift
//! structurally impossible: there is only one copy.
//!
//! RAW file content is served as-is — no stripping/reformatting layer
//! between "the doc" and "what's served" (a transformation layer could
//! itself go stale, reopening the exact problem this exists to close).
//!
//! Faithful port of `src/prompts/skill-docs.ts`. Resolution logic is
//! adapted, not faithfully ported byte-for-byte: the TS version resolves
//! `docs/skills/` relative to `import.meta.url` (its own compiled module
//! path) against nix/package.nix's Node install layout
//! (`lib/node_modules/<pkg>/{dist,docs/skills}`, siblings). The Rust
//! binary's own eventual nix packaging doesn't exist yet — this resolves
//! relative to the RUNNING EXECUTABLE's directory instead
//! (`std::env::current_exe()`), trying `<exe_dir>/../docs/skills` (a
//! `bin/` + `docs/skills` sibling layout) first, then falling back to
//! `./docs/skills` under the process cwd for a dev/source-tree run —
//! same two-candidate shape as the TS original. Revisit the bundled
//! candidate path once the real nix package for this binary is written.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

fn resolve_skills_dir() -> PathBuf {
    // Test-only candidate: `cargo test`'s cwd is this crate's own
    // directory (`rust/pikvm-mcp-server/`), not the repo root the real
    // `docs/skills/` lives under — neither the bundled nor cwd-relative
    // candidate below can find it under `cargo test`. `CARGO_MANIFEST_DIR`
    // is resolved at COMPILE time (always this crate's Cargo.toml
    // directory, deterministic regardless of the actual test-run cwd) —
    // same pattern already used by `cursor_ml_detect.rs`'s real-model
    // tests for the same "real repo asset, not a fixture" problem.
    #[cfg(test)]
    let manifest_relative = Some(
        std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/skills"))
            .to_path_buf(),
    );
    #[cfg(not(test))]
    let manifest_relative: Option<PathBuf> = None;

    let bundled = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .map(|exe_dir| exe_dir.join("..").join("docs").join("skills"));
    let cwd_local = std::env::current_dir()
        .ok()
        .map(|cwd| cwd.join("docs").join("skills"));

    for candidate in [manifest_relative, bundled, cwd_local]
        .into_iter()
        .flatten()
    {
        if candidate.exists() {
            return candidate;
        }
    }
    // Neither candidate exists — return the bundled path anyway (matches
    // the TS `?? bundled` fallback) so the caller's read attempt produces
    // a clear "file not found" error naming the path it tried, rather
    // than a confusing empty path.
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .map(|exe_dir| exe_dir.join("..").join("docs").join("skills"))
        .unwrap_or_else(|| PathBuf::from("docs/skills"))
}

static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Load `docs/skills/<name>.md` verbatim (cached after the first read —
/// the server's process lifetime is what's cached against, not
/// per-request).
pub fn load_skill_doc(name: &str) -> std::io::Result<String> {
    load_skill_doc_from(&resolve_skills_dir(), name)
}

/// The actual read+cache logic, parameterized by directory so tests can
/// exercise it against a fixture directory without needing to control
/// `current_exe()`/cwd. Cache key is the full resolved path (not just
/// `name`) so tests using different fixture directories can't collide
/// with each other or with a real `docs/skills/` read in the same
/// process — real production behavior is unaffected since it only ever
/// resolves one directory per process.
pub(crate) fn load_skill_doc_from(dir: &std::path::Path, name: &str) -> std::io::Result<String> {
    let file_path = dir.join(format!("{name}.md"));
    let cache_key = file_path.to_string_lossy().to_string();
    {
        let cache = CACHE.lock().unwrap();
        if let Some(map) = cache.as_ref() {
            if let Some(content) = map.get(&cache_key) {
                return Ok(content.clone());
            }
        }
    }
    let content = std::fs::read_to_string(&file_path)?;
    let mut cache = CACHE.lock().unwrap();
    cache
        .get_or_insert_with(HashMap::new)
        .insert(cache_key, content.clone());
    Ok(content)
}

/// Substitute `{{key}}` tokens in a loaded doc against a plain string
/// map. Deliberately dumb: the CALLER resolves whatever default/fallback
/// a missing argument should show (each parameterized workflow's
/// fallback text differs) and passes the already-resolved display value
/// in; this function only does the substitution. A token with no
/// matching key is left untouched rather than silently blanked, so a
/// typo in a doc's `{{...}}` marker fails loudly (visible in the served
/// text) instead of disappearing.
pub fn interpolate_skill_doc(template: &str, values: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    loop {
        let Some(start) = rest.find("{{") else {
            out.push_str(rest);
            break;
        };
        let Some(end_rel) = rest[start + 2..].find("}}") else {
            out.push_str(rest);
            break;
        };
        let end = start + 2 + end_rel;
        let key = &rest[start + 2..end];
        // Match the TS regex's `\w+` — only interpolate tokens whose key
        // is word-characters only; anything else is left untouched
        // (including the braces), same as a non-matching literal.
        if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
            out.push_str(&rest[..start]);
            match values.get(key) {
                Some(v) => out.push_str(v),
                None => out.push_str(&rest[start..end + 2]),
            }
        } else {
            out.push_str(&rest[..end + 2]);
        }
        rest = &rest[end + 2..];
    }
    out
}

#[cfg(test)]
mod tests;
