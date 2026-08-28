//! Workflow prompts — multi-step recipes combining several PiKVM tools.
//!
//! F11 (Round 2 Phase 2d): served guide text loads directly from
//! `docs/skills/*.md` at runtime (see `skill_docs.rs`) — `docs/skills/`
//! is the source of truth, not a separately-maintained embedded copy.
//! The short fixed "user" role message each workflow opens with stays
//! inline here (it's UI/protocol framing, not part of "the guide" — the
//! docs/skills/ files never carried it). The 4 parameterized workflows'
//! docs carry real `{{placeholder}}` tokens; `interpolate_skill_doc`
//! substitutes them with the SAME already-resolved display value
//! (including each workflow's own distinct fallback text) the TS source
//! computes before interpolating.
//!
//! Faithful port of `src/prompts/workflows.ts`.

use std::collections::HashMap;

use super::skill_docs::{interpolate_skill_doc, load_skill_doc};
use super::types::{PromptArgument, PromptDefinition, PromptMessage, PromptRole};

fn user_message(text: String) -> PromptMessage {
    PromptMessage {
        role: PromptRole::User,
        text,
    }
}

fn assistant_message(text: String) -> PromptMessage {
    PromptMessage {
        role: PromptRole::Assistant,
        text,
    }
}

fn arg_or<'a>(args: Option<&'a HashMap<String, String>>, key: &str, fallback: &'a str) -> String {
    args.and_then(|a| a.get(key))
        .map(String::as_str)
        .unwrap_or(fallback)
        .to_string()
}

pub fn workflow_prompts() -> Vec<PromptDefinition> {
    vec![
        PromptDefinition {
            name: "setup-session-workflow",
            description: "Step-by-step procedure for initializing a PiKVM session",
            arguments: vec![],
            get_messages: Box::new(|_args| {
                Ok(vec![
                    user_message(
                        "I need to start a new PiKVM session and make sure everything is working before I begin interacting with the remote machine."
                            .to_string(),
                    ),
                    assistant_message(load_skill_doc("setup-session-workflow")?),
                ])
            }),
        },
        PromptDefinition {
            name: "calibrate-mouse-workflow",
            description: "Step-by-step procedure for calibrating mouse coordinates",
            arguments: vec![],
            get_messages: Box::new(|_args| {
                Ok(vec![
                    user_message("I need to calibrate the mouse so that click coordinates are accurate.".to_string()),
                    assistant_message(load_skill_doc("calibrate-mouse-workflow")?),
                ])
            }),
        },
        PromptDefinition {
            name: "auto-calibrate-mouse-workflow",
            description: "Step-by-step procedure for automatic mouse calibration",
            arguments: vec![],
            get_messages: Box::new(|_args| {
                Ok(vec![
                    user_message("I need to automatically calibrate the mouse for accurate clicking.".to_string()),
                    assistant_message(load_skill_doc("auto-calibrate-mouse-workflow")?),
                ])
            }),
        },
        PromptDefinition {
            name: "click-ui-element-workflow",
            description: "Step-by-step procedure for finding and clicking a UI element",
            arguments: vec![PromptArgument {
                name: "element_description".to_string(),
                description: "Description of the UI element to click (e.g., \"the Save button\", \"the File menu\")".to_string(),
                required: true,
            }],
            get_messages: Box::new(|args| {
                let element = arg_or(args, "element_description", "[not specified]");
                Ok(vec![
                    user_message(format!("I need to click on: {element}")),
                    assistant_message({
                        let mut values = HashMap::new();
                        values.insert("element_description".to_string(), element);
                        interpolate_skill_doc(&load_skill_doc("click-ui-element-workflow")?, &values)
                    }),
                ])
            }),
        },
        PromptDefinition {
            name: "fill-form-workflow",
            description: "Step-by-step procedure for filling in a form on screen",
            arguments: vec![PromptArgument {
                name: "form_description".to_string(),
                description: "Description of the form or the fields to fill in".to_string(),
                required: false,
            }],
            get_messages: Box::new(|args| {
                let form = arg_or(args, "form_description", "the visible form");
                Ok(vec![
                    user_message(format!("I need to fill in {form}.")),
                    assistant_message({
                        let mut values = HashMap::new();
                        values.insert("form_description".to_string(), form);
                        interpolate_skill_doc(&load_skill_doc("fill-form-workflow")?, &values)
                    }),
                ])
            }),
        },
        PromptDefinition {
            name: "ipad-keyboard-first-workflow",
            description: "Keyboard-first iPad workflow that bypasses cursor positioning — e.g. launch apps via Spotlight (Cmd+Space → type app name → Enter). Prefer over pikvm_mouse_click_at whenever a keyboard equivalent exists; cursor clicks on tiny (<50px) iPad targets are unreliable due to pointer-acceleration variance.",
            arguments: vec![PromptArgument {
                name: "goal".to_string(),
                description: "What you want to accomplish on the iPad (e.g., \"open Settings and find Wi-Fi\", \"search Files for a document\")".to_string(),
                required: true,
            }],
            get_messages: Box::new(|args| {
                let goal = arg_or(args, "goal", "[not specified]");
                Ok(vec![
                    user_message(format!("iPad goal: {goal}")),
                    assistant_message({
                        let mut values = HashMap::new();
                        values.insert("goal".to_string(), goal);
                        interpolate_skill_doc(&load_skill_doc("ipad-keyboard-first-workflow")?, &values)
                    }),
                ])
            }),
        },
        PromptDefinition {
            name: "navigate-desktop-workflow",
            description: "Step-by-step procedure for navigating a desktop environment",
            arguments: vec![PromptArgument {
                name: "goal".to_string(),
                description: "What you want to accomplish (e.g., \"open Firefox\", \"find and open a file\")".to_string(),
                required: true,
            }],
            get_messages: Box::new(|args| {
                let goal = arg_or(args, "goal", "[not specified]");
                Ok(vec![
                    user_message(format!("I need to navigate the desktop to: {goal}")),
                    assistant_message({
                        let mut values = HashMap::new();
                        values.insert("goal".to_string(), goal);
                        interpolate_skill_doc(&load_skill_doc("navigate-desktop-workflow")?, &values)
                    }),
                ])
            }),
        },
        PromptDefinition {
            name: "desktop-workflow",
            description: "Set up a generic desktop for reliable mouse control: --target desktop, auto-calibrate, absolute positioning (vs the iPad path)",
            arguments: vec![],
            get_messages: Box::new(|_args| {
                Ok(vec![
                    user_message("How do I reliably drive a normal desktop (not an iPad) through this PiKVM MCP server?".to_string()),
                    assistant_message(load_skill_doc("desktop-workflow")?),
                ])
            }),
        },
    ]
}

#[cfg(test)]
mod tests;
