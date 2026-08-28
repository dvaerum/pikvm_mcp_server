//! Slam's own small enums: per-axis direction, target corner, and which
//! of `PiKVMClient`'s two real screenshot behaviors a `verify_motion`
//! capture should use.

/// Slam's own per-axis type — structurally identical to
/// `scale_learner::Axis` but a SEPARATE type, matching the TS source
/// faithfully: `slam.ts` declares its own `Axis = 'x' | 'y'` rather than
/// importing scale-learner.ts's (the two files have no import
/// relationship in the original), so this port keeps them independent
/// too rather than silently merging two types the source deliberately
/// didn't share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Which of `PiKVMClient`'s two real screenshot behaviors to use for a
/// `verify_motion` before/after pair. Faithful-but-adapted port of the TS
/// `SlamOptions.screenshot` injected closure: ADR-0001 documents that
/// exactly two real behaviors exist (cursor-detect.ts's wake-nudging
/// capture vs ballistics.ts's/auto-calibrate.ts's non-nudging one — a
/// nudge right before a calibration capture would contaminate the very
/// displacement being measured) and must never be merged. TS injects a
/// closure because those two variants each had their own private
/// same-shape copy scattered across files to avoid an import cycle;
/// `PiKVMClient` already exposes both as public methods directly
/// (`screenshot`/`screenshot_keeping_cursor_alive`), so this enum picks
/// between them instead of re-injecting a closure — same two real
/// behaviors, no cross-file import-cycle risk in Rust's module system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenshotMode {
    /// cursor-detect.ts's wake-nudging variant (±1px nudge before
    /// capture, keeps the auto-fading iPad cursor visible).
    Nudging,
    /// ballistics.ts's/auto-calibrate.ts's non-nudging variant.
    Raw,
}
