//! Keymap listing, HID gadget reset/recovery, HID capability profile,
//! and auth check.

use std::time::Duration;

use super::core::PiKVMClient;
use super::error::ClientError;
use super::request::{HttpMethod, RequestArgs};
use super::types::{HidProfile, ResetHidOptions};

impl PiKVMClient {
    pub async fn get_keymaps(&self) -> Result<Vec<String>, ClientError> {
        let response = self.request_json_get("/hid/keymaps").await?;
        let keymaps = response
            .get("result")
            .and_then(|r| r.get("keymaps"))
            .and_then(|k| k.as_object())
            .ok_or_else(|| {
                ClientError::Other("Invalid or missing keymaps data from PiKVM API".into())
            })?;
        Ok(keymaps.keys().cloned().collect())
    }

    /// Reset the PiKVM USB HID gadget. Recovery primitive for when
    /// mouse/keyboard report `online: false`. With `opts: None`, this
    /// preserves the original void behaviour (fire the soft reset and
    /// return `Ok(None)`) — Rust has no TS-style overload, so `Some`/
    /// `None` on `opts` plays the role of the two TS overloads, and
    /// `Ok(Some(profile))` only when `opts` was given.
    pub async fn reset_hid(
        &self,
        opts: Option<ResetHidOptions>,
    ) -> Result<Option<HidProfile>, ClientError> {
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: "/hid/reset".to_string(),
            body: None,
        })
        .await?;
        let Some(opts) = opts else { return Ok(None) };
        if opts.reconnect_usb {
            self.request(RequestArgs {
                method: HttpMethod::Post,
                path: "/hid/set_connected?connected=0".to_string(),
                body: None,
            })
            .await?;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            self.request(RequestArgs {
                method: HttpMethod::Post,
                path: "/hid/set_connected?connected=1".to_string(),
                body: None,
            })
            .await?;
        }
        tokio::time::sleep(Duration::from_millis(opts.settle_ms.unwrap_or(2000))).await;
        Ok(Some(self.get_hid_profile().await?))
    }

    /// Read HID configuration flags. Used to decide whether absolute-mode
    /// mouse tools are usable on the current target. iPad and other
    /// relative-only HID hosts report `mouse_absolute: false`.
    pub async fn get_hid_profile(&self) -> Result<HidProfile, ClientError> {
        let response = self.request_json_get("/hid").await?;
        let r = response.get("result");
        let get_bool = |path: &[&str], default: bool| -> bool {
            let mut cur = r;
            for key in path {
                cur = cur.and_then(|v| v.get(key));
            }
            cur.and_then(|v| v.as_bool()).unwrap_or(default)
        };
        Ok(HidProfile {
            online: get_bool(&["online"], false),
            mouse_absolute: get_bool(&["mouse", "absolute"], true),
            mouse_online: get_bool(&["mouse", "online"], false),
            keyboard_online: get_bool(&["keyboard", "online"], false),
        })
    }

    pub async fn check_auth(&self) -> bool {
        self.request(RequestArgs {
            method: HttpMethod::Get,
            path: "/auth/check".to_string(),
            body: None,
        })
        .await
        .is_ok()
    }
}
