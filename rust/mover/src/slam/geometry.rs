//! Pure corner-geometry math: no I/O, no client — just the direction
//! vector for a corner and the two ways to compute its expected target
//! pixel (raw capture frame vs the iPad's own letterboxed bounds).

use pikvm_mcp_detection_vision::orientation::IpadBounds;
use pikvm_mcp_kvmd_client::client::ScreenResolution;

use super::types::Corner;

/// Exported for cursor-anchor.rs's own verification capture (same
/// reasoning as the TS original).
pub fn corner_vector(corner: Corner) -> (i32, i32) {
    match corner {
        Corner::TopLeft => (-1, -1),
        Corner::TopRight => (1, -1),
        Corner::BottomLeft => (-1, 1),
        Corner::BottomRight => (1, 1),
    }
}

/// Corner of the RAW HDMI capture frame. Fallback only — see
/// `corner_target_from_bounds`, which is correct for any letterboxed
/// iPad target and should be preferred whenever bounds are available.
pub fn corner_target_px(corner: Corner, resolution: ScreenResolution) -> (i64, i64) {
    match corner {
        Corner::TopLeft => (0, 0),
        Corner::TopRight => (resolution.width as i64, 0),
        Corner::BottomLeft => (0, resolution.height as i64),
        Corner::BottomRight => (resolution.width as i64, resolution.height as i64),
    }
}

/// 2026-08-24 P0 fix: `corner_target_px` alone computes the expected slam
/// landing point against the raw HDMI capture frame. For a letterboxed
/// iPad target, the relative-mouse cursor's actual top-left sits at the
/// iPad's OWN content rectangle corner (bounds.x, bounds.y) — typically
/// several hundred px away from (0,0) on a portrait letterbox. Prefer
/// this over `corner_target_px` whenever iPad bounds are available.
pub fn corner_target_from_bounds(corner: Corner, bounds: &IpadBounds) -> (i64, i64) {
    let (x, y, w, h) = (
        bounds.x as i64,
        bounds.y as i64,
        bounds.width as i64,
        bounds.height as i64,
    );
    match corner {
        Corner::TopLeft => (x, y),
        Corner::TopRight => (x + w, y),
        Corner::BottomLeft => (x, y + h),
        Corner::BottomRight => (x + w, y + h),
    }
}
