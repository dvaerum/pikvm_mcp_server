//! Structural + argument-interpolation contract tests for
//! `workflow_prompts()`. Faithful port of
//! `src/prompts/__tests__/workflows.test.ts`.

use std::collections::HashMap;

use super::workflow_prompts;
use crate::prompts::types::PromptRole;

fn all_text(messages: &[crate::prompts::types::PromptMessage]) -> String {
    messages
        .iter()
        .map(|m| m.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn contains_at_least_one_workflow() {
    assert!(!workflow_prompts().is_empty());
}

#[test]
fn every_workflow_has_a_name_and_description() {
    for p in workflow_prompts() {
        assert!(!p.name.is_empty());
        assert!(!p.description.is_empty());
    }
}

#[test]
fn every_workflow_name_uses_kebab_case() {
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
    for p in workflow_prompts() {
        assert!(is_kebab(p.name), "{} is not kebab-case", p.name);
    }
}

#[test]
fn every_workflow_has_a_callable_get_messages_returning_non_empty() {
    for p in workflow_prompts() {
        let messages = (p.get_messages)(None).expect("get_messages should succeed");
        assert!(!messages.is_empty());
    }
}

#[test]
fn every_declared_argument_has_a_name() {
    for p in workflow_prompts() {
        for arg in &p.arguments {
            assert!(!arg.name.is_empty());
        }
    }
}

#[test]
fn all_workflow_names_are_unique() {
    let prompts = workflow_prompts();
    let names: Vec<&str> = prompts.iter().map(|p| p.name).collect();
    let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
    assert_eq!(unique.len(), names.len());
}

#[test]
fn click_ui_element_workflow_embeds_element_description() {
    let prompts = workflow_prompts();
    let p = prompts
        .iter()
        .find(|w| w.name == "click-ui-element-workflow")
        .expect("click-ui-element-workflow should exist");
    let mut args = HashMap::new();
    args.insert(
        "element_description".to_string(),
        "the Save button".to_string(),
    );
    let messages = (p.get_messages)(Some(&args)).expect("get_messages should succeed");
    assert!(all_text(&messages).contains("the Save button"));
}

#[test]
fn click_ui_element_workflow_falls_back_to_placeholder_when_arg_missing() {
    let prompts = workflow_prompts();
    let p = prompts
        .iter()
        .find(|w| w.name == "click-ui-element-workflow")
        .expect("click-ui-element-workflow should exist");
    let messages = (p.get_messages)(None).expect("get_messages should succeed");
    let text = all_text(&messages);
    assert!(!text.contains("undefined"));
    assert!(text.contains("[not specified]"));
}

#[test]
fn fill_form_workflow_embeds_form_description() {
    let prompts = workflow_prompts();
    let p = prompts
        .iter()
        .find(|w| w.name == "fill-form-workflow")
        .expect("fill-form-workflow should exist");
    let mut args = HashMap::new();
    args.insert(
        "form_description".to_string(),
        "a contact form with name and email".to_string(),
    );
    let messages = (p.get_messages)(Some(&args)).expect("get_messages should succeed");
    assert!(all_text(&messages).contains("a contact form"));
}

#[test]
fn navigate_desktop_workflow_embeds_goal() {
    let prompts = workflow_prompts();
    let p = prompts
        .iter()
        .find(|w| w.name == "navigate-desktop-workflow")
        .expect("navigate-desktop-workflow should exist");
    let mut args = HashMap::new();
    args.insert("goal".to_string(), "open Settings".to_string());
    let messages = (p.get_messages)(Some(&args)).expect("get_messages should succeed");
    assert!(all_text(&messages).contains("open Settings"));
}

#[test]
fn every_workflow_with_declared_arguments_uses_them_in_generated_message() {
    // Catches the regression where a workflow declares an arg but forgets
    // to interpolate it (silently ignoring user input).
    for p in workflow_prompts() {
        if p.arguments.is_empty() {
            continue;
        }
        for arg in &p.arguments {
            let sentinel = format!("__SENTINEL_{}_VALUE__", arg.name);
            let mut args = HashMap::new();
            args.insert(arg.name.clone(), sentinel.clone());
            let messages = (p.get_messages)(Some(&args)).expect("get_messages should succeed");
            let text = all_text(&messages);
            assert!(
                text.contains(&sentinel),
                "workflow {} did not interpolate declared argument {}",
                p.name,
                arg.name
            );
        }
    }
}

#[test]
fn role_sanity_every_message_is_user_or_assistant() {
    for p in workflow_prompts() {
        let messages = (p.get_messages)(None).expect("get_messages should succeed");
        for m in messages {
            assert!(matches!(m.role, PromptRole::User | PromptRole::Assistant));
        }
    }
}
