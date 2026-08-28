//! Module 4 (mover/HID orchestration) of the pikvm-mcp-server Rust port.
//!
//! Faithful port of `src/pikvm/{move-to,curve-mover,click-at,click-verify,
//! ballistics,auto-calibrate,scale-learner,scale-persist,pointer-accel,
//! open-loop-planner,cursor-keepalive,slam}.ts`. See
//! `docs/rust-port-plan.md` §7 and `docs/adr/0002-rust-port-full-bigbang.md`
//! — this crate is task_9bb80e84c948, depends on modules 1
//! (`pikvm-mcp-foundation`), 2 (`pikvm-mcp-kvmd-client`, which itself pulls
//! in `pikvm-mcp-cursor-belief`).
//!
//! **The mover algorithm is SOLVED — this is a faithful port, not a
//! redesign.** `curve-mover.ts` + `strategy:'curve-one-shot'` is the iPad
//! default; do not change its behavior while porting.

pub mod auto_calibrate;
pub mod ballistics;
pub mod cursor_anchor;
pub mod cursor_keepalive;
pub mod curve_mover;
pub mod gesture;
pub mod ipad_unlock;
pub mod scale_learner;
pub mod scale_persist;
pub mod slam;

/// One process-wide lock for every test in this crate that touches shared
/// global mutable state living OUTSIDE this crate:
/// `pikvm_mcp_kvmd_client::emit_clock`'s last-emit timestamp (read/written
/// by `mouse_move_relative`, `cursor_keepalive`'s staleness check) and
/// `pikvm_mcp_detection_vision::orientation`'s `LAST_GOOD_BOUNDS` cache
/// (read/written by any bounds detection).
///
/// Found 2026-08-28 while adding `cursor_anchor.rs`'s tests: `slam.rs` and
/// `cursor_keepalive.rs` each already had their OWN private per-file
/// `TEST_LOCK`, and a naive third one for `cursor_anchor.rs` would have
/// made the same mistake — `cargo test` runs every test function in this
/// crate's single test binary concurrently by default, and three separate
/// mutex instances don't serialize against each other just because each
/// file's tests all lock their own. Adding `cursor_anchor.rs`'s tests
/// (a heavy new consumer of the same globals) surfaced real, previously-
/// latent cross-file flakiness in `cursor_keepalive.rs`'s and `slam.rs`'s
/// own test suites when run together — this shared lock is the actual fix,
/// not a cursor_anchor.rs-local workaround.
#[cfg(test)]
pub(crate) mod test_support {
    pub(crate) static GLOBAL_STATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
}
