//! Auto-generates MCP tools from prompt definitions so that skill/guide
//! content is discoverable via `tools/list` (e.g. in marketplace
//! listings) in addition to `prompts/list`.
//!
//! Faithful port of `src/prompts/skill-tools.ts`. Depends directly on
//! `rmcp::model::Tool`/`ToolAnnotations` — unlike the hand-rolled,
//! protocol-agnostic `ToolEntry` shape in `tools.rs`, the TS source
//! itself imports the wire-protocol `Tool` type here (this module's
//! whole job is generating real MCP tool descriptors from prompts), so
//! there's no decoupling to preserve. `handle_skill_tool_call` returns
//! the joined message text rather than a `ToolOutcome` — `server.rs`'s
//! `call_tool` (which already owns the `ToolOutcome` conversion for
//! every other path) wraps it, keeping this module's only rmcp
//! dependency the `Tool`/`ToolAnnotations` types used to build the list.

use std::collections::HashMap;

use rmcp::model::{Tool, ToolAnnotations};
use serde_json::{Map, Value};

use super::{all_prompts, get_prompt_by_name, PromptArgument};

/// `'take-screenshot'` → `'skill_take_screenshot'`.
fn prompt_name_to_tool_name(name: &str) -> String {
    format!("skill_{}", name.replace('-', "_"))
}

/// `'skill_take_screenshot'` → `'take-screenshot'`.
fn tool_name_to_prompt_name(name: &str) -> String {
    name["skill_".len()..].replace('_', "-")
}

fn build_properties(args: &[PromptArgument]) -> Map<String, Value> {
    args.iter()
        .map(|a| {
            (
                a.name.clone(),
                serde_json::json!({"type": "string", "description": a.description}),
            )
        })
        .collect()
}

fn build_required(args: &[PromptArgument]) -> Vec<String> {
    args.iter()
        .filter(|a| a.required)
        .map(|a| a.name.clone())
        .collect()
}

/// Every prompt, mirrored as a `Tool` with a `string`-typed property per
/// declared argument. Faithful port of the TS `skillTools` const —
/// including its annotations (read-only, non-destructive, idempotent,
/// closed-world: these tools only ever read back static/templated guide
/// text, they never touch the device).
pub fn skill_tools() -> Vec<Tool> {
    all_prompts()
        .into_iter()
        .map(|prompt| {
            let required = build_required(&prompt.arguments);
            let mut schema = Map::new();
            schema.insert("type".to_string(), Value::String("object".to_string()));
            schema.insert(
                "properties".to_string(),
                Value::Object(build_properties(&prompt.arguments)),
            );
            if !required.is_empty() {
                schema.insert(
                    "required".to_string(),
                    Value::Array(required.into_iter().map(Value::String).collect()),
                );
            }
            Tool::new(
                prompt_name_to_tool_name(prompt.name),
                prompt.description.to_string(),
                schema,
            )
            .with_annotations(ToolAnnotations::from_raw(
                None,
                Some(true),
                Some(false),
                Some(true),
                Some(false),
            ))
        })
        .collect()
}

/// True when `name` belongs to a skill tool. Faithful port of `isSkillTool`.
pub fn is_skill_tool(name: &str) -> bool {
    name.starts_with("skill_")
}

/// Handle a skill tool call by delegating to the underlying prompt,
/// returning the joined message text. Faithful port of
/// `handleSkillToolCall`; `Err` on an unknown skill tool name mirrors the
/// TS `throw` — the caller routes it through the same
/// sanitize_error/operator-hint path as any other tool-dispatch error.
pub fn handle_skill_tool_call(name: &str, args: &Map<String, Value>) -> anyhow::Result<String> {
    let prompt_name = tool_name_to_prompt_name(name);
    // Only string-valued args reach the prompt — matches the TS source's
    // own `typeof v === 'string'` filter (prompts only ever interpolate
    // plain text into their templates).
    let string_args: HashMap<String, String> = args
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect();
    let Some((_, messages)) = get_prompt_by_name(&prompt_name, Some(&string_args))? else {
        anyhow::bail!("Unknown skill tool: {name}");
    };
    Ok(messages
        .into_iter()
        .map(|m| m.text)
        .collect::<Vec<_>>()
        .join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_tools_mirrors_all_prompts_one_tool_per_prompt() {
        assert_eq!(skill_tools().len(), all_prompts().len());
    }

    #[test]
    fn every_tool_name_follows_the_skill_snake_case_convention() {
        for t in skill_tools() {
            assert!(t.name.starts_with("skill_"));
            assert!(t
                .name
                .chars()
                .skip("skill_".len())
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'));
        }
    }

    #[test]
    fn every_tool_has_a_non_empty_description() {
        for t in skill_tools() {
            let description = t
                .description
                .expect("skill tool should carry a description");
            assert!(!description.is_empty());
        }
    }

    #[test]
    fn every_tool_has_a_type_object_input_schema() {
        for t in skill_tools() {
            assert_eq!(
                t.input_schema.get("type").and_then(Value::as_str),
                Some("object")
            );
        }
    }

    #[test]
    fn a_prompt_with_a_required_argument_exposes_it_in_the_schema() {
        // click-ui-element-workflow declares element_description as required.
        let t = skill_tools()
            .into_iter()
            .find(|t| t.name == "skill_click_ui_element_workflow")
            .expect("skill_click_ui_element_workflow should exist");
        let required = t
            .input_schema
            .get("required")
            .and_then(Value::as_array)
            .expect("required array should be present");
        assert!(required.contains(&Value::String("element_description".to_string())));
    }

    #[test]
    fn a_prompt_with_no_arguments_has_no_required_field() {
        // setup-session-workflow has no arguments.
        let t = skill_tools()
            .into_iter()
            .find(|t| t.name == "skill_setup_session_workflow")
            .expect("skill_setup_session_workflow should exist");
        assert!(t.input_schema.get("required").is_none());
    }

    #[test]
    fn every_tool_is_annotated_read_only_non_destructive_idempotent_closed_world() {
        for t in skill_tools() {
            let annotations = t.annotations.expect("skill tool should carry annotations");
            assert_eq!(annotations.read_only_hint, Some(true));
            assert_eq!(annotations.destructive_hint, Some(false));
            assert_eq!(annotations.idempotent_hint, Some(true));
            assert_eq!(annotations.open_world_hint, Some(false));
        }
    }

    #[test]
    fn is_skill_tool_true_for_names_with_the_prefix() {
        assert!(is_skill_tool("skill_take_screenshot"));
        assert!(is_skill_tool("skill_anything"));
    }

    #[test]
    fn is_skill_tool_false_for_names_without_the_prefix() {
        assert!(!is_skill_tool("take_screenshot"));
        assert!(!is_skill_tool("pikvm_mouse_click_at"));
        assert!(!is_skill_tool(""));
    }

    #[test]
    fn is_skill_tool_is_exact_prefix_sensitive() {
        assert!(!is_skill_tool("skills_x"));
    }

    #[test]
    fn handle_skill_tool_call_returns_text_for_a_known_skill_tool() {
        let result = handle_skill_tool_call("skill_take_screenshot", &Map::new()).unwrap();
        assert!(!result.is_empty());
    }

    #[test]
    fn handle_skill_tool_call_passes_string_args_through_to_the_underlying_prompt() {
        let mut args = Map::new();
        args.insert(
            "element_description".to_string(),
            Value::String("the Save button".to_string()),
        );
        let result = handle_skill_tool_call("skill_click_ui_element_workflow", &args).unwrap();
        assert!(result.contains("the Save button"));
    }

    #[test]
    fn handle_skill_tool_call_filters_non_string_args() {
        let mut args = Map::new();
        args.insert(
            "element_description".to_string(),
            Value::String("sentinel".to_string()),
        );
        args.insert("noise".to_string(), Value::Number(12345.into()));
        args.insert("flag".to_string(), Value::Bool(true));
        let result = handle_skill_tool_call("skill_click_ui_element_workflow", &args).unwrap();
        assert!(result.contains("sentinel"));
    }

    #[test]
    fn handle_skill_tool_call_errors_on_unknown_skill_tool_name() {
        let err = handle_skill_tool_call("skill_does_not_exist", &Map::new()).unwrap_err();
        assert!(err.to_string().contains("Unknown skill tool"));
    }

    #[test]
    fn handle_skill_tool_call_round_trips_name_conversion() {
        assert!(handle_skill_tool_call("skill_take_screenshot", &Map::new()).is_ok());
    }
}
