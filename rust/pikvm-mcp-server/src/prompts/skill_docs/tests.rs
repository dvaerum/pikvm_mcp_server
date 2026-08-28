//! Tests for `skill_docs`: the read+cache logic (via `load_skill_doc_from`,
//! parameterized by a fixture directory so real `current_exe()`/cwd
//! resolution doesn't need to cooperate under `cargo test`) and
//! `interpolate_skill_doc`'s substitution contract.

use super::*;
use std::io::Write;

fn write_fixture(dir: &tempfile::TempDir, name: &str, content: &str) {
    let path = dir.path().join(format!("{name}.md"));
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all(content.as_bytes()).unwrap();
}

mod load_skill_doc_from_tests {
    use super::*;

    #[test]
    fn loads_the_file_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        write_fixture(&dir, "example", "# Example\n\nBody text.\n");
        let content = load_skill_doc_from(dir.path(), "example").unwrap();
        assert_eq!(content, "# Example\n\nBody text.\n");
    }

    #[test]
    fn errors_on_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_skill_doc_from(dir.path(), "does-not-exist").is_err());
    }

    #[test]
    fn caches_after_the_first_read_a_later_file_change_is_not_picked_up() {
        let dir = tempfile::tempdir().unwrap();
        write_fixture(&dir, "cached-example", "version 1");
        let first = load_skill_doc_from(dir.path(), "cached-example").unwrap();
        assert_eq!(first, "version 1");

        write_fixture(&dir, "cached-example", "version 2");
        let second = load_skill_doc_from(dir.path(), "cached-example").unwrap();
        // Cached: still "version 1", the file's own process-lifetime cache
        // contract (see this module's doc comment).
        assert_eq!(second, "version 1");
    }

    #[test]
    fn different_directories_with_the_same_skill_name_do_not_collide() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        write_fixture(&dir_a, "shared-name", "from A");
        write_fixture(&dir_b, "shared-name", "from B");
        assert_eq!(
            load_skill_doc_from(dir_a.path(), "shared-name").unwrap(),
            "from A"
        );
        assert_eq!(
            load_skill_doc_from(dir_b.path(), "shared-name").unwrap(),
            "from B"
        );
    }
}

mod interpolate_skill_doc_tests {
    use super::*;

    #[test]
    fn substitutes_a_known_token() {
        let values: HashMap<String, String> = [("name".to_string(), "World".to_string())].into();
        assert_eq!(
            interpolate_skill_doc("Hello, {{name}}!", &values),
            "Hello, World!"
        );
    }

    #[test]
    fn substitutes_multiple_distinct_tokens() {
        let values: HashMap<String, String> = [
            ("a".to_string(), "1".to_string()),
            ("b".to_string(), "2".to_string()),
        ]
        .into();
        assert_eq!(interpolate_skill_doc("{{a}} and {{b}}", &values), "1 and 2");
    }

    #[test]
    fn repeats_the_same_token_at_every_occurrence() {
        let values: HashMap<String, String> = [("x".to_string(), "Z".to_string())].into();
        assert_eq!(interpolate_skill_doc("{{x}}-{{x}}-{{x}}", &values), "Z-Z-Z");
    }

    #[test]
    fn leaves_an_unknown_token_untouched_fails_loudly_rather_than_blanking() {
        let values: HashMap<String, String> = HashMap::new();
        assert_eq!(
            interpolate_skill_doc("{{typo_token}} stays visible", &values),
            "{{typo_token}} stays visible"
        );
    }

    #[test]
    fn text_with_no_tokens_passes_through_unchanged() {
        let values: HashMap<String, String> = HashMap::new();
        assert_eq!(
            interpolate_skill_doc("plain text, no braces", &values),
            "plain text, no braces"
        );
    }

    #[test]
    fn a_lone_unmatched_double_brace_is_left_as_is() {
        let values: HashMap<String, String> = HashMap::new();
        assert_eq!(
            interpolate_skill_doc("open {{ but never closed", &values),
            "open {{ but never closed"
        );
    }
}
