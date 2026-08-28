//! Single source of truth for the MCP server version.
//!
//! Faithful port of `src/version.ts`. Bump this AND the TypeScript
//! `package.json`/`src/version.ts` together during the parallel-build period
//! (ADR-0002) — a test asserts this stays in sync with the JS source's
//! `VERSION` constant so the two implementations can't silently drift while
//! both exist.
//!
//! The constant is surfaced via the `pikvm_version` MCP tool and the MCP
//! protocol's server-info `version` field, so a stale deployment can be
//! detected by querying the running server instead of inspecting its
//! filesystem.

pub const VERSION: &str = "0.5.250";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_the_typescript_source_of_truth() {
        // Faithful-port parity check (ADR-0002's "match existing JS behavior
        // exactly" discipline): read src/version.ts directly rather than
        // hardcoding a duplicate literal here, so this test actually catches
        // drift instead of just restating VERSION back at itself.
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let ts_path = std::path::Path::new(manifest_dir).join("../../src/version.ts");
        let ts_source = std::fs::read_to_string(&ts_path)
            .unwrap_or_else(|e| panic!("couldn't read {}: {e}", ts_path.display()));
        let ts_version = ts_source
            .lines()
            .find_map(|line| {
                let line = line.trim();
                line.strip_prefix("export const VERSION = '")
                    .and_then(|rest| rest.strip_suffix("';"))
            })
            .unwrap_or_else(|| panic!("couldn't find VERSION export in {}", ts_path.display()));
        assert_eq!(
            VERSION, ts_version,
            "rust/foundation's VERSION drifted from src/version.ts"
        );
    }
}
