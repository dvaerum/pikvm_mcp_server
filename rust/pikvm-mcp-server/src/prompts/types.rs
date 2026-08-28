//! Internal types for defining MCP prompts.
//!
//! Faithful port of `src/prompts/types.ts`.

#[derive(Debug, Clone)]
pub struct PromptArgument {
    pub name: String,
    pub description: String,
    pub required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptRole {
    User,
    Assistant,
}

#[derive(Debug, Clone)]
pub struct PromptMessage {
    pub role: PromptRole,
    /// The TS source's `content` is `{ type: 'text'; text: string }` — a
    /// single-variant discriminated union today. Kept as a plain `text`
    /// field rather than an enum-of-one; widen to an enum if a second
    /// content type is ever added upstream.
    pub text: String,
}

/// `get_messages` mirrors the TS source's `getMessages(args?:
/// Record<string, string>)` closure shape — implemented here as a boxed
/// `Fn` rather than a trait per prompt, matching this port's established
/// DI convention for small per-item behavior (see
/// `pikvm_mcp_ipad_hid`'s endpoint closures). Returns `anyhow::Result`
/// rather than a bare `Vec` — TS's `loadSkillDoc` throws synchronously
/// on a missing/unreadable doc file, which `getMessages()` lets
/// propagate; the Rust equivalent is a per-call `Result` rather than a
/// process-wide panic, so one broken prompt call doesn't take the whole
/// server down.
pub type GetMessagesFn = Box<
    dyn Fn(Option<&std::collections::HashMap<String, String>>) -> anyhow::Result<Vec<PromptMessage>>
        + Send
        + Sync,
>;

/// A single MCP prompt definition.
pub struct PromptDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub arguments: Vec<PromptArgument>,
    pub get_messages: GetMessagesFn,
}
