//! Per-crop byte-exact change-detection cache for the cascade pre-filter
//! (docs/cascade-change-detection-prefilter-design.md, task_3a0440a91a05).
//!
//! Deliberately byte-exact, not threshold-based — see the design doc's
//! own false-negative analysis (a coarse global threshold already caused
//! a real false-negative elsewhere this session, task_07bfe499e2d9, on a
//! thin one-line text-selection highlight). Replays the LAST REAL AI
//! VERDICT for an unchanged crop (never assumes "absent"), so a
//! stationary cursor is never silently lost — correct by construction,
//! not by assumption, as long as the cache itself stays valid.
//!
//! v1 scope (see the design doc's own "v1 scope" section, added after
//! review): emit-based invalidation covers relative-mode HID emits only
//! (`emit_clock::record_emit()` isn't wired into the absolute-mode
//! `client.mouse_move()` endpoint yet — a tracked follow-up, not done
//! here) and region-change invalidation is NOT implemented
//! (`REGION_CACHE` in `cursor_ml_detect.rs` has no live refresh signal to
//! compare against today). Cold-start-per-process plus emit-based
//! invalidation are the safety net for v1.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::cursor_ml_detect::CascadeResult;

/// A crop's grid position (native-px center), the same `(x, y)` shape
/// `build_cascade_grid` already produces.
pub(crate) type CropCenter = (i64, i64);
/// A crop's real AI verdict, paired with which crop it belongs to.
pub(crate) type CropVerdict = (CropCenter, CascadeResult);

/// One crop's cached state: the exact bytes last seen there, and the
/// real AI verdict computed from those bytes.
struct CropCacheEntry {
    frame_bytes: Vec<u8>,
    verdict: CascadeResult,
}

struct CropCacheState {
    entries: HashMap<CropCenter, CropCacheEntry>,
    /// Frame dimensions the cache was built against — a resolution
    /// change invalidates wholesale (mirrors the `calibration_invalidated`
    /// pattern `client.mouse_move` already returns for the same reason).
    frame_w: u32,
    frame_h: u32,
    /// `emit_clock::last_emit_ms()` reading as of the last time this
    /// cache was validated. A different reading on a later scan means a
    /// real relative-mode mouse emit happened since — the ENTIRE cache
    /// is invalidated, not per-crop reasoning about which crops an emit
    /// could have touched (conservative and simple, per the design doc —
    /// avoids a whole class of "did I correctly compute the affected
    /// region" bugs).
    last_seen_emit_ms: Option<u64>,
}

static CROP_CACHE: Mutex<Option<CropCacheState>> = Mutex::new(None);

/// Test-only: force a clean cache state so tests don't depend on
/// execution order or a prior test's leftover cache. Mirrors
/// `emit_clock::reset_for_test()`'s own convention.
#[cfg(test)]
pub(crate) fn reset_for_test() {
    *CROP_CACHE.lock().unwrap() = None;
}

/// Extract one crop's raw (non-normalized) RGB bytes: the pre-filter's own
/// byte-exact comparison unit, AND (since the offload-inference refactor,
/// docs/cursor-offload-inference-design.md, task_d06561d91f58) the same
/// `RawCrop` bytes `run_cascade_inference_all` extracts before normalizing
/// into the model's f32 input tensor -- one extraction routine, not two
/// independently-maintained clamp formulas that could silently diverge.
/// `pub(crate)` so `cursor_ml_detect.rs` can call it directly.
pub(crate) fn extract_crop_bytes(
    full: &[u8],
    fw: u32,
    fh: u32,
    crop: i64,
    cx: i64,
    cy: i64,
) -> Vec<u8> {
    let half = crop / 2;
    let left = 0i64.max((fw as i64 - crop).min(cx - half));
    let top = 0i64.max((fh as i64 - crop).min(cy - half));
    let mut out = Vec::with_capacity((crop * crop * 3) as usize);
    for yy in 0..crop {
        for xx in 0..crop {
            let si = (((top + yy) as usize) * (fw as usize) + ((left + xx) as usize)) * 3;
            out.extend_from_slice(&full[si..si + 3]);
        }
    }
    out
}

/// Split a crop grid into (changed, unchanged) against the current
/// cache, given the current frame's bytes/dimensions. `unchanged` carries
/// the REPLAYED verdict directly (no AI needed); `changed` carries only
/// the centers still needing a real AI call.
///
/// Performs wholesale invalidation (a relative-mode emit since the cache
/// was last validated, or a resolution change) BEFORE splitting — an
/// invalidated or absent cache means every crop counts as `changed`,
/// identical to today's un-prefiltered behavior. This is the design's own
/// "cold start = zero regression risk" guarantee, made real: the
/// pre-filter can only ever reduce work relative to a validated cache
/// window, never change what a cold/invalidated scan finds.
pub(crate) fn split_by_cache(
    full: &[u8],
    fw: u32,
    fh: u32,
    crop: i64,
    centers: &[(i64, i64)],
) -> (Vec<CropCenter>, Vec<CropVerdict>) {
    let current_emit_ms = pikvm_mcp_kvmd_client::emit_clock::last_emit_ms();
    let mut guard = CROP_CACHE.lock().unwrap();

    let invalidate = match guard.as_ref() {
        None => false, // nothing to invalidate; already absent
        Some(state) => {
            state.frame_w != fw || state.frame_h != fh || state.last_seen_emit_ms != current_emit_ms
        }
    };
    if invalidate {
        *guard = None;
    }
    if guard.is_none() {
        *guard = Some(CropCacheState {
            entries: HashMap::new(),
            frame_w: fw,
            frame_h: fh,
            last_seen_emit_ms: current_emit_ms,
        });
    }
    let state = guard.as_ref().expect("just ensured Some above");

    let mut changed = Vec::new();
    let mut unchanged = Vec::new();
    for &center in centers {
        let bytes = extract_crop_bytes(full, fw, fh, crop, center.0, center.1);
        match state.entries.get(&center) {
            Some(entry) if entry.frame_bytes == bytes => {
                unchanged.push((center, entry.verdict));
            }
            _ => changed.push(center),
        }
    }
    (changed, unchanged)
}

/// Record fresh AI verdicts for the crops that were just (re-)computed —
/// called after a real `run_cascade_inference_all` call on the `changed`
/// set `split_by_cache` returned. `unchanged` crops are left as-is; their
/// existing cache entry is already correct — that's what made them
/// `unchanged` in the first place.
pub(crate) fn update_cache(
    full: &[u8],
    fw: u32,
    fh: u32,
    crop: i64,
    changed_results: &[CropVerdict],
) {
    let mut guard = CROP_CACHE.lock().unwrap();
    // split_by_cache always leaves a Some(..) state behind (either kept
    // or freshly rebuilt) before returning, so guard should never be None
    // here in real use via run_cascade — a defensive no-op costs nothing
    // and avoids a panic if this is ever called out of that sequence.
    let Some(state) = guard.as_mut() else {
        return;
    };
    for &(center, verdict) in changed_results {
        let bytes = extract_crop_bytes(full, fw, fh, crop, center.0, center.1);
        state.entries.insert(
            center,
            CropCacheEntry {
                frame_bytes: bytes,
                verdict,
            },
        );
    }
}

#[cfg(test)]
mod tests;
