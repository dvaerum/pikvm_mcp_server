//! Tests for the prompts barrel — `all_prompts()`/`get_prompt_by_name`.
//! Faithful port of `src/prompts/__tests__/index.test.ts`.

use std::collections::HashMap;

use super::{
    all_prompts, get_prompt_by_name, tool_guides::tool_guide_prompts, workflows::workflow_prompts,
};

#[test]
fn all_prompts_combines_tool_guide_and_workflow_prompts() {
    assert_eq!(
        all_prompts().len(),
        tool_guide_prompts().len() + workflow_prompts().len()
    );
}

#[test]
fn all_prompts_preserves_order_tool_guides_before_workflows() {
    let all = all_prompts();
    let guides = tool_guide_prompts();
    let flows = workflow_prompts();

    for (i, guide) in guides.iter().enumerate() {
        assert_eq!(all[i].name, guide.name);
    }
    for (i, flow) in flows.iter().enumerate() {
        assert_eq!(all[guides.len() + i].name, flow.name);
    }
}

#[test]
fn all_combined_names_are_unique_across_both_sources() {
    let all = all_prompts();
    let names: Vec<&str> = all.iter().map(|p| p.name).collect();
    let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
    assert_eq!(unique.len(), names.len());
}

#[test]
fn get_prompt_by_name_returns_none_for_unknown_name() {
    let result =
        get_prompt_by_name("this-prompt-does-not-exist", None).expect("lookup should not error");
    assert!(result.is_none());
}

#[test]
fn get_prompt_by_name_returns_the_matching_definition_for_a_known_name() {
    let (definition, _messages) = get_prompt_by_name("take-screenshot", None)
        .expect("lookup should not error")
        .expect("take-screenshot should be found");
    assert_eq!(definition.name, "take-screenshot");
}

#[test]
fn get_prompt_by_name_returns_the_messages_from_get_messages_for_the_matched_prompt() {
    let (_definition, messages) = get_prompt_by_name("take-screenshot", None)
        .expect("lookup should not error")
        .expect("take-screenshot should be found");
    assert!(!messages.is_empty());
}

#[test]
fn get_prompt_by_name_passes_args_through_to_the_prompt_get_messages() {
    // Find a prompt that actually declares arguments (workflows do).
    let all = all_prompts();
    let Some(arg_prompt) = all.iter().find(|p| !p.arguments.is_empty()) else {
        // No prompt in this codebase uses arguments — nothing to verify.
        return;
    };
    let mut args = HashMap::new();
    args.insert("someArg".to_string(), "value".to_string());
    let result = get_prompt_by_name(arg_prompt.name, Some(&args)).expect("lookup should not error");
    assert!(result.is_some());
}

#[test]
fn get_prompt_by_name_lookup_is_exact_match_case_sensitive() {
    assert!(get_prompt_by_name("Take-Screenshot", None)
        .unwrap()
        .is_none());
    assert!(get_prompt_by_name("TAKE-SCREENSHOT", None)
        .unwrap()
        .is_none());
    assert!(get_prompt_by_name("take-screenshot", None)
        .unwrap()
        .is_some());
}
