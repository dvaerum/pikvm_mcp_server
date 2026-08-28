//! `CursorLocator` — one front door for "where is the cursor?".
//!
//! Faithful port of `src/pikvm/cursor-locator.ts`. Each named profile
//! reproduces the target call site's detector cascade call-for-call, same
//! order, same thresholds:
//!   - `Origin` — move-to.ts's `discoverOrigin`.
//!   - `OpenLoopShape` — move-to.ts's `tryOpenLoopShapeDetect`.
//!   - `Curve` — curve-mover.ts's `detect`.
//!
//! Design decisions (already settled with the repo owner — see the TS
//! source's doc comment and docs/adr/0003-cursor-locator-is-the-front-door.md):
//!  - A: the locator OWNS the `CursorBelief` instance.
//!  - B: named profiles, NOT one merged cascade.
//!  - C: `CursorFix` carries provenance + HONEST confidence — never a
//!    normalised or fabricated score.
//!
//! Every detector / device / verify function each profile calls is INJECTED
//! via `CursorLocatorDeps` (closures, matching this port's established DI
//! convention — module 1's `HeaderAuthorizer`, module 5's
//! `HidRecoveryClient`, `SeedTemplateClient`, `CaptureClient`) so unit tests
//! can substitute stubs and assert exact call order, and so this crate
//! doesn't need a `PiKVMClient`/kvmd-client dependency to compile or test.
//!
//! Split into one file per logical responsibility (idiomatic Rust 2018+
//! module layout) rather than kept as one ~1,050-line file mirroring the
//! single TS source file — `types` holds the shared data shapes + DI
//! closure contracts, `locator` holds `CursorLocator`'s own state machine.
//! Public API unchanged: every item below is re-exported from this root
//! exactly as it was when the whole module lived in one file.

mod locator;
mod types;

pub use locator::CursorLocator;
pub use types::{
    BoxFuture, CursorFix, CursorFixSource, CursorLocatorDeps, LocateProfile, MlMultiHintOptions,
    ProbeMeasurement, V8Detection, V8FullFrameOptions,
};

#[cfg(test)]
mod tests;
