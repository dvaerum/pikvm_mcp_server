//! Tool guide prompts — one per PiKVM tool that agents commonly use.
//!
//! F11 (Round 2 Phase 2d): served text loads directly from
//! `docs/skills/*.md` at runtime (see `skill_docs.rs`) — `docs/skills/`
//! is the source of truth, not a separately-maintained embedded copy.
//!
//! Faithful port of `src/prompts/tool-guides.ts`. Each entry there is
//! purely mechanical (name + description + `loadSkillDoc(name)`) — a
//! `simple_guide` constructor here avoids re-spelling the same
//! boilerplate 14 times, without changing any entry's actual behavior.

use super::skill_docs::load_skill_doc;
use super::types::{PromptDefinition, PromptMessage, PromptRole};

fn simple_guide(name: &'static str, description: &'static str) -> PromptDefinition {
    PromptDefinition {
        name,
        description,
        arguments: vec![],
        get_messages: Box::new(move |_args| {
            Ok(vec![PromptMessage {
                role: PromptRole::Assistant,
                text: load_skill_doc(name)?,
            }])
        }),
    }
}

pub fn tool_guide_prompts() -> Vec<PromptDefinition> {
    vec![
        simple_guide("take-screenshot", "Guide for capturing screenshots with pikvm_screenshot"),
        simple_guide(
            "check-resolution",
            "Guide for checking screen resolution with pikvm_get_resolution",
        ),
        simple_guide("type-text", "Guide for typing text with pikvm_type"),
        simple_guide("send-key", "Guide for sending keys with pikvm_key"),
        simple_guide(
            "send-shortcut",
            "Guide for sending keyboard shortcuts with pikvm_shortcut",
        ),
        simple_guide("move-mouse", "Guide for moving the mouse with pikvm_mouse_move"),
        simple_guide("click-element", "Guide for clicking with pikvm_mouse_click"),
        simple_guide(
            "auto-calibrate",
            "Guide for automatic mouse calibration with pikvm_auto_calibrate",
        ),
        simple_guide("scroll-page", "Guide for scrolling with pikvm_mouse_scroll"),
        simple_guide(
            "detect-orientation",
            "Guide for pikvm_detect_orientation — find the iPad letterbox bounds within the HDMI capture",
        ),
        simple_guide("ipad-unlock", "Guide for unlocking an iPad via pikvm_ipad_unlock"),
        simple_guide(
            "measure-ballistics",
            "Guide for characterizing relative-mouse ballistics with pikvm_measure_ballistics",
        ),
        simple_guide("move-to", "Guide for approximate move-to-pixel with pikvm_mouse_move_to"),
        simple_guide(
            "click-at",
            "Guide for click-at-coordinate with pikvm_mouse_click_at",
        ),
    ]
}

#[cfg(test)]
mod tests;
