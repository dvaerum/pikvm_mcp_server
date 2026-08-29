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
//! Wires: `get_info`, `list_prompts`/`get_prompt` (delegating to the
//! already-ported `prompts` crate module), and `list_tools`/`call_tool`
//! with the busy-lock gate, the HID-mode mover gate, the absolute/
//! relative-mouse gate, and the try/sanitize wrapper around dispatch. NOT
//! yet wired (a later phase, see docs/rust-port-plan.md §7 item 6): the
//! login gate's `ListTools` filtering — stdio never passes a gate, so
//! `gate` is always `None` until `http-server.rs` lands.

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

use pikvm_mcp_foundation::auth::HeaderAuthorizer;
use pikvm_mcp_foundation::lock::BusyLock;
use pikvm_mcp_foundation::session_auth::LoginGate;
use pikvm_mcp_ipad_hid::hid_mode::HidModeResolver;
use pikvm_mcp_kvmd_client::client::PiKVMClient;

use crate::prompts as prompt_defs;
use crate::tools::{self, ToolContent, ToolEntry, ToolOutcome};

/// Module-global-equivalent state, shared across every session. Grows in
/// later phases (recovery_trigger, udc_state_reader — see index.ts) as
/// the tools that need them are ported in.
pub struct SharedState {
    pub client: Arc<PiKVMClient>,
    pub lock: Mutex<BusyLock>,
    /// `tokio::sync::Mutex` (not `std::sync::Mutex`): `resolve()`/`set()`
    /// are `async fn`s that need the lock held across their whole `.await`
    /// chain (a real HTTP round-trip for the endpoint-derived case) — a
    /// std `MutexGuard` held across an await point is a real footgun
    /// (blocks the executor thread, risks deadlock), which is exactly why
    /// tokio ships its own async-aware `Mutex` for this shape.
    pub hid_mode_resolver: tokio::sync::Mutex<HidModeResolver>,
    /// EXPERIMENTAL (#41), off by default. `ScaleLearner`'s own methods
    /// are all sync — a plain `std::sync::Mutex` is fine here (never held
    /// across an `.await`, unlike `hid_mode_resolver` above).
    pub scale_learner: Mutex<pikvm_mcp_mover::scale_learner::ScaleLearner>,
    pub calibration_config: pikvm_mcp_foundation::config::CalibrationConfig,
    /// Refreshed by `pikvm_measure_ballistics` on a successful measurement
    /// (matching index.ts's own `cachedProfile = result.profile`); no
    /// current reader — `pikvm_mouse_move_to`, its only real consumer, is
    /// blocked on move-to.ts (see docs/rust-port-plan.md §7 item 6).
    pub cached_profile: Mutex<Option<pikvm_mcp_mover::ballistics::BallisticsProfile>>,
    pub tools: Vec<ToolEntry>,
}

impl SharedState {
    pub fn new(
        client: PiKVMClient,
        hid_mode_resolver: HidModeResolver,
        scale_learner: pikvm_mcp_mover::scale_learner::ScaleLearner,
        calibration_config: pikvm_mcp_foundation::config::CalibrationConfig,
        cached_profile: Option<pikvm_mcp_mover::ballistics::BallisticsProfile>,
    ) -> Self {
        Self {
            client: Arc::new(client),
            lock: Mutex::new(BusyLock::new()),
            hid_mode_resolver: tokio::sync::Mutex::new(hid_mode_resolver),
            scale_learner: Mutex::new(scale_learner),
            calibration_config,
            cached_profile: Mutex::new(cached_profile),
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

/// Deployment-wide auth config, shared (immutably) by every session's
/// `PikvmMcpServer` instance minted from the same `StreamableHttpService`
/// factory. `None` `authorize` = `--security no`. `allow_tool_login` is
/// only meaningful when `authorize` is `Some` (matches
/// `http-server.ts`'s own `allowToolLogin = Boolean(opts.allowToolLogin)
/// && Boolean(authorize)` guard).
#[derive(Clone, Default)]
pub struct PikvmAuthConfig {
    pub authorize: Option<HeaderAuthorizer>,
    pub allow_tool_login: bool,
}

/// A custom axum request extension `http_server.rs`'s auth middleware
/// inserts, carrying whether THIS request's `Authorization` header was
/// valid — read back inside `initialize()` via `RequestContext::extensions`
/// (which nests axum's own `Extension` data inside the propagated
/// `http::request::Parts`, per rmcp's own documented pattern) to seed the
/// session's initial `SessionAuthState` without re-running the
/// authorizer a second time.
#[derive(Clone, Copy, Debug)]
pub struct HeaderAuthed(pub bool);

#[derive(Clone)]
pub struct PikvmMcpServer {
    shared: Arc<SharedState>,
    auth: Arc<PikvmAuthConfig>,
    /// Populated once, in `initialize()` — the ONLY place a session's
    /// initial authenticated state is known. `None` for stdio (no HTTP
    /// context to read a header from) and for HTTP sessions where
    /// `allow_tool_login` isn't configured (the strict header-at-connect
    /// path already fully gates those at the axum middleware layer,
    /// before rmcp is ever reached — nothing left for the tool layer to
    /// enforce). Interior-mutable (not a constructor param) because the
    /// factory that mints this struct has no per-request context to hand
    /// it — see `http_server.rs`'s own header comment on why the auth
    /// decision has to happen this late.
    session_gate: Arc<Mutex<Option<Arc<LoginGate>>>>,
}

impl PikvmMcpServer {
    pub fn new(shared: Arc<SharedState>, auth: Arc<PikvmAuthConfig>) -> Self {
        Self {
            shared,
            auth,
            session_gate: Arc::new(Mutex::new(None)),
        }
    }

    fn gate(&self) -> Option<Arc<LoginGate>> {
        self.session_gate.lock().unwrap().clone()
    }
}

/// Derives a session's initial authenticated state from the rmcp
/// `initialize` request's [`rmcp::model::Extensions`] — pulled out of
/// `initialize()` as its own pure function so the extraction logic (nested
/// `Parts`-inside-`Extensions` lookup, `HeaderAuthed`, and the "no HTTP
/// context ⇒ trust it" default) is unit-testable without needing a full
/// `RequestContext`. Defaults to `authenticated = true` both for stdio (no
/// `Parts` present at all) and for a valid-header HTTP connect (`Parts`
/// present, but `require_auth` only ever inserts `HeaderAuthed` on the
/// pre-auth admission path — see `http_server.rs`) — only an explicit
/// `HeaderAuthed(false)` opens a pre-auth session.
fn authenticated_from_extensions(extensions: &rmcp::model::Extensions) -> bool {
    extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<HeaderAuthed>())
        .map(|h| h.0)
        .unwrap_or(true)
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

/// Pointer-driving tools whose correctness depends on the HID mode: in
/// endpoint mode these are REFUSED while the mode is unknown (unreachable)
/// or settling (post-switch re-enumeration). Keyboard/screenshot/health/
/// recovery are deliberately excluded — they work regardless of mouse
/// mode. Faithful port of index.ts's `MODE_SENSITIVE_TOOLS` — cross-
/// checked there by `mcp-hidmode-gate.test.ts` so a new pointer-driving
/// tool can't slip in unguarded; this port doesn't have that meta-test
/// yet (deferred with the rest of the gate/schema-exposure test family,
/// see the Phase B batch 1 commit message), so this list is the single
/// source of truth for now — keep it in sync by hand.
const MODE_SENSITIVE_TOOLS: &[&str] = &[
    "pikvm_mouse_move",
    "pikvm_mouse_click",
    "pikvm_mouse_scroll",
    "pikvm_mouse_move_to",
    "pikvm_mouse_click_at",
    "pikvm_calibrate",
    "pikvm_auto_calibrate",
    "pikvm_measure_ballistics",
    "pikvm_seed_cursor_template",
    "pikvm_ipad_unlock",
    "pikvm_ipad_unlock_with_code",
    "pikvm_ipad_lock",
    "pikvm_ipad_home",
    "pikvm_ipad_app_switcher",
    "pikvm_ipad_launch_app",
    "pikvm_dismiss_popup",
];

const ABSOLUTE_MOUSE_NOTE: &str = "This target reports mouse.absolute=false (typical for iPad / boot-mouse HID). \
     Use the relative-mode tools instead: pikvm_ipad_unlock, pikvm_mouse_move with relative:true, \
     pikvm_mouse_click_at, pikvm_mouse_move_to, pikvm_mouse_click. See docs/skills/ipad-keyboard-workflow.md \
     for the recommended pattern.";

const RELATIVE_MOUSE_NOTE: &str = "This target reports mouse.absolute=true (desktop, dual absolute+relative gadget). \
     A forced relative:true emit here is a documented silent no-op (see ADR 0002: relative reports into an \
     absolute-assembled gadget are accepted by kvmd but never delivered) — pass absolute pixel coordinates \
     instead (omit relative, or pass relative:false), or use pikvm_mouse_move_to / pikvm_mouse_click_at, which \
     already select the correct strategy for this mode.";

/// The single source of truth for "which calls need mouse.absolute=true".
/// Faithful port of index.ts's `ABSOLUTE_MOUSE_GATE`/`requiresAbsoluteMouse`.
fn requires_absolute_mouse(name: &str, args: &serde_json::Map<String, Value>) -> bool {
    match name {
        "pikvm_calibrate"
        | "pikvm_set_calibration"
        | "pikvm_get_calibration"
        | "pikvm_clear_calibration"
        | "pikvm_auto_calibrate" => true,
        // Absolute unless relative:true.
        "pikvm_mouse_move" => args.get("relative").and_then(Value::as_bool) != Some(true),
        // The SHAPE of the call decides: x/y mean absolute pixels.
        "pikvm_mouse_click" => {
            args.get("x").and_then(Value::as_f64).is_some()
                && args.get("y").and_then(Value::as_f64).is_some()
        }
        _ => false,
    }
}

/// The mirror of `requires_absolute_mouse`: "which calls need
/// mouse.absolute=false" (an explicit FORCED relative emit). Faithful
/// port of index.ts's `RELATIVE_MOUSE_GATE`/`requiresRelativeMouse`.
fn requires_relative_mouse(name: &str, args: &serde_json::Map<String, Value>) -> bool {
    name == "pikvm_mouse_move" && args.get("relative").and_then(Value::as_bool) == Some(true)
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

        // Faithful port of http-server.ts's per-session auth seed: a
        // validated header at connect authorizes the session for its
        // whole lifetime; only when `allow_tool_login` is configured does
        // a header-less `initialize` open a PRE-AUTH session instead of
        // being rejected outright (the axum middleware in front of rmcp
        // already refused every other header-less/wrong-header request
        // before this ever runs — see http_server.rs). stdio has no HTTP
        // context to read a header from (`extensions.get::<Parts>()` is
        // `None`), so it always resolves `authenticated = true` — the
        // gate stays inert there, matching its pre-existing behavior.
        if self.auth.allow_tool_login {
            if let Some(authorize) = &self.auth.authorize {
                let authenticated = authenticated_from_extensions(&context.extensions);
                let session =
                    pikvm_mcp_foundation::session_auth::SessionAuthState::new(authenticated);
                let gate =
                    pikvm_mcp_foundation::session_auth::make_login_gate(authorize.clone(), session);
                *self.session_gate.lock().unwrap() = Some(Arc::new(gate));
            }
        }

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
        if let Some(gate) = self.gate() {
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
        if let Some(gate) = self.gate() {
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

        // (#51) HID-mode mover gate: pointer-driving tools need the mode
        // KNOWN and the HID settled before they move. Faithful port of
        // index.ts's `MODE_SENSITIVE_TOOLS`/`refreshHidMode()` gate.
        if MODE_SENSITIVE_TOOLS.contains(&name.as_str()) {
            let mut resolver = self.shared.hid_mode_resolver.lock().await;
            resolver.resolve().await;
            let gate = resolver.mover_gate();
            if !gate.allowed {
                let reason = gate.reason.unwrap_or_default();
                return Ok(to_call_tool_result(ToolOutcome::error_text(format!(
                    "Error: {reason}"
                )))
                .into());
            }
        }

        // ADR-0002 Phase 1: read policy() once instead of a module global.
        // Non-null for MODE_SENSITIVE_TOOLS (the gate above just confirmed
        // it); for the handful of non-mover calibration CRUD tools outside
        // that set it falls back to `false` — same safe default index.ts
        // itself starts from.
        let current_mouse_absolute = self
            .shared
            .hid_mode_resolver
            .lock()
            .await
            .policy()
            .map(|p| p.mouse_absolute)
            .unwrap_or(false);

        if !current_mouse_absolute && requires_absolute_mouse(&name, &args) {
            return Ok(to_call_tool_result(ToolOutcome::error_text(format!(
                "Error: tool '{name}' requires absolute-mode mouse. {ABSOLUTE_MOUSE_NOTE}"
            )))
            .into());
        }
        // Mirror of the above (#3): a FORCED relative emit into an
        // absolute/desktop gadget is a documented silent no-op (ADR 0002)
        // — refuse rather than report a false success.
        if current_mouse_absolute && requires_relative_mouse(&name, &args) {
            return Ok(to_call_tool_result(ToolOutcome::error_text(format!(
                "Error: tool '{name}' requires relative-mode mouse. {RELATIVE_MOUSE_NOTE}"
            )))
            .into());
        }

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

    // -- authenticated_from_extensions --

    fn parts_with_header_authed(header_authed: Option<bool>) -> axum::http::request::Parts {
        let mut parts = axum::http::Request::new(()).into_parts().0;
        if let Some(v) = header_authed {
            parts.extensions.insert(HeaderAuthed(v));
        }
        parts
    }

    #[test]
    fn authenticated_from_extensions_defaults_true_for_stdio_with_no_http_context() {
        // stdio never goes through http_server.rs's middleware, so no
        // `Parts` is ever inserted into the rmcp `Extensions` at all.
        let extensions = rmcp::model::Extensions::new();
        assert!(authenticated_from_extensions(&extensions));
    }

    #[test]
    fn authenticated_from_extensions_defaults_true_when_no_header_authed_marker_was_inserted() {
        // Matches the valid-header-at-connect path: `require_auth` lets the
        // request through via `next.run` WITHOUT ever inserting
        // `HeaderAuthed` (only the pre-auth admission path does), so a
        // `Parts` with no marker at all must still resolve to trusted.
        let mut extensions = rmcp::model::Extensions::new();
        extensions.insert(parts_with_header_authed(None));
        assert!(authenticated_from_extensions(&extensions));
    }

    #[test]
    fn authenticated_from_extensions_reads_an_explicit_false_marker() {
        let mut extensions = rmcp::model::Extensions::new();
        extensions.insert(parts_with_header_authed(Some(false)));
        assert!(!authenticated_from_extensions(&extensions));
    }

    #[test]
    fn authenticated_from_extensions_reads_an_explicit_true_marker() {
        let mut extensions = rmcp::model::Extensions::new();
        extensions.insert(parts_with_header_authed(Some(true)));
        assert!(authenticated_from_extensions(&extensions));
    }
}
