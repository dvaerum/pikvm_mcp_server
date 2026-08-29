//! Barrel module for all MCP prompts.
//!
//! Faithful port of `src/prompts/index.ts`. Split into one file per
//! logical group (types/skill_docs/tool_guides/workflows/skill_tools)
//! from the start, matching this port's own established layout — the TS
//! source was already split this way, so no crate-placement or
//! file-structure finding was needed here, just a straightforward
//! multi-file port.

mod skill_docs;
pub mod skill_tools;
mod tool_guides;
mod types;
mod workflows;

pub use types::{PromptArgument, PromptDefinition, PromptMessage, PromptRole};

use std::collections::HashMap;

pub fn all_prompts() -> Vec<PromptDefinition> {
    let mut prompts = tool_guides::tool_guide_prompts();
    prompts.extend(workflows::workflow_prompts());
    prompts
}

/// Look up a prompt by name and return its messages (with arguments
/// interpolated). Returns `Ok(None)` if the prompt is not found;
/// `Err(...)` propagates a `get_messages` failure (e.g. a missing skill
/// doc) — matching the TS source's own shape (`{definition, messages} |
/// undefined`, which THROWS rather than returning `undefined` when
/// `getMessages()` itself fails; only a genuine name-miss returns
/// `undefined`).
pub fn get_prompt_by_name(
    name: &str,
    args: Option<&HashMap<String, String>>,
) -> anyhow::Result<Option<(PromptDefinition, Vec<PromptMessage>)>> {
    let Some(definition) = all_prompts().into_iter().find(|p| p.name == name) else {
        return Ok(None);
    };
    let messages = (definition.get_messages)(args)?;
    Ok(Some((definition, messages)))
}

#[cfg(test)]
mod tests;
