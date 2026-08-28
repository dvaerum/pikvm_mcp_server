//! PiKVM API Client — REST control of HID + screenshot capture. Faithful
//! port of `src/pikvm/client.ts`.
//!
//! All mouse operations use the REST API (more reliable than WebSocket);
//! the client also holds a `streamer_keepalive::StreamerKeepalive` WS
//! connection purely to stop kvmd's ustreamer idle-stopping between calls.
//!
//! Split into one file per logical responsibility (idiomatic Rust 2018+
//! module layout) rather than kept as one ~2000-line file mirroring the
//! single TS source file — `core` holds the struct + construction + the
//! request/retry plumbing every other file's `impl PiKVMClient` block
//! calls through; `screenshot`/`calibration`/`keyboard`/`mouse`/`hid`
//! each hold one coherent slice of the public API as their own
//! `impl PiKVMClient` block. `PiKVMClient`'s fields are `pub(super)`
//! (visible to this whole `client` module tree) so those sibling `impl`
//! blocks can reach them directly — the same access a single big `impl`
//! would have, just organized by responsibility instead of file-per-TS-file.

mod calibration;
mod core;
mod error;
mod hid;
mod keyboard;
mod mouse;
mod request;
mod screenshot;
mod types;
mod wheel;

pub use core::{create_default_belief, PiKVMClient};
pub use error::{ClientError, PiKVMApiError};
pub use request::{HttpMethod, RequestArgs, RequestBody, RequestFn, ResponseBody};
pub use types::{
    CalibrationResult, CalibrationState, HidProfile, KeyOptions, MouseButton, PiKVMConfig,
    ResetHidOptions, ScreenResolution, ScreenshotOptions, ScreenshotResult, TypeOptions,
};
pub use wheel::{chunk_wheel_deltas, WheelDelta, WHEEL_STEP_MAX};
