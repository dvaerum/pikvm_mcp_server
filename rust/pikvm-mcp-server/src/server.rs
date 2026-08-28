//! The MCP server surface: shared (module-global-equivalent) state, the
//! per-session `PikvmMcpServer` handler, and the gating pipeline in front
//! of tool dispatch.
//!
//! Faithful port of `src/index.ts`'s `createMcpServer` factory + its
//! module-level state. `SharedState` holds what `index.ts` keeps as
//! module globals (`pikvm`, `lock`, ...) — ONE instance, constructed once
//! in `main`, wrapped in `Arc` and shared by every per-session
//! `PikvmMcpServer`. `PikvmMcpServer` itself is the cheap per-session
//! wrapper the TS factory mints fresh per Streamable-HTTP session (or
//! once, for stdio) — mirroring why `createMcpServer` is a factory and
//! not a singleton: concurrent HTTP clients must not share one `Server`'s
//! JSON-RPC request-id space.
//!
//! Phase A (this increment) wires: `get_info`, `list_prompts`/`get_prompt`
//! (delegating to the already-ported `prompts` crate module), and
//! `list_tools`/`call_tool` with the busy-lock gate + the try/sanitize
//! wrapper around dispatch. NOT yet wired (later phases, see
//! docs/rust-port-plan.md §7 item 6): the login gate's `ListTools`
//! filtering (stdio never passes a gate, so `gate` is always `None` until
//! http-server.rs lands), the HID-mode mover gate, and the
//! absolute/relative-mouse gate (both need `HidModeResolver`, not ported
//! into this crate yet).

use std::sync::{Arc, Mutex};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, GetPromptRequestParams,
    GetPromptResponse, GetPromptResult, Implementation, InitializeRequestParams, InitializeResult,
    ListPromptsResult, ListToolsResult, PaginatedRequestParams, Prompt, PromptArgument,
    PromptMessage as RmcpPromptMessage, ProtocolVersion, Role, ServerCapabilities, ServerInfo,
    Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::Value;

use pikvm_mcp_foundation::lock::BusyLock;
use pikvm_mcp_foundation::session_auth::LoginGate;
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::prompts as prompt_defs;
use crate::tools::{self, ToolContent, ToolEntry, ToolOutcome};

/// Module-global-equivalent state, shared across every session. Grows in
/// later phases (hid_mode_resolver, cached_profile, recovery_trigger,
/// udc_state_reader — see index.ts) as the tools that need them are
/// ported in.
pub struct SharedState {
    pub client: Arc<PiKVMClient>,
    pub lock: Mutex<BusyLock>,
    pub tools: Vec<ToolEntry>,
}

impl SharedState {
    pub fn new(client: PiKVMClient) -> Self {
        Self {
            client: Arc::new(client),
            lock: Mutex::new(BusyLock::new()),
            tools: tools::tool_registry(),
        }
    }
}

/// The unprefixed `login` tool — deliberately not `pikvm_*` (a
/// session/transport concern, not a device op). Faithful port of
/// `LOGIN_TOOL`. Only ever surfaced when a `LoginGate` is present
/// (Streamable HTTP + `--allow-tool-login`, wired in a later phase);
/// stdio never exposes it.
fn login_tool() -> Tool {
    Tool::new(
        "login",
        "Authenticate THIS MCP session with your username and password (your PiKVM/kvmd \
         credentials when the server runs in kvmd mode). Required before any other tool when \
         the server enforces authentication and you did not present an Authorization header at \
         connect. On success the full tool set unlocks for this session. The password is not \
         logged or echoed.",
        Arc::new(
            serde_json::json!({
                "type": "object",
                "properties": {
                    "username": {"type": "string", "description": "Username (your PiKVM/kvmd user in kvmd mode)."},
                    "password": {"type": "string", "description": "Password. Not logged or echoed."}
                },
                "required": ["username", "password"]
            })
            .as_object()
            .unwrap()
            .clone(),
        ),
    )
}

#[derive(Clone)]
pub struct PikvmMcpServer {
    shared: Arc<SharedState>,
    /// `None` for stdio and for header-only HTTP auth; `Some` only for a
    /// Streamable-HTTP session opened under `--allow-tool-login` (wired in
    /// a later phase — always `None` today).
    gate: Option<Arc<LoginGate>>,
}

impl PikvmMcpServer {
    pub fn new(shared: Arc<SharedState>, gate: Option<Arc<LoginGate>>) -> Self {
        Self { shared, gate }
    }
}

fn to_call_tool_result(outcome: ToolOutcome) -> CallToolResult {
    let content = outcome
        .content
        .into_iter()
        .map(|c| match c {
            ToolContent::Text(text) => ContentBlock::text(text),
            ToolContent::Image { data, mime_type } => ContentBlock::image(data, mime_type),
        })
        .collect();
    if outcome.is_error {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    }
}

/// Sanitize an error message the same way `index.ts`'s central catch does:
/// strip credential-shaped substrings, then append an operator hint for
/// known-recoverable patterns. Faithful port of the `CallToolRequestSchema`
/// handler's `catch` block.
fn sanitize_error(err: &anyhow::Error) -> String {
    let raw = err.to_string();
    let re_passwd = regex_replace_ci(&raw, "X-KVMD-Passwd", "X-KVMD-Passwd=[REDACTED]");
    let re_password = regex_replace_password(&re_passwd);
    pikvm_mcp_kvmd_client::operator_hints::append_operator_hint(&re_password)
}

/// `X-KVMD-Passwd[^,\s]*` → `X-KVMD-Passwd=[REDACTED]`, case-insensitive on
/// the literal prefix (the TS regex's `/gi` flag). Hand-rolled rather than
/// pulling in the `regex` crate for two fixed literal-prefix substitutions.
fn regex_replace_ci(input: &str, prefix: &str, replacement: &str) -> String {
    let lower_input = input.to_lowercase();
    let lower_prefix = prefix.to_lowercase();
    let Some(start) = lower_input.find(&lower_prefix) else {
        return input.to_string();
    };
    let rest = &input[start + prefix.len()..];
    let end_offset = rest
        .find(|c: char| c == ',' || c.is_whitespace())
        .unwrap_or(rest.len());
    format!(
        "{}{}{}",
        &input[..start],
        replacement,
        &input[start + prefix.len() + end_offset..]
    )
}

/// `password[=:][^\s,]*` → `password=[REDACTED]`, case-insensitive.
fn regex_replace_password(input: &str) -> String {
    let lower_input = input.to_lowercase();
    let Some(start) = lower_input.find("password") else {
        return input.to_string();
    };
    let after_word = start + "password".len();
    let Some(sep) = input[after_word..]
        .chars()
        .next()
        .filter(|c| *c == '=' || *c == ':')
    else {
        return input.to_string();
    };
    let value_start = after_word + sep.len_utf8();
    let rest = &input[value_start..];
    let end_offset = rest
        .find(|c: char| c == ',' || c.is_whitespace())
        .unwrap_or(rest.len());
    format!(
        "{}{}{}",
        &input[..start],
        "password=[REDACTED]",
        &input[value_start + end_offset..]
    )
}

impl ServerHandler for PikvmMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_prompts()
                .build(),
        )
        .with_server_info(Implementation::new(
            "pikvm-mcp-server",
            pikvm_mcp_foundation::version::VERSION,
        ))
        .with_protocol_version(ProtocolVersion::LATEST)
    }

    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, McpError> {
        let mut info = self.get_info();
        info.protocol_version = request.protocol_version.clone();
        let _ = context;
        Ok(info)
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, McpError> {
        let prompts = prompt_defs::all_prompts()
            .into_iter()
            .map(|p| {
                let arguments = p
                    .arguments
                    .into_iter()
                    .map(|a| {
                        PromptArgument::new(a.name)
                            .with_description(a.description)
                            .with_required(a.required)
                    })
                    .collect();
                Prompt::new(p.name, Some(p.description), Some(arguments))
            })
            .collect();
        Ok(ListPromptsResult {
            prompts,
            ..Default::default()
        })
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, McpError> {
        let args: Option<std::collections::HashMap<String, String>> =
            request.arguments.map(|obj| {
                obj.into_iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
                    .collect()
            });
        let found = prompt_defs::get_prompt_by_name(&request.name, args.as_ref())
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        let Some((definition, messages)) = found else {
            return Err(McpError::invalid_params(
                format!("Unknown prompt: {}", request.name),
                None,
            ));
        };
        let messages = messages
            .into_iter()
            .map(|m| {
                let role = match m.role {
                    prompt_defs::PromptRole::User => Role::User,
                    prompt_defs::PromptRole::Assistant => Role::Assistant,
                };
                RmcpPromptMessage::new_text(role, m.text)
            })
            .collect();
        Ok(GetPromptResult::new(messages)
            .with_description(definition.description.to_string())
            .into())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        // Pre-auth (login gate present, session not yet authenticated):
        // expose ONLY the login tool — don't leak the full tool surface
        // before authentication. Faithful port of the TS `ListTools`
        // handler's gate check.
        if let Some(gate) = &self.gate {
            if !gate.session.is_authenticated() {
                return Ok(ListToolsResult {
                    tools: vec![login_tool()],
                    ..Default::default()
                });
            }
        }
        let tools = self
            .shared
            .tools
            .iter()
            .map(|t| {
                Tool::new(
                    t.name,
                    t.description.clone(),
                    json_object_arc(&t.input_schema),
                )
            })
            .collect();
        Ok(ListToolsResult {
            tools,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let name = request.name.to_string();
        let args = request.arguments.unwrap_or_default();

        // Login gate (--allow-tool-login). The `login` tool is the ONLY
        // tool callable on a pre-auth session; everything else is refused
        // until it authenticates. Faithful port of index.ts's login-gate
        // block.
        if let Some(gate) = &self.gate {
            if name == "login" {
                let username = args.get("username").and_then(Value::as_str);
                let password = args.get("password").and_then(Value::as_str);
                let (Some(username), Some(password)) = (username, password) else {
                    return Ok(to_call_tool_result(ToolOutcome::error_text(
                        "Error: login requires string \"username\" and \"password\".",
                    ))
                    .into());
                };
                if gate.session.is_authenticated() {
                    return Ok(to_call_tool_result(ToolOutcome::text(
                        "Already authenticated for this session.",
                    ))
                    .into());
                }
                let ok = gate.login(username, password).await;
                return Ok(to_call_tool_result(if ok {
                    ToolOutcome::text("Authentication successful — session authorized. All tools are now available.")
                } else {
                    ToolOutcome::error_text("Error: authentication failed — invalid username or password.")
                })
                .into());
            }
            if !gate.session.is_authenticated() {
                return Ok(to_call_tool_result(ToolOutcome::error_text(
                    "Error: authentication required — call the 'login' tool with your username and password first.",
                ))
                .into());
            }
        }

        // Block other tools while a long-running op (auto-calibration or
        // ballistics measurement) is in progress. The excluded tools are
        // allowed through so their own handlers can return a more
        // specific error. (pikvm_auto_calibrate/pikvm_measure_ballistics
        // land in a later phase; the exclusion is pre-declared here so
        // adding them later doesn't require touching this gate.)
        {
            let lock = self.shared.lock.lock().unwrap();
            if lock.is_busy()
                && name != "pikvm_auto_calibrate"
                && name != "pikvm_measure_ballistics"
            {
                let holder = lock.holder().unwrap_or("").to_string();
                drop(lock);
                return Ok(to_call_tool_result(ToolOutcome::error_text(format!(
                    "Error: {holder} in progress, please wait."
                )))
                .into());
            }
        }

        // TODO(Module 6 later phase): HID-mode mover gate + absolute/
        // relative-mouse gate — both need HidModeResolver, not ported
        // into this crate yet (see docs/rust-port-plan.md §7 item 6).

        let entry = self.shared.tools.iter().find(|t| t.name == name);
        let Some(entry) = entry else {
            return Ok(to_call_tool_result(ToolOutcome::error_text(format!(
                "Error: Unknown tool: {name}"
            )))
            .into());
        };

        match (entry.handler)(self.shared.clone(), args).await {
            Ok(outcome) => Ok(to_call_tool_result(outcome).into()),
            Err(err) => Ok(to_call_tool_result(ToolOutcome::error_text(format!(
                "Error: {}",
                sanitize_error(&err)
            )))
            .into()),
        }
    }
}

fn json_object_arc(value: &Value) -> Arc<serde_json::Map<String, Value>> {
    Arc::new(value.as_object().cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_call_tool_result_maps_content_and_is_error() {
        let outcome = ToolOutcome::text("hello");
        let result = to_call_tool_result(outcome);
        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.content.len(), 1);

        let outcome = ToolOutcome::error_text("boom");
        let result = to_call_tool_result(outcome);
        assert_eq!(result.is_error, Some(true));
    }

    #[test]
    fn to_call_tool_result_carries_both_text_and_image_blocks() {
        let outcome = ToolOutcome::text_and_image("caption", "base64data", "image/jpeg");
        let result = to_call_tool_result(outcome);
        assert_eq!(result.content.len(), 2);
    }

    // -- sanitize_error / its two regex-replacement helpers --

    #[test]
    fn redacts_an_x_kvmd_passwd_header_case_insensitively() {
        let msg = regex_replace_ci(
            "PiKVM API error 401: x-kvmd-passwd=hunter2, other=stuff",
            "X-KVMD-Passwd",
            "X-KVMD-Passwd=[REDACTED]",
        );
        assert_eq!(
            msg,
            "PiKVM API error 401: X-KVMD-Passwd=[REDACTED], other=stuff"
        );
    }

    #[test]
    fn redact_helpers_leave_a_message_with_no_match_untouched() {
        assert_eq!(
            regex_replace_ci("nothing sensitive here", "X-KVMD-Passwd", "[REDACTED]"),
            "nothing sensitive here"
        );
        assert_eq!(
            regex_replace_password("nothing sensitive here"),
            "nothing sensitive here"
        );
    }

    #[test]
    fn redacts_a_password_value_up_to_the_next_comma_or_whitespace() {
        assert_eq!(
            regex_replace_password("connect failed, password=hunter2 retrying"),
            "connect failed, password=[REDACTED] retrying"
        );
        assert_eq!(
            regex_replace_password("password:hunter2,next=field"),
            "password=[REDACTED],next=field"
        );
    }

    #[test]
    fn sanitize_error_strips_credentials_and_appends_an_operator_hint_where_applicable() {
        let err = anyhow::anyhow!("PiKVM API error 503: UnavailableError, password=hunter2");
        let sanitized = sanitize_error(&err);
        assert!(!sanitized.contains("hunter2"));
        assert!(sanitized.contains("password=[REDACTED]"));
        assert!(sanitized.contains("Source-side outage suspected")); // operator-hints.rs's 503+UnavailableError hint
    }
}
