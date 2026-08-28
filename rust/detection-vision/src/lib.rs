//! Module 3 (detection/vision) of the pikvm-mcp-server Rust port.
//!
//! Faithful port of `src/pikvm/{cursor-detect,cursor-ml-detect,
//! cursor-shape-detect,cursor-belief,cursor-locator,cursor-anchor,
//! orientation,ipad-region-detect,template-set,seed-template,brightness,
//! capture}.ts`. See `docs/rust-port-plan.md` and
//! `docs/adr/0002-rust-port-full-bigbang.md` — this crate is
//! task_72403c2d858c.
//!
//! Depends on module 1 (`pikvm-mcp-foundation`) only so far. The ONNX/
//! image-crate-heavy layer; model contracts and thresholds must port
//! byte-for-byte, not be "improved" along the way (per the plan's §3
//! magic-number examples and the ADR's own warning).

pub mod brightness;
pub mod ipad_region_detect;
