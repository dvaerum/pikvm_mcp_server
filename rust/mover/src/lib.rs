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

pub mod cursor_keepalive;
pub mod curve_mover;
pub mod scale_learner;
pub mod scale_persist;
pub mod slam;
