//! iPad-specific unlock/navigation gestures: lock-screen unlock (swipe or
//! keyboard passcode), app launch, home-screen return, and App Switcher.
//!
//! Faithful port of `src/pikvm/ipad-unlock.ts`.
//!
//! Crate placement: `rust/mover`, NOT `rust/ipad-hid` despite this TS file
//! sitting in module 5's original file list. The real import graph shows
//! its only real imports are `client.ts`, `cursor-anchor.ts`,
//! `orientation.ts`, `gesture.ts`, `ipad-keys.ts`, and `util.ts` — nothing
//! ipad-hid-exclusive (no hid-recovery.ts/hid-mode.ts/hid-diagnosis.ts
//! reference at all). `cursor-anchor.ts` is itself a `rust/mover` file per
//! its own crate-placement finding (docs/rust-port-plan.md v10), and
//! `rust/ipad-hid` has no dependency on `rust/mover` today — putting this
//! file in ipad-hid would create that new edge for no reason. Same
//! discipline as the cursor-anchor.ts and gesture.ts (emit_chunked)
//! findings: verify the real dependency graph, don't trust the original
//! task-list grouping.
//!
//! Split into one file per exported function (idiomatic Rust 2018+ module
//! layout, matching the TS source's own one-test-file-per-function
//! structure) rather than kept as one ~620-line file:
//! - `unlock` — `unlock_ipad`, the swipe-based lock-screen unlock.
//! - `launch_app` — `launch_ipad_app`, unlock → Spotlight → type → launch.
//! - `home` — `ipad_go_home`, Cmd+H (+ optional forced swipe-home).
//! - `app_switcher` — `ipad_open_app_switcher`, Cmd+Tab capture.
//! - `unlock_with_code` — `unlock_ipad_with_code`, keyboard-only passcode
//!   entry (the one function here with no anchor/orientation dependency).

mod app_switcher;
mod home;
mod launch_app;
mod unlock;
mod unlock_with_code;

pub use app_switcher::{ipad_open_app_switcher, IpadAppSwitcherOptions, IpadAppSwitcherResult};
pub use home::{ipad_go_home, IpadHomeOptions, IpadHomeResult};
pub use launch_app::{launch_ipad_app, IpadLaunchAppOptions, IpadLaunchAppResult};
pub use unlock::{unlock_ipad, IpadUnlockOptions, IpadUnlockResult};
pub use unlock_with_code::{unlock_ipad_with_code, UnlockWithCodeOptions, UnlockWithCodeResult};

#[cfg(test)]
mod tests;
