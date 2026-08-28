//! Structural contract tests for `tool_guide_prompts()`. Faithful port of
//! `src/prompts/__tests__/tool-guides.test.ts`.
//!
//! Every `get_messages()` call here goes through the REAL production
//! `load_skill_doc`/`resolve_skills_dir()` path (not a fixture) — the
//! `#[cfg(test)]` `CARGO_MANIFEST_DIR`-relative candidate in
//! `skill_docs.rs::resolve_skills_dir` is what makes that resolve
//! correctly regardless of `cargo test`'s actual working directory.

use super::tool_guide_prompts;
use crate::prompts::types::PromptRole;

#[test]
fn contains_at_least_one_prompt() {
    assert!(!tool_guide_prompts().is_empty());
}

#[test]
fn every_prompt_has_a_non_empty_name() {
    for p in tool_guide_prompts() {
        assert!(!p.name.is_empty());
    }
}

#[test]
fn every_prompt_has_a_non_empty_description() {
    for p in tool_guide_prompts() {
        assert!(!p.description.is_empty());
    }
}

#[test]
fn all_prompt_names_are_unique() {
    let prompts = tool_guide_prompts();
    let names: Vec<&str> = prompts.iter().map(|p| p.name).collect();
    let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
    assert_eq!(unique.len(), names.len());
}

#[test]
fn get_messages_returns_a_non_empty_array_on_every_prompt() {
    for p in tool_guide_prompts() {
        let messages = (p.get_messages)(None).expect("get_messages should succeed");
        assert!(!messages.is_empty());
    }
}

#[test]
fn every_message_has_a_valid_role_and_non_empty_content() {
    for p in tool_guide_prompts() {
        let messages = (p.get_messages)(None).expect("get_messages should succeed");
        for m in messages {
            assert!(matches!(m.role, PromptRole::User | PromptRole::Assistant));
            assert!(!m.text.is_empty());
        }
    }
}

#[test]
fn every_prompt_name_uses_kebab_case() {
    let is_kebab = |s: &str| {
        !s.is_empty()
            && s.split('-').all(|part| {
                !part.is_empty()
                    && part.chars().next().unwrap().is_ascii_lowercase()
                    && part
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            })
            && s.chars().next().unwrap().is_ascii_lowercase()
    };
    for p in tool_guide_prompts() {
        assert!(is_kebab(p.name), "{} is not kebab-case", p.name);
    }
}
