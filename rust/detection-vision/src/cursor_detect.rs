//! Cursor detection via screenshot diffing.
//!
//! Decodes two JPEG frames to raw RGB, diffs them, and returns connected-
//! component clusters of changed pixels. Nearby clusters (e.g. cursor body
//! and its drop shadow) are merged into one.
//!
//! Faithful port of `src/pikvm/cursor-detect.ts`. `takeRawScreenshot` and
//! `locateCursor` are NOT ported here — both take `PiKVMClient` directly
//! and must wait for module 2's `client.rs` to land. Everything else in
//! the source file is pure/IO-only (no client dependency) and is ported
//! below.
//!
//! Split into one file per logical responsibility (idiomatic Rust 2018+
//! module layout) rather than kept as one ~1,580-line file mirroring the
//! single TS source file — `diff` holds the screenshot decode/diff/cluster
//! geometry (plus the pure locate-cursor contract shapes `cursor_locator.rs`
//! depends on), `template` holds template capture/correlation/matching,
//! `persist` holds the disk save/load pair. Public API unchanged: every
//! item below is re-exported from this root exactly as it was when the
//! whole module lived in one file.

mod diff;
mod persist;
mod template;

pub use diff::{
    decode_screenshot, diff_pixels, diff_screenshots, diff_screenshots_decoded, find_clusters,
    merge_clusters, Cluster, DecodedScreenshot, DetectionConfig, LocateCursorOptions,
    LocateCursorResult, Point, DEFAULT_DETECTION_CONFIG,
};
pub use persist::{load_cursor_template, save_cursor_template};
pub use template::{
    compute_template_hotspot, cursor_moved_as_expected, extract_cursor_template,
    extract_cursor_template_decoded, find_cursor_by_template_decoded, find_cursor_by_template_set,
    CursorTemplate, FindCursorOptions, FindCursorResult, FindCursorSetResult,
};

#[cfg(test)]
mod tests;
