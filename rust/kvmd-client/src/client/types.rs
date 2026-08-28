//! Config + public value types for `PiKVMClient`'s API surface. Split out
//! of the former monolithic `client.rs` (Rust idiomatic module layout —
//! one logical responsibility per file, not "one file per TS file").

#[derive(Debug, Clone)]
pub struct PiKVMConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    /// Default `false` (matches the TS default) — PiKVM's self-signed cert
    /// is accepted unless the caller opts into strict verification.
    pub verify_ssl: bool,
    /// Default `"en-us"`.
    pub default_keymap: String,
    /// Optional HTTP CONNECT proxy for ALL outbound PiKVM requests
    /// (e.g. `http://127.0.0.1:8888`). See `streamer_keepalive.rs`'s
    /// header for why this exists (macOS Local Network privacy).
    /// `None` = direct connection.
    pub proxy_url: Option<String>,
}

impl PiKVMConfig {
    /// Convenience constructor mirroring TS call sites that only ever set
    /// host/username/password (everything else takes its documented
    /// default), matching `PiKVMConfig`'s TS-side optional fields.
    pub fn new(
        host: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        Self {
            host: host.into(),
            username: username.into(),
            password: password.into(),
            verify_ssl: false,
            default_keymap: "en-us".to_string(),
            proxy_url: None,
        }
    }
}

/// Live HID capability snapshot from `/api/hid`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HidProfile {
    pub online: bool,
    pub mouse_absolute: bool,
    pub mouse_online: bool,
    pub keyboard_online: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TypeOptions {
    pub keymap: Option<String>,
    pub slow: bool,
    pub delay: Option<u32>,
}

/// `state`: `Some(true)` = press, `Some(false)` = release, `None` = press+release.
#[derive(Debug, Clone, Copy, Default)]
pub struct KeyOptions {
    pub state: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenResolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
    Up,
    Down,
}

impl MouseButton {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            MouseButton::Left => "left",
            MouseButton::Right => "right",
            MouseButton::Middle => "middle",
            MouseButton::Up => "up",
            MouseButton::Down => "down",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScreenshotResult {
    pub buffer: Vec<u8>,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    pub actual_width: u32,
    pub actual_height: u32,
    pub scale_x: f64,
    pub scale_y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalibrationState {
    pub factor_x: f64,
    pub factor_y: f64,
    pub resolution: ScreenResolution,
}

#[derive(Debug, Clone)]
pub struct CalibrationResult {
    pub expected_position: (i64, i64),
    pub requested_normalized: (i32, i32),
    pub resolution: ScreenResolution,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct ScreenshotOptions {
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub quality: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct ResetHidOptions {
    pub reconnect_usb: bool,
    pub settle_ms: Option<u64>,
}
