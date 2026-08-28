//! The `pikvm_*` tool registry — faithful port of `src/index.ts`'s
//! `toolRegistry`/`toolsByName`/`ToolEntry` shape.
//!
//! DESIGN DECISION (documented per the plan's §6 "record hand-rolling
//! justification" rule): `index.ts` does NOT use zod — it hand-validates
//! args with permissive clamp-not-reject/default-not-reject semantics
//! (see `tool_helpers.rs`) via a flat array of `{name, description,
//! inputSchema, handler}` entries, looked up by name at dispatch time.
//! rmcp's `#[tool_router]`/`#[tool]` macros generate STRICT schemas via
//! `schemars` from typed `Parameters<T>` extractors — the opposite
//! semantics, and would reject inputs the TS server has always accepted.
//! This module keeps the TS source's own manual-registry shape (raw JSON
//! Schema + a name→entry map) and `server.rs` wires it into rmcp's
//! `ServerHandler::list_tools`/`call_tool` by hand — using rmcp for what
//! it's actually worth not hand-rolling (JSON-RPC framing, session
//! management, SSE transport), not its schema-generation sugar.
//!
//! `ToolOutcome`/`ToolContent` are this crate's own faithful mirror of the
//! TS `CallToolResult` shape, deliberately decoupled from rmcp's own
//! `CallToolResult` type — `server.rs` is the only place that converts
//! between them, so individual tool handlers never need to know about
//! rmcp at all (same separation `prompts.rs` already keeps from the
//! wire-protocol layer).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use base64::Engine as _;
use serde_json::{Map, Value};

use crate::server::SharedState;

mod basic;
mod calibration;
mod hid;
mod ipad_unlock;
mod orientation;
mod screenshot;
mod seed_template;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Base64-encode image bytes for a `ToolContent::Image` block. Shared
/// helper so every image-returning tool encodes the same way.
pub(crate) fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// One content block of a tool's result. Faithful mirror of the TS
/// `CallToolResult.content` entries (`{type:'text', text}` /
/// `{type:'image', data, mimeType}`).
#[derive(Debug, Clone)]
pub enum ToolContent {
    Text(String),
    Image { data: String, mime_type: String },
}

/// Faithful mirror of the TS `CallToolResult` shape (content blocks +
/// `isError`), independent of any particular wire protocol crate.
#[derive(Debug, Clone, Default)]
pub struct ToolOutcome {
    pub content: Vec<ToolContent>,
    pub is_error: bool,
}

impl ToolOutcome {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::Text(text.into())],
            is_error: false,
        }
    }

    pub fn error_text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::Text(text.into())],
            is_error: true,
        }
    }

    pub fn text_and_image(
        text: impl Into<String>,
        data: impl Into<String>,
        mime_type: impl Into<String>,
    ) -> Self {
        Self {
            content: vec![
                ToolContent::Text(text.into()),
                ToolContent::Image {
                    data: data.into(),
                    mime_type: mime_type.into(),
                },
            ],
            is_error: false,
        }
    }
}

/// A tool handler: takes the shared (module-global-equivalent) server
/// state plus the call's raw JSON `arguments` object, returns a result
/// whose `Err` is caught-and-sanitized by `server.rs::call_tool`
/// (mirroring `index.ts`'s central `try/catch` around every handler
/// call) — a validation failure (`require_string` etc.) and a
/// `ClientError` from a REST call both flow through the same path.
pub type ToolHandlerFn = Arc<
    dyn Fn(Arc<SharedState>, Map<String, Value>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>>
        + Send
        + Sync,
>;

pub struct ToolEntry {
    pub name: &'static str,
    pub description: String,
    /// Raw JSON Schema (an `{"type":"object","properties":{...}}` value),
    /// matching `index.ts`'s own `inputSchema` object literals verbatim —
    /// not derived from a Rust type via `schemars`.
    pub input_schema: Value,
    pub handler: ToolHandlerFn,
}

/// Build the real tool registry. Phase A of the Module 6 rmcp integration:
/// a representative subset of `index.ts`'s 37 entries, proving the
/// dispatch pattern end-to-end before the remaining tools are added
/// mechanically in the same shape (see docs/rust-port-plan.md §7 item 6).
pub fn tool_registry() -> Vec<ToolEntry> {
    let mut tools = basic::entries();
    tools.extend(screenshot::entries());
    tools.extend(calibration::entries());
    tools.extend(hid::entries());
    tools.extend(orientation::entries());
    tools.extend(seed_template::entries());
    tools.extend(ipad_unlock::entries());
    tools
}
