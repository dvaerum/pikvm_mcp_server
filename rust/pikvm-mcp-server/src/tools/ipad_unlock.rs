//! Faithful port of `index.ts`'s `handle_pikvm_ipad_unlock`/
//! `handle_pikvm_ipad_unlock_with_code`/`handle_pikvm_ipad_lock`/
//! `handle_pikvm_dismiss_popup`/`handle_pikvm_ipad_home`/
//! `handle_pikvm_ipad_app_switcher`/`handle_pikvm_ipad_launch_app`.
//!
//! Named after this crate's TOOL-layer grouping (matches TS's own
//! `handle_pikvm_ipad_*` naming), not to be confused with `rust/mover`'s
//! `ipad_unlock` module these handlers all call into.

use std::sync::Arc;

use pikvm_mcp_ipad_primitives::click_verify::{
    format_dismiss_result, run_dismiss_recipe, DismissResult, SendKeyFn, SendShortcutFn,
};
use pikvm_mcp_mover::ipad_unlock::{
    ipad_go_home, ipad_open_app_switcher, launch_ipad_app, unlock_ipad, unlock_ipad_with_code,
    IpadAppSwitcherOptions, IpadHomeOptions, IpadLaunchAppOptions, IpadUnlockOptions,
    UnlockWithCodeOptions,
};

use crate::server::SharedState;
use crate::tool_helpers::{require_string, validate_boolean, validate_number};
use crate::tools::{b64, BoxFuture, ToolEntry, ToolOutcome};

pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "pikvm_ipad_unlock",
            description: "Unlock the iPad lock screen: key-press-first (Esc/Enter/Space), then a slam+swipe \
                           fallback."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "tryKeyPressFirst": {"type": "boolean"},
                    "swipeOnKeyPressFailure": {"type": "boolean"},
                    "slamFirst": {"type": "boolean"},
                    "startX": {"type": "number"},
                    "startY": {"type": "number"},
                    "dragPx": {"type": "number"},
                    "chunkMickeys": {"type": "number"}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(ipad_unlock(shared, args))),
        },
        ToolEntry {
            name: "pikvm_ipad_unlock_with_code",
            description: "Passcode-only unlock via keyboard: Space, Space, digits, Enter.".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "4-10 decimal digits. Not logged or echoed."},
                    "useStoredCode": {"type": "boolean", "description": "Fall back to PIKVM_IPAD_PASSCODE if code is omitted (explicit opt-in)."}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(ipad_unlock_with_code(shared, args))),
        },
        ToolEntry {
            name: "pikvm_ipad_lock",
            description: "Send Ctrl+Cmd+Q (iPadOS Lock Screen shortcut).".to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            handler: Arc::new(|shared, _args| Box::pin(ipad_lock(shared))),
        },
        ToolEntry {
            name: "pikvm_dismiss_popup",
            description: "Best-effort hidden-popup dismiss recipe: Escape, Enter, optionally Cmd+H.".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "force": {"type": "boolean", "description": "Also try Cmd+H."}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(dismiss_popup(shared, args))),
        },
        ToolEntry {
            name: "pikvm_ipad_home",
            description: "Cmd+H to return to the home screen, optionally forcing a swipe-based App Switcher \
                           dismiss too."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "settleMs": {"type": "number"},
                    "forceHomeViaSwipe": {"type": "boolean"},
                    "swipeDragPx": {"type": "number"}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(ipad_home(shared, args))),
        },
        ToolEntry {
            name: "pikvm_ipad_app_switcher",
            description: "Cmd+Tab to open the App Switcher, screenshot while held.".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "holdMs": {"type": "number"}
                }
            }),
            handler: Arc::new(|shared, args| Box::pin(ipad_app_switcher(shared, args))),
        },
        ToolEntry {
            name: "pikvm_ipad_launch_app",
            description: "Launch an app via the verified keyboard pipeline: unlock → Spotlight → type → Enter."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "appName": {"type": "string"},
                    "unlockFirst": {"type": "boolean"},
                    "spotlightSettleMs": {"type": "number"},
                    "postTypeSettleMs": {"type": "number"},
                    "launchSettleMs": {"type": "number"}
                },
                "required": ["appName"]
            }),
            handler: Arc::new(|shared, args| Box::pin(ipad_launch_app(shared, args))),
        },
    ]
}

fn ipad_unlock(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let options = IpadUnlockOptions {
            try_key_press_first: validate_boolean(&args, "tryKeyPressFirst"),
            swipe_on_key_press_failure: validate_boolean(&args, "swipeOnKeyPressFailure"),
            slam_first: Some(validate_boolean(&args, "slamFirst").unwrap_or(true)),
            start_x: validate_number(&args, "startX", Some(0.0), Some(4000.0)).map(|v| v as i64),
            start_y: validate_number(&args, "startY", Some(0.0), Some(4000.0)).map(|v| v as i64),
            drag_px: validate_number(&args, "dragPx", Some(100.0), Some(3000.0)).map(|v| v as i64),
            chunk_mickeys: validate_number(&args, "chunkMickeys", Some(1.0), Some(127.0)),
            ..Default::default()
        };
        let result = unlock_ipad(&shared.client, options).await?;
        Ok(ToolOutcome::text_and_image(
            result.message,
            b64(&result.screenshot),
            "image/jpeg",
        ))
    })
}

fn ipad_unlock_with_code(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let use_stored_code = validate_boolean(&args, "useStoredCode").unwrap_or(false);
        let code = if args.contains_key("code") {
            require_string(&args, "code").map_err(anyhow::Error::msg)?
        } else if use_stored_code {
            match std::env::var("PIKVM_IPAD_PASSCODE") {
                Ok(v) if !v.is_empty() => v,
                _ => {
                    return Ok(ToolOutcome::error_text(
                        "Error: useStoredCode=true but PIKVM_IPAD_PASSCODE is not set in the environment. Set it \
                         in .env (see .env.example) or pass code explicitly.",
                    ))
                }
            }
        } else {
            // Preserves the pre-2026-08-24 error exactly: require_string's
            // own "field is required" message.
            require_string(&args, "code").map_err(anyhow::Error::msg)?
        };
        let result =
            unlock_ipad_with_code(&shared.client, &code, UnlockWithCodeOptions::default()).await?;
        Ok(ToolOutcome::text(format!(
            "Unlock recipe fired (Space → wait → Space → wait → {} digits → Enter). Verify with \
             pikvm_screen_state (expect on:true) and pikvm_screenshot. If wrong-passcode, iPadOS will show the \
             shake animation and remain on the passcode prompt.",
            result.digits_sent
        )))
    })
}

fn ipad_lock(shared: Arc<SharedState>) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        shared
            .client
            .send_shortcut(&["ControlLeft", "MetaLeft", "KeyQ"])
            .await?;
        Ok(ToolOutcome::text(
            "Sent Ctrl+Cmd+Q (iPadOS Lock Screen). Screen should turn off within 2 s. Verify with \
             pikvm_screen_state (expect on:false). To unlock again: sendKey Enter (wakes the screen; on iPadOS \
             26 with no passcode also dismisses the lock screen).",
        ))
    })
}

fn dismiss_popup(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let force = validate_boolean(&args, "force").unwrap_or(false);
        let client = shared.client.clone();

        let key_client = client.clone();
        let send_key_fn = move |key: &str| {
            let client = key_client.clone();
            let key = key.to_string();
            Box::pin(async move {
                client
                    .send_key(&key, None)
                    .await
                    .map_err(anyhow::Error::from)
            }) as crate::tools::BoxFuture<'static, anyhow::Result<()>>
        };
        let send_key: SendKeyFn = &send_key_fn;

        let shortcut_client = client.clone();
        let send_shortcut_fn = move |keys: &[&str]| {
            let client = shortcut_client.clone();
            let keys: Vec<String> = keys.iter().map(|s| s.to_string()).collect();
            Box::pin(async move {
                let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
                client
                    .send_shortcut(&refs)
                    .await
                    .map_err(anyhow::Error::from)
            }) as crate::tools::BoxFuture<'static, anyhow::Result<()>>
        };
        let send_shortcut: SendShortcutFn = &send_shortcut_fn;

        let result: DismissResult = run_dismiss_recipe(send_key, Some(send_shortcut), force).await;
        Ok(ToolOutcome::text(format_dismiss_result(&result)))
    })
}

fn ipad_home(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let options = IpadHomeOptions {
            settle_ms: validate_number(&args, "settleMs", Some(0.0), Some(5000.0))
                .map(|v| v as u64),
            force_home_via_swipe: validate_boolean(&args, "forceHomeViaSwipe").unwrap_or(false),
            swipe_drag_px: validate_number(&args, "swipeDragPx", Some(100.0), Some(3000.0))
                .map(|v| v as i64),
            verbose: false,
        };
        let result = ipad_go_home(&shared.client, options).await?;
        Ok(ToolOutcome::text_and_image(
            result.message,
            b64(&result.screenshot),
            "image/jpeg",
        ))
    })
}

fn ipad_app_switcher(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let options = IpadAppSwitcherOptions {
            hold_ms: validate_number(&args, "holdMs", Some(100.0), Some(5000.0)).map(|v| v as u64),
            verbose: false,
        };
        let result = ipad_open_app_switcher(&shared.client, options).await?;
        Ok(ToolOutcome::text_and_image(
            result.message,
            b64(&result.screenshot),
            "image/jpeg",
        ))
    })
}

fn ipad_launch_app(
    shared: Arc<SharedState>,
    args: serde_json::Map<String, serde_json::Value>,
) -> BoxFuture<'static, anyhow::Result<ToolOutcome>> {
    Box::pin(async move {
        let app_name = require_string(&args, "appName").map_err(anyhow::Error::msg)?;
        let options = IpadLaunchAppOptions {
            unlock_first: Some(validate_boolean(&args, "unlockFirst").unwrap_or(true)),
            spotlight_settle_ms: validate_number(
                &args,
                "spotlightSettleMs",
                Some(0.0),
                Some(5000.0),
            )
            .map(|v| v as u64),
            post_type_settle_ms: validate_number(
                &args,
                "postTypeSettleMs",
                Some(0.0),
                Some(5000.0),
            )
            .map(|v| v as u64),
            launch_settle_ms: validate_number(&args, "launchSettleMs", Some(0.0), Some(10000.0))
                .map(|v| v as u64),
            verbose: false,
        };
        let result = launch_ipad_app(&shared.client, &app_name, options).await?;
        Ok(ToolOutcome::text_and_image(
            result.message,
            b64(&result.screenshot),
            "image/jpeg",
        ))
    })
}
